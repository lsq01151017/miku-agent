"""
api_agent.py — 云端 API 工具调用（Lv2 · Action）
================================================

题目 4.2 的核心要求：
  "Agent 能够判断什么时候仅仅需要回答，什么时候应该采取行动，
   并根据行动结果继续完成任务。"
  "系统还应该能够区分『说自己做了某件事』和『真正执行了某个行为』。"

这个模块用 deepseek-flash 的 tool calling 实现一个**真实的行动循环**：

    用户输入
      → 模型决定：直接回答，还是调用工具
      → 若调用：dispatch 到 tools.py **真正执行**
      → 把真实结果作为 role="tool" 消息回传给模型
      → 模型基于真实结果继续（可以再调用工具，形成工具链）
      → 直到给出最终回答

数据上刻意把两件事分开，这是本模块最重要的设计：
    APIResponse.tool_calls   = 真实发生过的行为（含入参、真实返回值、耗时、来源）
    APIResponse.reply        = 语言输出
并且会在收尾时做一次审计：如果模型嘴上说"我查了一下"但整轮没有任何一次
真实工具调用，就记一条 warn 级别的 action.claim_without_call —— 让
"说过"和"做过"的差异在日志里可见。

关于流式：deepseek-flash 支持"流式 + tool_calls"，所以这里全程用流式，
既能累积工具调用参数，也把首个 token 延迟暴露给 Lv4 的实时反馈。
"""

from __future__ import annotations

import json
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import SETTINGS  # noqa: E402
from logger import EventLogger, TurnContext, get_logger  # noqa: E402
from tools import ToolRegistry, ToolResult, build_default_registry  # noqa: E402

# 会注入到 System Prompt 的行动准则（由 main 作为 extra 传入同一个上下文构建器）
API_TOOL_INSTRUCTIONS = """# 关于你的行动能力
你可以调用工具去获取真实世界的信息。请遵守：
- 涉及天气、气温、当前时间/日期、数学计算等**现实世界事实**时，必须调用工具，
  绝对不要凭记忆或猜测回答。
- 只调用**完成这次提问所必需的最少工具**：问时间就只查时间，不要顺手把天气也查了。
  多查会造成多余的延迟与费用，也会让回答跑题。
- 工具返回的数据必须原样使用，不要修改数字、不要补充工具没给出的信息。
- 如果工具返回失败或被标记为模拟数据，要如实说明失败，不要编造一个结果。
- 绝对不要在没有真正调用工具的情况下说"我查了一下""我帮你算了"。
- 不要输出 JSON、字段名或工具名称，用自然语言把结果说出来。
"""

# 用于审计"声称做过但没真做"的措辞
_CLAIM_PATTERNS = [
    r"我(?:已经|刚刚)?(?:帮你|给你)?(?:查|查询|搜|搜索|算|计算|获取)了",
    r"我查到", r"查询结果", r"根据(?:查询|搜索|工具)",
    r"我(?:刚刚)?(?:用工具|调用)",
    r"刚(?:查|算)了一下",
]

# --------------------------------------------------------------------------
# 事实模式（配合创新点「工具拟人化包装」）
# --------------------------------------------------------------------------
# 设计取舍：本地模块已经会给出带人格的最终回复，如果 API 也输出一遍人格化回答，
# 就等于做了两遍同样的事，而且第二遍会以第一遍为"资料"，容易串味。
# 所以开启 revoice 时，API 退回成纯粹的"行动 + 事实"模块：
#   职责边界 = API 负责"真的去查"和"把事实说准"，本地负责"用什么语气说"。
# 这正好在架构上落实了题目要的那句：语言输出和系统行为是两个可区分的概念。
FACTS_MODE_ROLE = """# 你的角色
你现在是「心音」，一个负责**事实查证与行动执行**的内部模块，不是角色扮演者。
你的唯一任务是：判断是否需要调用工具 → 调用它 → 把真实结果整理成客观事实说明。

输出要求：
- 中文，2~4 句，只陈述事实与数字；
- 不要语气词、不要 ♪、不要卖萌、不要自称初音未来；
- 不要编造任何工具没有返回的信息；
- 你的输出会交给另一个模块包装成最终对用户说的话，所以你只需要把事实讲准确。
"""


