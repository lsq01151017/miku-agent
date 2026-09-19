"""
main.py — 入口：把所有模块组装成一个持续存在的角色
==================================================

数据流（Lv1 + Lv2 完整闭环）：

  用户输入
    │
    ├─ logger.turn()                     开一个 trace_id，本轮所有事件都归属它
    │
    ├─ router.decide()                   该只回答，还是该行动？（决策+理由写日志）
    │
    ├─ 记忆副作用（若有）                 显式"记住/忘记" → 真实写/删 SQLite
    │
    ├─ route == "local"  ──►  local_agent.respond()
    │                          Ollama deepseek-r1:14b 流式输出
    │
    └─ route == "api"    ──►  api_agent.run()          【真实行动】
                               deepseek-flash 决定调用工具
                                 → tools.dispatch() 真正执行
                                 → 真实结果回传模型
                                 → 得到事实说明
                               └─► local_agent.revoice()  【拟人化包装】
                                     把真实数据包上初音未来的语气
    │
    ├─ 情绪状态更新（用户输入 + 回复 + 行动成败）
    ├─ 记忆写入（规则提取 + 情绪加权）
    └─ 必要时压缩上下文 / 巩固记忆

命令行用法：
    python main.py                 进入交互对话
    python main.py --test          跑题目要求的 4 个验收用例并给出判定
    python main.py --once "你好"   只跑一轮
    python main.py --route "..."   只看路由决策，不调用任何模型
    python main.py --state         查看当前情绪与关系状态
    python main.py --memory        查看长期记忆
    python main.py --audit         回放最近一轮的完整审计链路
    python main.py --stats         统计（日志/记忆/路由）
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

# Windows 控制台默认是 GBK，中文与 ♪ 会乱码/报错；这里统一切到 UTF-8
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

from config import (  # noqa: E402
    AGENT_NAME,
    BASE_DIR,
    DB_PATH,
    LOG_FILE,
    PERSONA,
    SETTINGS,
    STATE_PATH,
)
from logger import EventLogger, TurnContext, get_logger  # noqa: E402
from memory import MemoryStore  # noqa: E402
from tools import build_default_registry  # noqa: E402
from router import (  # noqa: E402
    INTENT_MEMORY_FORGET,
    INTENT_MEMORY_RECALL,
    INTENT_MEMORY_WRITE,
    RouteDecision,
    Router,
)
from local_agent import AgentState, LocalAgent  # noqa: E402
from api_agent import (  # noqa: E402
    API_TOOL_INSTRUCTIONS,
    APIAgent,
    APIResponse,
    build_facts_system_prompt,
)

# --------------------------------------------------------------------------
# 终端样式
# --------------------------------------------------------------------------
C_DIM = "\033[2m"
C_RESET = "\033[0m"
C_MIKU = "\033[38;5;79m"      # 葱绿 #39C5BB 的近似色
C_ACT = "\033[38;5;222m"
C_WARN = "\033[38;5;209m"


def _supports_color() -> bool:
    return sys.stdout.isatty()


def paint(text: str, color: str) -> str:
    return f"{color}{text}{C_RESET}" if _supports_color() else text


@dataclass
class TurnResult:
    """一轮交互的完整结果（供 CLI 显示与 --test 判定）。"""

    user_text: str = ""
    route: str = ""
    intent: str = ""
    policy: str = ""
    reply: str = ""
    tools: List[Dict[str, Any]] = field(default_factory=list)
    memories_used: List[Dict[str, Any]] = field(default_factory=list)
    memories_written: List[Dict[str, Any]] = field(default_factory=list)
    mood_before: str = ""
    mood_after: str = ""
    trace_id: str = ""
    degraded: bool = False
    first_feedback_ms: float = 0.0
    total_ms: float = 0.0
    revoice_used: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "user": self.user_text, "route": self.route, "intent": self.intent,
            "policy": self.policy, "reply": self.reply,
            "tools": self.tools, "memories_used": self.memories_used,
            "memories_written": self.memories_written,
            "mood": f"{self.mood_before}->{self.mood_after}",
            "trace_id": self.trace_id, "degraded": self.degraded,
            "revoice_used": self.revoice_used,
            "first_feedback_ms": round(self.first_feedback_ms, 1),
            "total_ms": round(self.total_ms, 1),
        }


# ==========================================================================
# 编排器
# ==========================================================================
class Orchestrator:
    """把各模块组装起来，对外只暴露 handle(text)。"""

    def __init__(self, session_id: Optional[str] = None, verbose: bool = True,
                 db_path: Optional[Path] = None, state_path: Optional[Path] = None,
                 router_mode: Optional[str] = None):
        """db_path / state_path 可覆盖，用于让测试用独立的临时存储，
        绝不去污染你真实的记忆库与情绪状态。"""
        self.session_id = session_id or SETTINGS.session_id
        self.verbose = verbose
        self.log: EventLogger = get_logger()
        self.memory = MemoryStore(db_path or DB_PATH, session_id=self.session_id)
        self.state = AgentState(state_path or STATE_PATH)
        self.registry = build_default_registry()
        self.api = APIAgent(self.registry, self.log)
        # 路由：把"要不要行动"的判断能力注入策略链（见 AGENT_ROUTER_MODE）
        self.router = Router(mode=router_mode, intent_classifier=self.api.classify_intent)
        self.local = LocalAgent(self.memory, self.state, self.log, self.session_id)
        self._logged_startup = False

    # ---------------- 启动 ----------------
    def startup(self, turn: Optional[TurnContext] = None) -> Optional[str]:
        """会话开始：让时间流逝生效，并决定要不要主动开口。"""
        if not self._logged_startup:
            self.log.event(
                "agent.startup", session_id=self.session_id,
                config=SETTINGS.redacted(),
                local_model_ready=self.local.available,
                local_note=self.local.availability_note,
                api_ready=self.api.available,
                api_note=self.api.availability_note,
                memory=self.memory.stats(),
                tools=self.registry.names(),
            )
            if SETTINGS.memory_halflife_days and self.memory.stats()["total"]:
                self.memory.decay(trace_id=turn.trace_id if turn else "")
            # 预热本地模型：别让用户说的第一句话去承担冷启动的十几秒
            self.local.warmup(turn)
            self._logged_startup = True
        return self.local.maybe_proactive_greeting(turn)

    def health(self) -> str:
        lines = [
            f"  本地模型 (Lv1 人格对话): {paint('就绪', C_MIKU) if self.local.available else paint('不可用', C_WARN)}"
            f"  {self.local.availability_note}",
            f"  云端 API (Lv2 工具调用): {paint('就绪', C_MIKU) if self.api.available else paint('不可用', C_WARN)}"
            f"  {self.api.availability_note}",
            f"  长期记忆: {self.memory.stats()['total']} 条（{self.memory.db_path.name}）",
            f"  工具: {', '.join(self.registry.names())}",
            f"  审计日志: {LOG_FILE}",
        ]
        return "\n".join(lines)

    # ---------------- 一轮交互 ----------------
    def handle(self, user_text: str, *, stream: Optional[bool] = None,
               turn: Optional[TurnContext] = None) -> TurnResult:
        stream = SETTINGS.stream if stream is None else stream
        owns_turn = turn is None
        if owns_turn:
            turn = self.log.turn(self.session_id)

        import time
        t0 = time.perf_counter()
        result = TurnResult(user_text=user_text, trace_id=turn.trace_id,
                            mood_before=self.state.mood)
        first_feedback: List[float] = []

        def note_first(ms: float) -> None:
            # ms<=0 表示"就是此刻"：用于工具状态提示这种即时的用户可感知反馈（Lv4）
            if not first_feedback:
                first_feedback.append(ms if ms > 0 else (time.perf_counter() - t0) * 1000)

        turn.user_input(user_text)

        # ---- 1) 路由决策 ----
        decision = self.router.decide_and_log(user_text, turn)
        result.route, result.intent, result.policy = decision.route, decision.intent, decision.policy

        # ---- 2) 记忆（在生成之前完成：让"你刚告诉我名字"这一轮就能用上）----
        pre_extra = self._memory_pre_turn(user_text, decision, turn, result)

        # ---- 3) 分派 ----
        if decision.route == "api":
            self._handle_api(user_text, decision, turn, result, stream, note_first, pre_extra)
        else:
            self._handle_local(user_text, decision, turn, result, stream, note_first, pre_extra)

        # ---- 4) 收尾 ----
        result.mood_after = self.state.mood
        result.total_ms = (time.perf_counter() - t0) * 1000
        result.first_feedback_ms = first_feedback[0] if first_feedback else result.total_ms
        # 题目要求日志能回答"最终产生了什么语言或行为" —— 把她说的话本身记下来
        turn.speech(result.reply, route=result.route, intent=result.intent,
                    revoice=result.revoice_used, degraded=result.degraded,
                    tools=[t.get("tool") for t in result.tools])
        turn.log("turn.end", route=result.route, intent=result.intent,
                 mood=result.mood_after, total_ms=round(result.total_ms, 1),
                 first_feedback_ms=round(result.first_feedback_ms, 1),
                 tools_called=len(result.tools), degraded=result.degraded)
        return result

    # ---------------- 记忆：在生成回复之前完成 ----------------
    def _memory_pre_turn(self, user_text: str, decision: RouteDecision,
                         turn: TurnContext, result: TurnResult) -> str:
        """本轮的记忆处理，**全部发生在生成回复之前**。

        为什么必须在前面：
        用户说"你好啊，我叫呱太"时，如果记忆提取放在回复之后，那么这一轮
        她的上下文里还是旧名字，就会当面叫错人 —— 而"当场用上刚被告知的信息"
        恰恰是角色真实感最关键的地方。所以：
            先提取 → 再检索 → 再生成
        这样 `build_context` 读到的 `user_title` 已经是"呱太"。

        同时也负责"忘记"这类真实副作用。
        """
        notes: List[str] = []

        # ---- 1) 显式要求忘记（真实副作用）----
        if decision.intent == INTENT_MEMORY_FORGET:
            target = user_text
            for kw in ("忘记", "忘掉", "删掉关于", "不要再记得", "forget about",
                       "delete memory", "清空记忆"):
                target = target.replace(kw, " ")
            target = target.strip(" ，。,.！!？?、的这件事吧吧了呢")
            if any(k in user_text for k in ("清空记忆", "忘记所有", "全部忘记")):
                n = self.memory.forget_all(reason="用户要求清空记忆", trace_id=turn.trace_id)
                turn.log("memory.explicit_forget", scope="all", count=n)
                return f"（你已经真的清空了 {n} 条长期记忆。不要再提起那些事了。）"
            gone = self.memory.forget(query=target or user_text,
                                      reason="用户明确要求忘记", trace_id=turn.trace_id)
            result.memories_written = gone
            turn.log("memory.explicit_forget", scope="query", query=target, count=len(gone))
            if gone:
                items = "、".join(g.get("content", "") for g in gone)
                return (f"（关于「{items}」的记忆**已经被真的删掉了**，{len(gone)} 条。"
                        f"请自然地答应下来，不要再复述被删掉的内容。）")
            return "（用户要求你忘记某事，但记忆里没找到对应内容，可以如实说你想不起来这件事。）"

        # ---- 2) 从用户这句话里提取值得长期保留的信息（每轮都做）----
        # 只提取"会改变未来行为"的东西：身份、偏好、关系、承诺、明确要求记住的。
        # 天气/时间/计算这类一次性查询**不进**长期记忆 —— 它们只留在对话历史和审计日志里。
        stored = self.memory.extract_and_store(user_text, session_id=self.session_id,
                                              trace_id=turn.trace_id)
        if stored:
            result.memories_written = stored
            items = "、".join(str(w.get("content", "")) for w in stored)
            turn.log("memory.pre_turn_write", count=len(stored),
                     items=[{"op": w.get("op"), "content": w.get("content"),
                             "id": w.get("id"), "superseded_id": w.get("superseded_id")}
                            for w in stored])
            for w in stored:
                if w.get("op") == "supersede" and w.get("old_content"):
                    notes.append(
                        f"（制作人刚更正了信息：「{w['old_content']}」是旧的，"
                        f"现在正确的说法是「{w['content']}」。请**立刻改用新的**，"
                        f"并且不要显得是别人告诉你的。）")
                else:
                    notes.append(f"（制作人刚告诉你：「{w['content']}」，可以自然地用起来。）")

        # ---- 3) 首次见面：还不知道名字就先问，不要假设 ----
        if SETTINGS.ask_name_on_first_meet and not self.memory.has_name():
            turn.log("memory.name_unknown", note="记忆里还没有对方的名字，本轮应主动询问")
            notes.append(
                "（你还**不知道对方叫什么**。用你平时的称呼方式说话，"
                "并自然地问一次**对方的名字**——也就是「我该怎么称呼你」。"
                "不要猜、不要假设、也不要编一个名字。"
                "注意：是问对方的名字，不是问你自己该叫什么。）"
            )

        # ---- 4) 记忆意图的补充提示 ----
        if decision.intent == INTENT_MEMORY_WRITE:
            if not stored:
                notes.append("（用户要求你记住某件事，但提取不出具体内容，可以请他讲得更具体一点。）")
            else:
                notes.append("（这些已经真的写进你的长期记忆了，可以自然地确认一句，"
                             "不要提及数据库或系统。）")
        elif decision.intent == INTENT_MEMORY_RECALL:
            notes.append("（用户正在考你的记忆，把你想起来的内容自然说出来；"
                         "想不起来就坦白说想不起来，不要编。）")

        return "\n".join(notes)

    # ---------------- 本地路径 ----------------
    def _handle_local(self, user_text: str, decision: RouteDecision, turn: TurnContext,
                      result: TurnResult, stream: bool, note_first, pre_extra: str) -> None:
        final_text: List[str] = []

        def on_token(piece: str) -> None:
            final_text.append(piece)
            if stream:
                print(piece, end="", flush=True)

        resp = self.local.respond(
            user_text, turn=turn, on_token=on_token if stream else None,
            on_first_token=note_first, extra=pre_extra,
            extract=False,      # 本轮记忆已在 _memory_pre_turn 中提前处理
        )
        result.reply = resp.text
        result.degraded = resp.degraded
        result.memories_used = resp.memories

    # ---------------- API 路径（真实行动 + 拟人化包装）----------------
    def _handle_api(self, user_text: str, decision: RouteDecision, turn: TurnContext,
                    result: TurnResult, stream: bool, note_first, pre_extra: str) -> None:
        # 1) 用同一个上下文构建器（人设/关系/记忆）拿到背景
        messages, meta = self.local.build_context(user_text, extra=pre_extra, trace_id=turn.trace_id)

        if SETTINGS.revoice_with_local:
            # 事实模式：API 只负责"真的去查"和把事实说准
            system_prompt = build_facts_system_prompt(
                memory_block=self.memory.build_memory_block(meta["memory_hits"]),
                relation_block=self.state.relation_block(),
                extra=pre_extra,     # 工具准则已包含在 build_facts_system_prompt 内
            )
        else:
            # 人格模式：API 直接给最终回答
            system_prompt = messages[0]["content"]
        history = messages[1:-1]

        # 2) 真实行动循环
        printed_action = {"count": 0}

        def on_action(record) -> None:
            printed_action["count"] += 1
            result.tools.append(record.to_dict())
            if self.verbose:
                ok = "✓" if record.result.ok else "✗"
                print(paint(f"\n  ⚙ 未来正在查… {record.name}"
                            f"({json.dumps(record.args, ensure_ascii=False)}) {ok}"
                            f" [{record.result.source}] {record.result.duration_ms:.0f}ms", C_ACT),
                      flush=True)
            note_first(0.0)      # 工具状态本身也是"用户可感知的反馈"（Lv4）

        api_resp: APIResponse = self.api.run(
            user_text, system_prompt=system_prompt, history=history, turn=turn,
            on_token=None,
            on_first_token=lambda ms, kind="": note_first(ms),   # 回调带 (毫秒, 类型)
            on_action=on_action,
        )
        result.degraded = api_resp.degraded

        # 3) 把真实行动记成"经历"
        for record in api_resp.tool_calls:
            self.local.remember_action(record.name, record.args, record.result.to_dict(),
                                       ok=record.result.ok, trace_id=turn.trace_id)

        # 4) 拟人化包装：真实数据 → 初音未来的语气
        final = ""
        no_action = False
        if not api_resp.degraded and SETTINGS.revoice_with_local and self.local.available:
            facts = api_resp.facts_block()
            if facts:
                def on_token(piece: str) -> None:
                    if stream:
                        print(piece, end="", flush=True)

                rev = self.local.revoice(
                    facts, user_text, turn=turn,
                    on_token=on_token if stream else None,
                    on_first_token=note_first,
                    action_note=api_resp.action_note(),
                )
                if rev.text and not rev.degraded:
                    final = rev.text
                    result.revoice_used = True
                    api_resp.held_out_reply = api_resp.reply
                else:
                    turn.log("action.revoice_failed", level="warn",
                             error=rev.error or "revoice 返回空文本")
            else:
                # 模型判断这一轮**不需要行动**。它此时输出的是"内部事实口径"的文本
                # （facts 模式要求它不要卖萌、不要自称初音未来），
                # 所以不能直接展示给用户 —— 这一轮本质上是普通对话，
                # 应该交回人格模型来回答。见下面 elif no_action 分支。
                no_action = True
        if not final and not no_action:
            final = api_resp.reply

        # 5) 失败/无需行动时，回落到本地人格模型（而不是让用户看到内部口径的文本或 HTTP 错误）
        absorbed = False
        if api_resp.degraded and not final:
            turn.log("action.fallback_to_local", level="warn", error=api_resp.error)
            fallback = self.local.respond(
                user_text, turn=turn, on_token=None, extra=
                f"（你本来想帮对方查资料，但行动失败了：{api_resp.error}。"
                f"请用你的方式道歉并说明失败，不要编造查询结果。）",
                extract=False,
            )
            final = fallback.text
            result.degraded = True
            result.memories_used = fallback.memories
            # respond() 内部已经更新过情绪与记忆，不能再 absorb 一次（否则状态会被记两遍）
            absorbed = True
        elif no_action:
            turn.log("action.no_tool_needed",
                     note="模型判断本轮无需行动，交回本地人格模型回答",
                     discarded_internal_draft=api_resp.reply[:200])

            def on_token_plain(piece: str) -> None:
                if stream:
                    print(piece, end="", flush=True)

            plain = self.local.respond(
                user_text, turn=turn,
                on_token=on_token_plain if stream else None,
                on_first_token=note_first, extra=pre_extra,
                extract=False,
            )
            final = plain.text
            absorbed = True
            result.memories_used = plain.memories
            result.degraded = plain.degraded
        elif api_resp.degraded:
            turn.log("action.fallback_to_local", level="warn", error=api_resp.error)

        result.reply = final
        if not result.memories_used:
            result.memories_used = meta["memory_hits"]
        if not absorbed:
            result.memories_written = []

        # 6) 把这一轮并入情绪 / 记忆（与本地路径保持一致，且只做一次）
        if not absorbed:
            deltas, reasons = api_resp.action_emotion_deltas()
            self.local.absorb_turn(user_text, final, turn,
                                   action_deltas=deltas, action_reasons=reasons,
                                   extract=False)   # 记忆已在 _memory_pre_turn 处理

        if api_resp.claim_without_call:
            # 审计发现：模型声称做了但没真做 —— 已经在 api_agent 里记了 warn
            result.degraded = True

    # ---------------- 关闭 ----------------
    def shutdown(self) -> None:
        try:
            self.state.end_session()
            self.log.event("agent.shutdown", session_id=self.session_id,
                           total_turns=self.state.total_turns, mood=self.state.mood,
                           memory=self.memory.stats(), router=self.router.stats())
        finally:
            self.memory.close()


# ==========================================================================
# 验收测试（题目要求的 4 个用例）
# ==========================================================================
ACCEPTANCE_CASES = [
    {"text": "你好，你是谁？", "expect_route": "local", "expect_tool": None,
     "desc": "应该走本地模型，回复符合人格"},
    {"text": "西安今天天气怎么样？", "expect_route": "api", "expect_tool": "get_weather",
     "desc": "应该走 API，触发真实工具调用"},
    {"text": "现在几点了？", "expect_route": "api", "expect_tool": "get_current_time",
     "desc": "应该走 API，触发真实工具调用"},
    {"text": "你记得我叫什么吗？", "expect_route": "local", "expect_tool": None,
     "desc": "应该走本地模型，从记忆系统检索"},
]


def run_acceptance(stream: bool = True) -> int:
    """跑完 4 个验收用例，打印判定表。返回失败数。

    **重要**：测试使用临时目录里的独立 memory.db / state.json，
    绝不碰你真实的记忆库 —— 否则一次测试就会往你的角色里塞进一个假名字。
    """
    import shutil
    import tempfile

    tmpdir = Path(tempfile.mkdtemp(prefix="miku_accept_"))
    orch = Orchestrator(session_id="acceptance",
                        db_path=tmpdir / "memory.db",
                        state_path=tmpdir / "state.json")
    try:
        return _run_acceptance_inner(orch, stream)
    finally:
        orch.shutdown()
        shutil.rmtree(tmpdir, ignore_errors=True)


def _run_acceptance_inner(orch: Orchestrator, stream: bool = True) -> int:
    print(paint("\n" + "=" * 78, C_MIKU))
    print(paint(f"  {AGENT_NAME} · Lv1 + Lv2 验收测试", C_MIKU))
    print(paint("=" * 78, C_MIKU))
    print(f"  测试使用独立的临时记忆库（不会动到你真实的记忆）")
    print(orch.health())
    print()

    # 首次见面：她应该先问名字，而不是假设一个。
    print(paint("【准备 1】首次见面 —— 验证「她先问名字，而不是默认一个」", C_DIM))
    first = orch.handle("你好呀", stream=False)
    asked = any(k in first.reply for k in ("叫什么", "怎么称呼", "名字", "称呼你"))
    print(f"  她 > {first.reply}")
    print(f"  主动问名字: {paint('是', C_MIKU) if asked else paint('否', C_WARN)}")
    print(f"  记忆里已有名字: {orch.memory.has_name()}\n")

    # 然后告诉她名字，验证"这一轮当场就能用上"
    print(paint("【准备 2】告诉她名字 —— 验证同一轮内立刻生效 + 写入记忆", C_DIM))
    prep = orch.handle("我叫呱太", stream=False)
    wrote = [w.get("content") for w in prep.memories_written]
    print(f"  写入记忆: {wrote or '（无）'}")
    uses_it = "呱太" in prep.reply
    print(f"  回复里当场用了新名字: {paint('是', C_MIKU) if uses_it else paint('否（可能仍不自然）', C_WARN)}")
    print(f"  她 > {prep.reply}")
    print(f"  记忆里已有名字: {orch.memory.has_name()}\n")

    results: List[TurnResult] = []
    failures = 0
    for i, case in enumerate(ACCEPTANCE_CASES, 1):
        print(paint(f"── 用例 {i}/4：{case['desc']}", C_MIKU))
        print(f"   你 > {case['text']}")
        print(f"   {AGENT_NAME} > ", end="", flush=True)
        r = orch.handle(case["text"], stream=stream)
        if not stream:
            print(r.reply)
        print()

        tool_names = [t["tool"] for t in r.tools]
        route_ok = r.route == case["expect_route"]
        if case["expect_tool"]:
            tool_ok = case["expect_tool"] in tool_names
        else:
            tool_ok = len(tool_names) == 0
        ok = route_ok and tool_ok and not r.degraded
        if not ok:
            failures += 1
        results.append(r)

        print(f"   路由: 期望 {case['expect_route']:5s} / 实际 {r.route:5s}  "
              f"{paint('✓', C_MIKU) if route_ok else paint('✗', C_WARN)}")
        print(f"   工具: 期望 {case['expect_tool'] or '无':16s} / 实际 "
              f"{', '.join(tool_names) or '无':16s} "
              f"{paint('✓', C_MIKU) if tool_ok else paint('✗', C_WARN)}")
        print(f"   记忆: 注入 {len(r.memories_used)} 条"
              + (f"（{r.memories_used[0]['content']}）" if r.memories_used else ""))
        print(f"   状态: {r.mood_before} → {r.mood_after}   "
              f"首反馈 {r.first_feedback_ms:.0f}ms / 总耗时 {r.total_ms:.0f}ms")
        print(f"   审计: trace_id={r.trace_id}")
        print(paint("   判定: " + ("通过 ✓" if ok else "未通过 ✗"), C_MIKU if ok else C_WARN))
        print()

    # ---- 汇总 ----
    print(paint("=" * 78, C_MIKU))
    print(f"  结果：{len(ACCEPTANCE_CASES) - failures}/{len(ACCEPTANCE_CASES)} 通过")
    print(f"  记忆库：{json.dumps(orch.memory.stats()['active_by_kind'], ensure_ascii=False)}")
    print(f"  路由分布：{json.dumps(orch.router.stats(), ensure_ascii=False)}")
    print(f"  情绪状态：{orch.state.bar()}")
    print(paint("=" * 78, C_MIKU))

    # ---- 写一份可提交的验收报告 ----
    report = {
        "agent": AGENT_NAME,
        "session": orch.session_id,
        "cases": [dict(case, **{"result": r.to_dict()}) for case, r in zip(ACCEPTANCE_CASES, results)],
        "summary": {
            "passed": len(ACCEPTANCE_CASES) - failures,
            "total": len(ACCEPTANCE_CASES),
            "memory": orch.memory.stats(),
            "router": orch.router.stats(),
            "emotion": orch.state.snapshot(),
        },
    }
    out = BASE_DIR / "logs" / "acceptance_report.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n  验收报告已写入：{out}")
    print(f"  审计日志：{LOG_FILE}")
    return failures


# ==========================================================================
# 命令行
# ==========================================================================
HELP = f"""
可用命令（在对话中直接输入）：
  /help              显示本帮助
  /state             查看当前情绪 / 羁绊 / 关系状态
  /memory [关键词]   查看长期记忆（可带关键词检索）
  /timeline          查看记忆生命周期事件（覆盖 / 遗忘 / 衰减）
  /forget <关键词>   真的删除相关记忆
  /forgetall         清空全部记忆
  /route <文本>      只看路由决策，不调用任何模型（调试用）
  /tools             查看已注册的工具
  /audit [trace_id]  回放审计链路（默认最近一轮）
  /last              重复查看上一轮回复
  /exit              退出（会保存状态）