def build_facts_system_prompt(*, memory_block: str = "", relation_block: str = "",
                              extra: str = "") -> str:
    """事实模式的 System Prompt（不含人格，只含背景资料 + 行动准则）。"""
    parts = [FACTS_MODE_ROLE]
    if relation_block:
        parts.append("\n# 背景：对方是谁\n" + relation_block)
    if memory_block:
        parts.append("\n# 背景：已知的相关记忆（仅用于理解指代，不要复述）\n" + memory_block)
    parts.append("\n" + API_TOOL_INSTRUCTIONS)
    if extra:
        parts.append("\n# 本轮补充\n" + extra)
    return "\n".join(parts)


@dataclass
class ToolCallRecord:
    """一次**真实**的工具调用。"""

    name: str
    args: Any
    result: ToolResult
    iteration: int = 1
    call_id: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "tool": self.name,
            "args": self.args,
            "ok": self.result.ok,
            "source": self.result.source,
            "duration_ms": self.result.duration_ms,
            "error": self.result.error,
            "data": self.result.data,
            "iteration": self.iteration,
        }


@dataclass
class APIResponse:
    reply: str = ""                       # 语言输出
    tool_calls: List[ToolCallRecord] = field(default_factory=list)   # 真实行为
    iterations: int = 0
    model: str = ""
    latency_ms: float = 0.0
    first_token_ms: float = 0.0
    usage: Dict[str, Any] = field(default_factory=dict)
    degraded: bool = False
    error: Optional[str] = None
    claim_without_call: bool = False
    held_out_reply: str = ""               # 被 revoice 替换掉的原始回答

    # -------- 给上层用的派生信息 --------
    @property
    def acted(self) -> bool:
        """这一轮到底有没有真的"做过事"。"""
        return len(self.tool_calls) > 0

    @property
    def any_failed(self) -> bool:
        return any(not tc.result.ok for tc in self.tool_calls)

    @property
    def all_mock(self) -> bool:
        """所有成功的结果都来自模拟数据（说明真实数据源不可达）。"""
        ok = [tc for tc in self.tool_calls if tc.result.ok]
        return bool(ok) and all(tc.result.source == "mock" for tc in ok)

    def facts_block(self) -> str:
        """把真实结果整理成给本地模型"包装语气"用的资料（创新点）。"""
        if not self.tool_calls:
            return ""
        lines: List[str] = []
        for tc in self.tool_calls:
            if tc.result.ok:
                lines.append(
                    f"- {tc.name}({json.dumps(tc.args, ensure_ascii=False)}) "
                    f"→ 真实数据（来源：{tc.result.source}）："
                    f"{json.dumps(tc.result.data, ensure_ascii=False)}"
                )
            else:
                lines.append(
                    f"- {tc.name}({json.dumps(tc.args, ensure_ascii=False)}) "
                    f"→ **执行失败**：{tc.result.error}"
                )
        return "\n".join(lines)

    def action_note(self) -> str:
        """给本地模型的一句执行情况备注（失败/降级时要求她道歉）。"""
        notes: List[str] = []
        if self.any_failed:
            notes.append("有工具执行失败，请如实说明失败并道歉，不要编造结果")
        if self.all_mock:
            notes.append("数据来自离线模拟、不是真实天气，请明确告诉制作人这一点")
        return "；".join(notes)

    def action_emotion_deltas(self) -> tuple[Dict[str, float], List[str]]:
        """行动结果对角色状态的影响（题目开放问题 7：行动失败应影响角色状态）。"""
        deltas = {"valence": 0.0, "arousal": 0.0, "empathy": 0.0, "bond": 0.0}
        reasons: List[str] = []
        if self.any_failed:
            deltas["valence"] = -0.12
            deltas["arousal"] = -0.10
            reasons.append("行动失败 → 她有点沮丧和抱歉（心情-0.12, 活力-0.10）")
        if self.all_mock:
            deltas["valence"] = deltas.get("valence", 0.0) - 0.05
            reasons.append("只能拿到模拟数据 → 略感歉意（心情-0.05）")
        if self.acted and not self.any_failed:
            deltas["bond"] = 0.03
            reasons.append("真的帮上了忙 → 羁绊+0.03")
        return deltas, reasons


class APIAgent:
    """Lv2：deepseek-flash 工具调用循环。"""

    def __init__(self, registry: Optional[ToolRegistry] = None,
                 logger: Optional[EventLogger] = None):
        self.registry = registry or build_default_registry()
        self.log = logger or get_logger()
        self.model = SETTINGS.deepseek_model
        self.max_iterations = SETTINGS.tool_max_iterations
        self._client = None
        self.available = False
        self.availability_note = ""
        self._intent_cache: Dict[str, Dict[str, Any]] = {}   # 意图判断缓存
        self._connect()

    def _connect(self) -> None:
        if not SETTINGS.deepseek_api_key:
            self.availability_note = "未配置 DEEPSEEK_API_KEY（请在 .env 中填写）"
            return
        try:
            from openai import OpenAI  # 延迟导入
        except ImportError as exc:
            self.availability_note = f"未安装 openai 库: {exc}"
            return
        try:
            self._client = OpenAI(api_key=SETTINGS.deepseek_api_key,
                                  base_url=SETTINGS.deepseek_base_url,
                                  timeout=60.0, max_retries=1)
            self.available = True
            self.availability_note = f"已就绪 {SETTINGS.deepseek_base_url} / {self.model}"
        except Exception as exc:
            self.availability_note = f"OpenAI 客户端初始化失败: {type(exc).__name__}: {exc}"

    # ------------------------------------------------------------------
    # 意图判断：让模型自己决定"要不要行动"（供 router 使用）
    # ------------------------------------------------------------------
    def classify_intent(self, text: str) -> Optional[Dict[str, Any]]:
        """问模型一句话：这句需要真实行动吗？只回答 ACT / CHAT。

        为什么要有这个：关键词路由隐含了"用户会问什么"的预设，没命中就只会聊天。
        让模型读一句话自己判断，就不需要预设词表了。
        成本很低（约几十个 token），并且带缓存 —— 相同说法不重复问。
        """
        if not self.available or not self._client:
            return None
        key = (text or "").strip()
        if not key:
            return None
        cached = self._intent_cache.get(key)
        if cached is not None:
            return cached

        system = (
            "你是一个意图分类器。判断用户这句话是否需要**查询现实世界的信息**"
            "（天气、气温、当前时间/日期、新闻、实时数据）或**执行精确计算**。\n"
            "需要 → 只回答 ACT\n"
            "不需要（闲聊、情感、回忆、创作、提问关于角色自身设定）→ 只回答 CHAT\n"
            "只输出 ACT 或 CHAT 这两个词之一，不要任何解释、标点或其它文字。"
        )
        try:
            resp = self._client.chat.completions.create(
                model=self.model,
                messages=[{"role": "system", "content": system},
                          {"role": "user", "content": key}],
                temperature=0.0,
                # 注意：deepseek-flash 即使是这种trivial分类也会先产出约 90~100 个
                # reasoning token，而 reasoning 也计入 max_tokens。
                # 预算给小了（例如 8 或 100）会 finish_reason=length 且 content 为空，
                # 于是所有输入都被误判成"不需要行动"。给足 400 才稳定。
                max_tokens=400,
            )
        except Exception as exc:
            self.log.event("router.classify_failed", level="warn",
                           error=f"{type(exc).__name__}: {exc}", text=key[:100])
            return None

        choice = resp.choices[0]
        raw = (choice.message.content or "").strip()
        raw = re.sub(r"</?think(?:ing)?>", "", raw, flags=re.I).strip().upper()
        if not raw:
            # 预算被推理吃光 → 拿不到判断。不要瞎猜，交回兜底策略（走本地）
            self.log.event("router.classify_empty", level="warn", text=key[:100],
                           finish_reason=choice.finish_reason,
                           note="分类器正文为空（推理占满预算），改由兜底策略处理")
            return None
        verdict = {"needs_action": raw.startswith("ACT"), "raw": raw[:24]}

        self._intent_cache[key] = verdict
        self.log.event("router.classified", text=key[:100],
                       needs_action=verdict["needs_action"], raw=verdict["raw"])
        return verdict

    # ------------------------------------------------------------------
    # 底层：流式调用（累积 content 与 tool_calls 增量）
    # ------------------------------------------------------------------
    def _stream_once(
        self,
        messages: List[Dict[str, Any]],
        *,
        tool_choice: str = "auto",
        on_token: Optional[Callable[[str], None]] = None,
        on_first_token: Optional[Callable[[float, str], None]] = None,
    ) -> Dict[str, Any]:
        """一次流式请求。返回 {content, tool_calls, finish_reason, usage, first_token_ms, latency_ms}"""
        schemas = self.registry.schemas()
        kwargs: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "tools": schemas,
            "tool_choice": tool_choice,
            "stream": True,
            "temperature": 0.3,          # 行动要稳，不要发挥
        }
        started = time.perf_counter()
        try:
            stream = self._client.chat.completions.create(
                stream_options={"include_usage": True}, **kwargs)
        except Exception:
            # 某些兼容端点不支持 stream_options
            stream = self._client.chat.completions.create(**kwargs)

        content_parts: List[str] = []
        acc: Dict[int, Dict[str, str]] = {}
        finish_reason: Optional[str] = None
        usage: Dict[str, Any] = {}
        first_token_ms = 0.0
        first_kind = ""

        for chunk in stream:
            chunk_usage = getattr(chunk, "usage", None)
            if chunk_usage is not None:
                usage = {
                    "prompt_tokens": getattr(chunk_usage, "prompt_tokens", None),
                    "completion_tokens": getattr(chunk_usage, "completion_tokens", None),
                    "total_tokens": getattr(chunk_usage, "total_tokens", None),
                }
            choices = getattr(chunk, "choices", None) or []
            if not choices:
                continue
            choice = choices[0]
            if choice.finish_reason:
                finish_reason = choice.finish_reason
            delta = getattr(choice, "delta", None)
            if delta is None:
                continue

            piece = getattr(delta, "content", None)
            if piece:
                if first_token_ms == 0.0:
                    first_token_ms = (time.perf_counter() - started) * 1000
                    first_kind = "content"
                    if on_first_token:
                        on_first_token(first_token_ms, "content")
                content_parts.append(piece)
                if on_token:
                    on_token(piece)

            for tc in (getattr(delta, "tool_calls", None) or []):
                idx = getattr(tc, "index", 0) or 0
                slot = acc.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                if getattr(tc, "id", None):
                    slot["id"] = tc.id
                fn = getattr(tc, "function", None)
                if fn is not None:
                    if getattr(fn, "name", None):
                        slot["name"] = fn.name
                    if getattr(fn, "arguments", None):
                        slot["arguments"] += fn.arguments
                if first_token_ms == 0.0:
                    first_token_ms = (time.perf_counter() - started) * 1000
                    first_kind = "tool_call"
                    if on_first_token:
                        on_first_token(first_token_ms, "tool_call")

        return {
            "content": "".join(content_parts).strip(),
            "tool_calls": [acc[i] for i in sorted(acc)],
            "finish_reason": finish_reason,
            "usage": usage,
            "first_token_ms": first_token_ms,
            "first_token_kind": first_kind,
            "latency_ms": (time.perf_counter() - started) * 1000,
        }

    # ------------------------------------------------------------------
    # 主流程：行动循环
    # ------------------------------------------------------------------
    def run(
        self,
        user_text: str,
        *,
        system_prompt: str,
        history: Optional[Sequence[Dict[str, str]]] = None,
        turn: Optional[TurnContext] = None,
        on_token: Optional[Callable[[str], None]] = None,
        # 注意：这个回调会被调用为 on_first_token(毫秒, 类型)，类型是 "content" 或 "tool_call"
        on_first_token: Optional[Callable[..., None]] = None,
        on_action: Optional[Callable[[ToolCallRecord], None]] = None,
    ) -> APIResponse:
        """执行一次"判断 → 行动 → 基于结果继续"的完整循环。"""
        t_log = turn or _NullTurn(self.log, getattr(turn, "trace_id", ""))
        resp = APIResponse(model=self.model)

        if not self.available:
            resp.degraded = True
            resp.error = self.availability_note
            t_log.log("turn.error", level="error", error=self.availability_note, route="api")
            return resp

        messages: List[Dict[str, Any]] = [{"role": "system", "content": system_prompt}]
        messages.extend(dict(m) for m in (history or []))
        messages.append({"role": "user", "content": user_text})

        started = time.perf_counter()
        final_text = ""
        iteration = 0

        while iteration < self.max_iterations:
            iteration += 1
            t_log.llm("request", model=self.model, via="deepseek-api",
                      iteration=iteration, messages=len(messages),
                      tools=self.registry.names(), tool_choice="auto")
            try:
                out = self._stream_once(messages, tool_choice="auto",
                                        on_token=on_token, on_first_token=on_first_token)
            except Exception as exc:
                resp.degraded = True
                resp.error = f"{type(exc).__name__}: {exc}"
                t_log.log("turn.error", level="error", error=resp.error, route="api",
                          iteration=iteration)
                break

            resp.first_token_ms = resp.first_token_ms or out["first_token_ms"]
            resp.usage = out["usage"] or resp.usage
            t_log.llm("response", model=self.model, via="deepseek-api", iteration=iteration,
                      finish_reason=out["finish_reason"], latency_ms=round(out["latency_ms"], 1),
                      first_token_ms=round(out["first_token_ms"], 1),
                      first_token_kind=out["first_token_kind"],
                      tool_call_count=len(out["tool_calls"]), chars=len(out["content"]),
                      usage=out["usage"])

            if out["tool_calls"]:
                # 把模型这一步的"决定"写回对话（OpenAI 协议要求）
                messages.append({
                    "role": "assistant",
                    "content": out["content"] or None,
                    "tool_calls": [
                        {"id": tc["id"] or f"call_{i}", "type": "function",
                         "function": {"name": tc["name"], "arguments": tc["arguments"] or "{}"}}
                        for i, tc in enumerate(out["tool_calls"])
                    ],
                })

                for i, tc in enumerate(out["tool_calls"]):
                    name = tc["name"]
                    raw_args = tc["arguments"] or "{}"
                    spec = self.registry.get(name)
                    t_log.action_call(name, _safe_json(raw_args), iteration=iteration,
                                      side_effect=bool(spec and spec.side_effect))
                    try:
                        args_obj = json.loads(raw_args) if raw_args.strip() else {}
                    except json.JSONDecodeError:
                        args_obj = {}

                    result = self.registry.dispatch(name, raw_args)
                    record = ToolCallRecord(name=name, args=args_obj, result=result,
                                            iteration=iteration, call_id=tc["id"])
                    resp.tool_calls.append(record)

                    t_log.action_result(name, result.to_dict(), result.duration_ms, ok=result.ok)
                    if on_action:
                        on_action(record)

                    # 真实结果回传给模型，让它据此继续
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc["id"] or f"call_{i}",
                        "content": result.to_tool_message(),
                    })
                continue     # 带着真实结果进入下一轮

            # 没有工具调用 → 这就是最终回答
            final_text = out["content"]
            break
        else:
            # 达到迭代上限但模型还在要求调用工具：强制它给出结论
            t_log.log("action.iteration_limit", level="warn",
                      max_iterations=self.max_iterations,
                      note="强制模型只做总结，不再调用工具")
            messages.append({"role": "user", "content":
                             "请立刻用已有信息给出最终回答，不要再调用任何工具。"})
            try:
                out = self._stream_once(messages, tool_choice="none", on_token=on_token)
                final_text = out["content"]
                resp.usage = out["usage"] or resp.usage
                t_log.llm("response", model=self.model, via="deepseek-api",
                          iteration=iteration + 1, forced_final=True,
                          chars=len(final_text), usage=out["usage"])
            except Exception as exc:
                resp.error = f"强制收尾失败: {type(exc).__name__}: {exc}"
                t_log.log("turn.error", level="error", error=resp.error, forced_final=True)

        resp.reply = final_text
        resp.iterations = iteration
        resp.latency_ms = (time.perf_counter() - started) * 1000

        # ---- 审计：说"我做了"但其实没做 ----
        if not resp.acted and resp.reply and any(re.search(p, resp.reply) for p in _CLAIM_PATTERNS):
            resp.claim_without_call = True
            t_log.log("action.claim_without_call", level="warn",
                      reply=resp.reply[:200],
                      note="模型声称执行了动作，但本轮没有任何真实工具调用记录")

        t_log.log("action.summary", acted=resp.acted, tool_count=len(resp.tool_calls),
                  any_failed=resp.any_failed, all_mock=resp.all_mock,
                  iterations=resp.iterations, latency_ms=round(resp.latency_ms, 1))
        return resp

    # 供 main 直接查看工具清单
    def tool_help(self) -> str:
        return self.registry.describe()