"""


def repl(orch: Orchestrator, stream: bool = True) -> None:
    print(paint(f"\n{'=' * 78}", C_MIKU))
    print(paint(f"  {AGENT_NAME} 已上线 —— 本地 {SETTINGS.ollama_model} 负责人格，"
                f"云端 {SETTINGS.deepseek_model} 负责行动", C_MIKU))
    print(paint(f"{'=' * 78}", C_MIKU))
    print(orch.health())
    print(paint("\n输入 /help 查看命令，/exit 退出。\n", C_DIM))

    with orch.log.turn(orch.session_id) as startup_turn:
        greeting = orch.startup(startup_turn)
    if greeting:
        print(paint(f"{AGENT_NAME} > ", C_MIKU) + greeting)
        print()
    else:
        print(paint(f"{AGENT_NAME} > ", C_MIKU) + PERSONA["opening"])
        print()

    last: Optional[TurnResult] = None
    while True:
        try:
            raw = input(paint("你 > ", C_ACT)).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not raw:
            continue

        # ---------------- 斜杠命令 ----------------
        if raw.startswith("/"):
            cmd, _, arg = raw[1:].partition(" ")
            cmd, arg = cmd.strip().lower(), arg.strip()

            if cmd in ("exit", "quit", "q"):
                break
            if cmd == "help":
                print(HELP)
            elif cmd == "state":
                s = orch.state.snapshot()
                print(f"  {orch.state.bar()}")
                print(f"  关系: {orch.state.relation_block()}")
                print(f"  心情变迁历史（最近 5 次）:")
                for h in orch.state.mood_history[-5:]:
                    print(f"    {h['ts']}  {h['from']} → {h['to']}")
            elif cmd == "memory":
                hits = orch.memory.recall(arg) if arg else orch.memory.list_active(limit=25)
                if not hits:
                    print("  （没有匹配的记忆）")
                for m in hits:
                    score = f" score={m.get('score')}" if m.get("score") is not None else ""
                    print(f"  #{m['id']:<4} [{m['kind']:<11}] key={m['key'] or '-':<14}"
                          f" imp={m['importance']:.2f} emo={m['emotional_weight']:.2f}{score}")
                    print(f"        {m['content']}")
            elif cmd == "timeline":
                for e in orch.memory.timeline(limit=25):
                    print(f"  {e['ts']}  {e['op']:<12} kind={e['kind']:<11} "
                          f"key={e['key'] or '-':<14} {e['reason'] or ''}")
                    if e.get("old_content") and e.get("new_content"):
                        print(f"        {e['old_content']}  →  {e['new_content']}")
            elif cmd == "forget":
                if not arg:
                    print("  用法: /forget <关键词>")
                else:
                    gone = orch.memory.forget(query=arg, reason="用户用 /forget 命令遗忘")
                    print(f"  真的删除了 {len(gone)} 条：" +
                          "、".join(g["content"] for g in gone) if gone else "  （没有匹配到记忆）")
            elif cmd == "forgetall":
                n = orch.memory.forget_all(reason="用户用 /forgetall 清空")
                print(f"  已清空 {n} 条长期记忆。")
            elif cmd == "route":
                if not arg:
                    print("  用法: /route <文本>")
                else:
                    print(orch.router.explain(arg))
            elif cmd == "tools":
                print(orch.api.tool_help())
            elif cmd == "audit":
                trace = arg or (last.trace_id if last else "")
                if not trace:
                    print("  还没有可回放的轮次。")
                else:
                    print(orch.log.explain_trace(trace))
            elif cmd == "last":
                if last:
                    print(f"{AGENT_NAME} > {last.reply}")
                else:
                    print("  还没有对话过。")
            else:
                print(f"  未知命令 /{cmd}，输入 /help 查看。")
            continue

        # ---------------- 正常一轮 ----------------
        print(paint(f"{AGENT_NAME} > ", C_MIKU), end="", flush=True)
        with orch.log.turn(orch.session_id) as turn:
            result = orch.handle(raw, stream=stream, turn=turn)
        if not stream:
            print(result.reply)
        print()
        if orch.verbose:
            bits = [f"路由={result.route}", f"策略={result.policy}"]
            if result.tools:
                bits.append(f"真实行动={len(result.tools)}")
            if result.revoice_used:
                bits.append("已拟人化包装")
            bits.append(f"心情={result.mood_after}")
            bits.append(f"{result.total_ms:.0f}ms")
            print(paint("  [" + " | ".join(bits) + f" | trace={result.trace_id}]", C_DIM))
            print()
        last = result

    orch.shutdown()
    print(paint(f"\n{AGENT_NAME} 已下线。状态与记忆已保存到磁盘，下次见面她还记得。", C_MIKU))


def main() -> int:
    ap = argparse.ArgumentParser(
        description=f"{AGENT_NAME} — 具备持续状态、人格、记忆和行动能力的智能角色 Agent")
    ap.add_argument("--test", action="store_true", help="跑题目要求的 4 个验收用例")
    ap.add_argument("--once", metavar="TEXT", help="只处理一轮输入")
    ap.add_argument("--route", metavar="TEXT", help="只看路由决策，不调用模型")
    ap.add_argument("--state", action="store_true", help="打印当前状态")
    ap.add_argument("--memory", action="store_true", help="打印长期记忆")
    ap.add_argument("--audit", nargs="?", const="__last__", metavar="TRACE_ID",
                    help="回放审计链路")
    ap.add_argument("--stats", action="store_true", help="打印统计信息")
    ap.add_argument("--no-stream", action="store_true", help="关闭流式输出")
    ap.add_argument("--session", default=None, help="会话 id（默认取 .env）")
    ap.add_argument("--quiet", action="store_true", help="不打印每轮的路由摘要")
    ap.add_argument("--router-mode", choices=["keyword", "hybrid", "model"], default=None,
                    help="路由模式：keyword=纯关键词 / hybrid=关键词+模型判断（默认）"
                         " / model=全部由模型判断")
    args = ap.parse_args()

    stream = SETTINGS.stream and not args.no_stream

    # 只做路由判断时不需要数据库，但**需要** API 客户端，
    # 否则 hybrid/model 模式下无法展示"模型自己怎么判断"。
    if args.route:
        probe = APIAgent(build_default_registry())
        r = Router(mode=args.router_mode, intent_classifier=probe.classify_intent)
        print(r.explain(args.route))
        print(f"\n（当前路由模式：{r.mode}"
              f"{'；关键词未命中时会再问一次模型' if r.mode == 'hybrid' else ''}）")
        return 0

    if args.test:
        # 验收测试使用独立的临时记忆库，不会污染你真实的角色数据
        return 1 if run_acceptance(stream=stream) else 0

    orch = Orchestrator(session_id=args.session, verbose=not args.quiet,
                        router_mode=args.router_mode)

    try:
        if args.once:
            with orch.log.turn(orch.session_id) as turn:
                greeting = orch.startup(turn)
                if greeting:
                    print(paint(f"{AGENT_NAME} > ", C_MIKU) + greeting)
                    print()
                print(paint(f"{AGENT_NAME} > ", C_MIKU), end="", flush=True)
                r = orch.handle(args.once, stream=stream, turn=turn)
            if not stream:
                print(r.reply)
            print()
            if not args.quiet:
                print(paint(f"  [路由={r.route} 策略={r.policy} 工具={len(r.tools)} "
                            f"心情={r.mood_before}→{r.mood_after} trace={r.trace_id}]", C_DIM))
            orch.shutdown()
            return 0

        if args.state:
            print(orch.state.bar())
            print(" ", orch.state.relation_block())
            print(" ", json.dumps(orch.state.snapshot(), ensure_ascii=False))
            orch.shutdown()
            return 0

        if args.memory:
            for m in orch.memory.list_active(limit=40):
                print(f"#{m['id']:<4} [{m['kind']:<11}] key={m['key'] or '-':<14} "
                      f"imp={m['importance']:.2f} emo={m['emotional_weight']:.2f} "
                      f"conf={m['confidence']:.2f}")
                print(f"     {m['content']}   (created {m['created_at']})")
            orch.shutdown()
            return 0

        if args.audit is not None:
            if args.audit == "__last__":
                turns = [e for e in orch.log.tail(500) if e.get("event") == "turn.start"]
                if not turns:
                    print("日志里还没有任何轮次。")
                    orch.shutdown()
                    return 0
                trace = turns[-1].get("trace_id")
            else:
                trace = args.audit
            print(orch.log.explain_trace(trace))
            orch.shutdown()
            return 0

        if args.stats:
            print("=== 日志 ===")
            print(json.dumps(orch.log.stats(), ensure_ascii=False, indent=2))
            print("=== 记忆 ===")
            print(json.dumps(orch.memory.stats(), ensure_ascii=False, indent=2))
            print("=== 路由 ===")
            print(json.dumps(orch.router.stats(), ensure_ascii=False, indent=2))
            print("=== 状态 ===")
            print(json.dumps(orch.state.snapshot(), ensure_ascii=False, indent=2))
            orch.shutdown()
            return 0

        # 默认：交互式对话
        try:
            repl(orch, stream=stream)
        except Exception:
            orch.shutdown()
            raise
        return 0
    finally:
        pass


if __name__ == "__main__":
    sys.exit(main())