def _safe_json(raw: str) -> Any:
    try:
        return json.loads(raw) if raw and raw.strip() else {}
    except json.JSONDecodeError:
        return raw


class _NullTurn:
    """没有 TurnContext 时的空实现。"""

    def __init__(self, logger: EventLogger, trace_id: str = ""):
        self._logger = logger
        self.trace_id = trace_id or ""
        self.turn = 0

    def log(self, event: str, level: str = "info", **fields: Any) -> None:
        self._logger.event(event, level=level, trace_id=self.trace_id or None, **fields)

    def llm(self, phase: str, **f: Any) -> None:
        self.log(f"llm.{phase}", **f)

    def action_call(self, tool: str, args: Any, iteration: int = 1, side_effect: bool = False) -> None:
        self.log("action.call", tool=tool, args=args, iteration=iteration, side_effect=side_effect)

    def action_result(self, tool: str, result: Any, duration_ms: float, ok: bool = True) -> None:
        self.log("action.result", tool=tool, ok=ok, duration_ms=round(duration_ms, 1), result=result)


# --------------------------------------------------------------------------
# 自检：python api_agent.py
# --------------------------------------------------------------------------
if __name__ == "__main__":
    from config import AGENT_PERSONALITY

    agent = APIAgent()
    print("API 状态:", agent.availability_note)
    print("\n可用工具:")
    print(agent.tool_help())

    if not agent.available:
        raise SystemExit("API 不可用，跳过联调自检")

    cases = [
        "西安今天天气怎么样？",      # 需要 get_weather
        "现在几点了？",              # 需要 get_current_time
        "(15+7)*3/2 等于多少？",     # 需要 calculate
        "你好呀，你是谁？",          # 不需要工具
    ]
    for text in cases:
        print("\n" + "=" * 70)
        print("用户:", text)
        system = AGENT_PERSONALITY + "\n\n" + API_TOOL_INSTRUCTIONS
        resp = agent.run(text, system_prompt=system,
                         on_token=lambda t: print(t, end="", flush=True))
        print()
        print(f"  → 迭代 {resp.iterations} 次 | 真实工具调用 {len(resp.tool_calls)} 次 "
              f"| 失败={resp.any_failed} | mock={resp.all_mock} "
              f"| 声称未做={resp.claim_without_call} | {resp.latency_ms:.0f}ms")
        for tc in resp.tool_calls:
            print(f"     [{tc.iteration}] {tc.name}({json.dumps(tc.args, ensure_ascii=False)}) "
                  f"-> ok={tc.result.ok} source={tc.result.source} {tc.result.duration_ms:.0f}ms")
        if resp.error:
            print("  error:", resp.error)
