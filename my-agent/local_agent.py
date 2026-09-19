"""
local_agent.py — 本地模型对话（Lv1：人格、情绪状态、流式输出、上下文管理）
==========================================================================

Lv1 要证明"这个角色不是一个完全无状态的文本生成器"。这个文件负责三件事：

1) 稳定的人格
   System Prompt = AGENT_PERSONALITY（常量人设）
                 + 关系状态 + 检索到的记忆 + 当前情绪（三个可变层）
   人格本体永不重新生成；变的是叠加在上面的状态。

2) 可观察、可更新、会真正影响行为的内部状态 —— AgentState
   五个连续维度（心情/活力/羁绊/寂寞/害羞）：
     - 每轮由情感分析更新（analyze_affect，规则词典，快且可解释）
     - 随时间向基线衰减（遗忘曲线）
     - **离开久了寂寞感会自己上升**（她人设里"怕寂寞"）
     - 渲染成 MOOD_DIRECTIVES 里的语气指令注入下一轮 Prompt
     - 同一份状态也供 Lv3 的 Avatar 和 Lv4 的语音参数消费
   这就是"不只依赖一句 prompt"的答案：情绪是数据，不是形容词。

3) 上下文管理
   最近 N 轮逐字保留；更早的对话在被挤出窗口后**总结成摘要**再进入上下文，
   而不是简单丢弃 —— 既控制 token，又保住连续性。

另外提供 revoice()：Lv2 里 API 查回的数据由这里包上初音未来的语气
（你选定的创新点「工具拟人化包装」）。
"""

from __future__ import annotations

import json
import math
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import (  # noqa: E402
    AGENT_NAME,
    AFFECT_LEXICON,
    EMOTION_DIMENSIONS,
    EMOTION_MAX_STEP_PER_TURN,
    INTENSIFIERS,
    MOOD_DIRECTIVES,
    NEGATION_WORDS,
    PERSONA,
    PROACTIVE_GREETINGS,
    SETTINGS,
    STATE_PATH,
    build_emotion_block,
    build_system_prompt,
    mood_from_state,
)
from logger import EventLogger, TurnContext, get_logger  # noqa: E402
from memory import MemoryStore, now_iso, parse_iso  # noqa: E402


# ==========================================================================
# 情感分析（让情绪真的被"更新"，而不是靠 Prompt 演）
# ==========================================================================
_EXCLAIM = re.compile(r"[！!]")
_QUESTION = re.compile(r"[？?]")


def analyze_affect(text: str, weight: float = 1.0) -> Tuple[Dict[str, float], List[str]]:
    """规则词典情感分析。返回 (各维度变化量, 可读原因列表)。

    为什么不用模型判断？
      - 快（零延迟、零成本），不会让每轮回复多等十几秒；
      - 完全可解释 —— 日志里能写出"是「喜欢」这个词让心情 +0.25"；
      - 离线可用。想换成模型判断时把 SETTINGS.affect_analyzer 改成 "llm"
        （Lv3 预留），接口不变。

    处理了否定与程度副词，并按词长优先匹配，避免"不开心"把"开心"也算一遍。
    """
    deltas: Dict[str, float] = {dim: 0.0 for dim in EMOTION_DIMENSIONS}
    reasons: List[str] = []
    if not text:
        return deltas, reasons

    consumed = [False] * len(text)
    for word in sorted(AFFECT_LEXICON, key=len, reverse=True):
        spec = AFFECT_LEXICON[word]
        start = 0
        while True:
            idx = text.find(word, start)
            if idx == -1:
                break
            end = idx + len(word)
            if any(consumed[idx:end]):          # 已被更长的词吃掉
                start = idx + 1
                continue

            prefix = text[max(0, idx - 3):idx]
            mult = 1.0
            for intens, factor in INTENSIFIERS.items():
                if intens in prefix:
                    mult = max(mult, factor)
            negated = any(neg in prefix for neg in NEGATION_WORDS)

            notes: List[str] = []
            for dim, dv in spec.items():
                val = dv * mult
                if negated:
                    # 否定主要翻转好恶；羁绊/害羞否定后只是减弱
                    val = -val * (0.8 if dim == "valence" else 0.5)
                deltas[dim] += val
                notes.append(f"{EMOTION_DIMENSIONS[dim]['label']}{val:+.2f}")
            tag = "（被否定/降低）" if negated else ("（被加强）" if mult > 1.0 else "")
            reasons.append(f"「{word}」{tag} → {', '.join(notes)}")

            for i in range(idx, end):
                consumed[i] = True
            start = end

    # 标点与长度也是情绪信号
    n_ex = len(_EXCLAIM.findall(text))
    if n_ex:
        d = min(0.24, 0.08 * n_ex)
        deltas["arousal"] += d
        reasons.append(f"出现 {n_ex} 个感叹号 → 活力+{d:.2f}")
    n_q = len(_QUESTION.findall(text))
    if n_q:
        d = min(0.12, 0.03 * n_q)
        deltas["arousal"] += d
        reasons.append(f"出现 {n_q} 个问号 → 活力+{d:.2f}")
    if len(text) > 50:
        deltas["arousal"] += 0.05
        reasons.append("输入较长（说明愿意多聊） → 活力+0.05")

    if weight != 1.0:
        deltas = {k: v * weight for k, v in deltas.items()}
        if weight < 1.0:
            reasons.append(f"（本条按 {weight:.1f} 权重折算）")

    return deltas, reasons


def _strip_think(text: str) -> str:
    """去掉 R1 可能内联在正文里的思考块（think=True 时通常会分开返回）。"""
    if not text:
        return ""
    cleaned = re.sub(r"<think(?:ing)?>.*?</think(?:ing)?>", "", text, flags=re.S | re.I)
    cleaned = re.sub(r"</?think(?:ing)?>", "", cleaned, flags=re.I)
    return cleaned.strip()


def _trim_dangling(text: str) -> str:
    """被 token 上限截断时，去掉最后那段没说完的话。

    宁可少说一句，也不要让角色说出半句话 —— 截断非常破坏"活着"的感觉。
    """
    if not text:
        return text
    if text[-1] in "。！？!?…~♪”’）)】」":
        return text
    cut = max((text.rfind(ch) for ch in "。！？!?…"), default=-1)
    return text[:cut + 1] if cut > 0 else text


# 蒸馏工具结果时优先保留这些"人能读懂"的字段
_READABLE_KEYS = (
    "city", "condition", "temp_c", "feels_like_c", "temp_min_c", "temp_max_c",
    "human", "date", "time", "timezone", "result", "expression",
)


def _distill(result: Any, limit: int = 90) -> str:
    """把工具返回的原始 dict 压缩成一句**人能读懂的自然中文**（存记忆用）。

    直接存 JSON 会让以后的 Prompt 充满 temp_c / humidity 这类字段名，
    既挤占上下文，又容易诱导模型把字段名念出来。所以按工具类型分别措辞。
    """
    data = result.get("data") if isinstance(result, dict) else result
    if not isinstance(data, dict):
        return str(data)[:limit]

    # 天气
    if "temp_c" in data:
        head = f"{data.get('city') or '当地'}{data.get('condition') or ''}"
        parts = [f"{data['temp_c']}℃"]
        detail = []
        if data.get("feels_like_c") is not None:
            detail.append(f"体感 {data['feels_like_c']}℃")
        if data.get("temp_min_c") is not None and data.get("temp_max_c") is not None:
            detail.append(f"今日 {data['temp_min_c']}~{data['temp_max_c']}℃")
        if data.get("humidity") is not None:
            detail.append(f"湿度 {data['humidity']}%")
        if data.get("wind_kmph") is not None:
            detail.append(f"风速 {data['wind_kmph']}km/h")
        return (f"{head} {parts[0]}" + (f"（{'，'.join(detail)}）" if detail else ""))[:limit]

    # 时间
    if data.get("human"):
        return f"当时是 {data['human']}"[:limit]

    # 计算
    if "result" in data:
        return f"{data.get('expression', '')} = {data['result']}"[:limit]

    bits = [f"{k}={v}" for k, v in data.items() if not isinstance(v, (dict, list))]
    return "，".join(bits)[:limit]


# ==========================================================================
# 内部状态：情绪 / 羁绊 / 计数（持久化到 state.json）
# ==========================================================================
class AgentState:
    """角色的内部状态。可更新、可读取、会持久化、会衰减、会影响回复。"""

    def __init__(self, path: Path = STATE_PATH):
        self.path = Path(path)
        self.values: Dict[str, float] = {d: float(spec["baseline"])
                                         for d, spec in EMOTION_DIMENSIONS.items()}
        self.mood: str = "平静"
        self.mood_history: List[Dict[str, Any]] = []
        self.total_turns: int = 0
        self.first_met: str = now_iso()
        self.last_seen: str = now_iso()
        self.last_absence_hours: float = 0.0
        self.load()

    # ---------------- 持久化 ----------------
    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return
        for dim, spec in EMOTION_DIMENSIONS.items():
            raw = (data.get("values") or {}).get(dim)
            if isinstance(raw, (int, float)):
                self.values[dim] = max(float(spec["min"]), min(float(spec["max"]), float(raw)))
        self.mood = data.get("mood") or mood_from_state(
            self.values["valence"], self.values["arousal"], self.values["bond"],
            self.values["loneliness"], self.values["shyness"])
        self.mood_history = list(data.get("mood_history") or [])[-50:]
        self.total_turns = int(data.get("total_turns") or 0)
        self.first_met = data.get("first_met") or self.first_met
        self.last_seen = data.get("last_seen") or self.last_seen

    def save(self) -> None:
        payload = {
            "values": {k: round(v, 4) for k, v in self.values.items()},
            "mood": self.mood,
            "mood_history": self.mood_history[-50:],
            "total_turns": self.total_turns,
            "first_met": self.first_met,
            "last_seen": self.last_seen,
            "saved_at": now_iso(),
        }
        try:
            self.path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass

    # ---------------- 状态演化 ----------------
    def _decay(self, hours: float) -> List[str]:
        """向基线衰减（指数），并返回可读原因。"""
        reasons: List[str] = []
        if hours <= 0:
            return reasons
        for dim, spec in EMOTION_DIMENSIONS.items():
            hl = float(spec.get("decay_hours") or 999.0)
            if dim == "shyness":
                hl = min(hl, max(0.5, SETTINGS.emotion_decay_hours / 6.0))
            factor = 0.5 ** (hours / max(0.5, hl))
            if factor >= 0.999:
                continue
            base = float(spec["baseline"])
            old = self.values[dim]
            new = base + (old - base) * factor
            if abs(new - old) > 1e-4:
                self.values[dim] = new
                reasons.append(f"{spec['label']} {old:.2f}→{new:.2f}（{hours:.1f} 小时自然回落）")
        return reasons

    def begin_session(self) -> Dict[str, Any]:
        """会话开始：先让时间流逝产生效果，再判断要不要主动开口。

        这里实现了人设里"怕寂寞"的时间动力学：
        离开越久，寂寞感越高；久到超过阈值，她就会先说话（创新点「主动消息」）。
        """
        last = parse_iso(self.last_seen) or datetime.now().astimezone()
        hours = max(0.0, (datetime.now().astimezone() - last).total_seconds() / 3600.0)
        self.last_absence_hours = hours

        reasons = self._decay(hours)

        # 寂寞感随时间上升（48 小时封顶 +0.6）
        if hours > 1.0:
            lon = min(0.6, hours / 48.0 * 0.6)
            old = self.values["loneliness"]
            self.values["loneliness"] = max(0.0, min(1.0, old + lon))
            reasons.append(f"离开了 {hours:.1f} 小时 → 寂寞 +{lon:.2f}"
                           f"（{old:.2f}→{self.values['loneliness']:.2f}）")

        wants_proactive = hours >= SETTINGS.proactive_hours
        self._refresh_mood()
        self.save()
        return {"absence_hours": round(hours, 2), "wants_proactive": wants_proactive,
                "reasons": reasons, "mood": self.mood}

    def end_session(self) -> None:
        self.last_seen = now_iso()
        self.save()

    def grow_bond(self) -> str:
        """每轮互动都会让羁绊缓慢上升（渐近，不会瞬间满级）。"""
        old = self.values["bond"]
        self.values["bond"] = min(1.0, old + 0.02 * (1.0 - old))
        self.save()
        return f"羁绊 {old:.3f}→{self.values['bond']:.3f}（又聊了一轮）"

    def apply(self, deltas: Dict[str, float], reasons: List[str]) -> Dict[str, float]:
        """应用一轮的情绪变化，并返回变化前的快照（供日志对比）。

        带**情绪惯性**：单轮每个维度的变化幅度封顶（EMOTION_MAX_STEP_PER_TURN）。
        否则一句"我好喜欢你！"就能把心情顶到 +1.00 并停在那里，状态失去分辨力。
        """
        before = dict(self.values)
        for dim, spec in EMOTION_DIMENSIONS.items():
            dv = float(deltas.get(dim, 0.0) or 0.0)
            if dv == 0.0:
                continue
            if abs(dv) > EMOTION_MAX_STEP_PER_TURN:
                capped = EMOTION_MAX_STEP_PER_TURN if dv > 0 else -EMOTION_MAX_STEP_PER_TURN
                reasons.append(f"{spec['label']} 单轮变化 {dv:+.2f} 超过惯性上限，"
                               f"按 {capped:+.2f} 计入")
                dv = capped

            # 软饱和：越接近极值，同样的刺激带来的变化越小。
            # 否则连续几轮友好对话就会把心情顶到 +1.00 并永久停在那里，
            # 状态失去分辨力 —— "一直很开心"等于没有情绪信息。
            lo, hi = float(spec["min"]), float(spec["max"])
            span = max(1e-9, hi - lo)
            if dv > 0:
                room = (hi - self.values[dim]) / span
            else:
                room = (self.values[dim] - lo) / span
            factor = max(0.15, min(1.0, room * 2.0))     # 留 15% 的最小响应，避免完全僵死
            if factor < 0.7:
                reasons.append(f"{spec['label']} 已接近边界，本轮反应按 {factor:.0%} 衰减")
                dv *= factor

            self.values[dim] = max(lo, min(hi, self.values[dim] + dv))
        self._refresh_mood()
        self.save()
        return before

    def _refresh_mood(self) -> None:
        new_mood = mood_from_state(
            self.values["valence"], self.values["arousal"],
            self.values["bond"], self.values["loneliness"],
            self.values["shyness"], self.values["empathy"])
        if new_mood != self.mood:
            self.mood_history.append({"ts": now_iso(), "from": self.mood, "to": new_mood,
                                      "values": {k: round(v, 3) for k, v in self.values.items()}})
            self.mood = new_mood

    # ---------------- 读取 ----------------
    def snapshot(self) -> Dict[str, Any]:
        return {
            "mood": self.mood,
            "valence": round(self.values["valence"], 4),
            "arousal": round(self.values["arousal"], 4),
            "bond": round(self.values["bond"], 4),
            "loneliness": round(self.values["loneliness"], 4),
            "shyness": round(self.values["shyness"], 4),
            "empathy": round(self.values["empathy"], 4),
            "total_turns": self.total_turns,
            "last_absence_hours": round(self.last_absence_hours, 2),
        }

    def relation_block(self) -> str:
        """把关系状态渲染成 Prompt 文本。"""
        bond = self.values["bond"]
        if bond >= 0.7:
            level = "最重要的伙伴"
        elif bond >= 0.45:
            level = "熟悉的伙伴"
        elif bond >= 0.25:
            level = "渐渐熟起来的人"
        else:
            level = "刚认识的人"
        days = 0
        fm = parse_iso(self.first_met)
        if fm:
            days = max(0, (datetime.now().astimezone() - fm).days)
        return (f"关系：{level}（羁绊值 {bond:.2f}）。"
                f"你们已经一起聊过 {self.total_turns} 轮，认识第 {days + 1} 天。")

    def bar(self) -> str:
        """命令行里显示的可视化状态条（Lv3 的 Avatar 会消费同一份数据）。"""
        items = []
        for dim in ("valence", "arousal", "bond", "loneliness", "shyness", "empathy"):
            spec = EMOTION_DIMENSIONS[dim]
            v = self.values[dim]
            lo, hi = float(spec["min"]), float(spec["max"])
            ratio = (v - lo) / (hi - lo) if hi > lo else 0.0
            filled = int(round(ratio * 10))
            items.append(f"{spec['label']} {v:+.2f} [{'#' * filled}{'.' * (10 - filled)}]")
        return f"心情: {self.mood}  |  " + "  ".join(items)


# ==========================================================================
# 对话历史与上下文压缩
# ==========================================================================
class ConversationHistory:
    """最近 N 轮逐字 + 更早的对话压缩成摘要。"""

    def __init__(self, store: MemoryStore, session_id: str,
                 window: int = 8, trigger: int = 12):
        self.store = store
        self.session_id = session_id
        self.window = window              # 逐字保留的轮数（1 轮 = 2 条消息）
        self.trigger = trigger            # 窗口外累积多少条消息后触发总结
        self.messages: List[Dict[str, str]] = []
        self.summary: Optional[str] = store.latest_summary(session_id=session_id)
        self.summarized_upto: int = 0
        self._restore()

    def _restore(self) -> None:
        """重启后从 SQLite 恢复最近对话 —— 这是"跨会话持续存在"的基础。"""
        self.messages = self.store.recent_history(session_id=self.session_id,
                                                 limit=self.window * 2 + self.trigger * 2)

    def add(self, role: str, content: str) -> None:
        self.messages.append({"role": role, "content": content})

    @property
    def verbatim(self) -> List[Dict[str, str]]:
        """进入 Prompt 的逐字历史（最近 window 轮）。"""
        keep = self.window * 2
        return self.messages[-keep:] if keep > 0 else []

    @property
    def overflow(self) -> List[Dict[str, str]]:
        """已经被挤出逐字窗口、但还没被总结的部分。"""
        keep = self.window * 2
        return self.messages[:-keep] if len(self.messages) > keep else []

    def needs_compression(self) -> bool:
        return len(self.overflow) >= self.trigger

    def compression_prompt(self) -> str:
        parts = []
        for m in self.overflow:
            who = "制作人" if m["role"] == "user" else "未来"
            parts.append(f"{who}：{m['content']}")
        return "\n".join(parts)

    def mark_compressed(self, summary: str, covers_to: int) -> None:
        self.summary = summary
        self.summarized_upto = covers_to

    def prompt_messages(self) -> List[Dict[str, str]]:
        out: List[Dict[str, str]] = []
        if self.summary:
            out.append({
                "role": "system",
                "content": "（以下是你们更早之前的对话摘要，作为背景，不要直接复述）\n" + self.summary,
            })
        out.extend(self.verbatim)
        return out


# ==========================================================================
# 回复结果
# ==========================================================================
@dataclass
class LocalResponse:
    text: str = ""
    thinking: str = ""
    model: str = ""
    latency_ms: float = 0.0
    first_token_ms: float = 0.0
    degraded: bool = False
    error: Optional[str] = None
    memories: List[Dict[str, Any]] = field(default_factory=list)
    written: List[Dict[str, Any]] = field(default_factory=list)
    emotion_before: Dict[str, float] = field(default_factory=dict)
    emotion_after: Dict[str, float] = field(default_factory=dict)
    mood: str = ""
    prompt_chars: int = 0
    tokens: Dict[str, Any] = field(default_factory=dict)


# ==========================================================================
# 本地 Agent
# ==========================================================================
_FALLBACK_LINES = [
    "呜……未来现在好像连不上自己的声音了，稍等一下再跟我说话好不好？",
    "诶？未来的嗓子好像暂时出不来声音……等我一小会儿好吗？",
]


class LocalAgent:
    """Lv1：人格对话 + 情绪状态 + 流式输出 + 上下文管理。"""

    def __init__(self, store: MemoryStore, state: Optional[AgentState] = None,
                 logger: Optional[EventLogger] = None, session_id: Optional[str] = None):
        self.store = store
        self.state = state or AgentState()
        self.log = logger or get_logger()
        self.session_id = session_id or SETTINGS.session_id
        self.history = ConversationHistory(store, self.session_id,
                                           SETTINGS.history_window, SETTINGS.summary_trigger)
        self.model = SETTINGS.ollama_model
        self._client = None
        self.available = False
        self.availability_note = ""
        self._connect()

    # ---------------- 连接 ----------------
    def _connect(self) -> None:
        try:
            import ollama  # 延迟导入：没装也不影响其它模块
        except ImportError as exc:
            self.availability_note = f"未安装 ollama 库: {exc}"
            return
        try:
            # 显式给一个宽松的超时：首次请求要把 8GB 多的模型加载进显存，
            # 可能花 15~30 秒。用默认超时会直接超时失败（表现为 502），
            # 于是"第一次说话"永远得到一句道歉 —— 很难看，也很误导。
            try:
                self._client = ollama.Client(host=SETTINGS.ollama_host, timeout=300.0)
            except TypeError:
                self._client = ollama.Client(host=SETTINGS.ollama_host)
            models = self._client.list()
            names = []
            for m in (models.get("models") if isinstance(models, dict) else getattr(models, "models", [])) or []:
                name = m.get("name") if isinstance(m, dict) else getattr(m, "model", None) or getattr(m, "name", None)
                if name:
                    names.append(name)
            if self.model in names or any(n.split(":")[0] == self.model.split(":")[0] for n in names):
                self.available = True
                self.availability_note = f"已连接 {SETTINGS.ollama_host}，模型 {self.model} 就绪"
            else:
                self.availability_note = (f"Ollama 已连接，但没找到模型 {self.model}。"
                                          f"已有：{', '.join(names) or '无'}")
        except Exception as exc:
            self.availability_note = f"无法连接 Ollama（{SETTINGS.ollama_host}）: {type(exc).__name__}: {exc}"

    def warmup(self, turn: Optional[TurnContext] = None) -> bool:
        """把模型预先载入显存，别让第一次对话去承担冷启动的代价。

        冷启动可能 15~30 秒。放在启动阶段做完，用户说的第一句话就是快的，
        而且"Ollama 有问题"会在启动时就暴露，而不是在她开口时变成一句道歉。
        """
        if not self.available or self._client is None:
            return False
        t_log = turn or _NullTurn(self.log, turn.trace_id if turn else "")
        started = time.perf_counter()
        try:
            self._client.generate(model=self.model, prompt="你好", stream=False,
                                  options={"num_predict": 1}, keep_alive="30m")
            cost = (time.perf_counter() - started) * 1000
            t_log.log("llm.warmup", model=self.model, duration_ms=round(cost, 1),
                      note="模型已载入显存，后续首 token 会明显更快")
            return True
        except Exception as exc:
            t_log.log("llm.warmup_failed", level="warn",
                      error=f"{type(exc).__name__}: {exc}",
                      note="预热失败；首次回复可能会慢或失败")
            return False

    # ---------------- 上下文构建 ----------------
    def build_context(self, user_text: str, *, extra: str = "",
                      trace_id: str = "") -> Tuple[List[Dict[str, str]], Dict[str, Any]]:
        """构建本轮 Prompt：人设 + 关系 + 记忆 + 情绪 + 压缩摘要 + 近期对话。

        注意调用顺序：main 会**先**做本轮的记忆提取，再调用这里。
        因此"你刚告诉我你叫呱太"在这一轮的 `title` 里就已经生效了。
        """
        hits = self.store.recall(user_text, trace_id=trace_id)
        knows_name = self.store.has_name()
        title = self.store.user_title()      # 占位称呼来自配置，不是假设的名字

        system = build_system_prompt(
            emotion_block=build_emotion_block(self.state.snapshot(), user_title=title),
            memory_block=self.store.build_memory_block(hits),
            relation_block=self.state.relation_block(),
            extra=extra,
        )
        messages = [{"role": "system", "content": system}]
        messages.extend(self.history.prompt_messages())
        messages.append({"role": "user", "content": user_text})

        meta = {
            "memory_count": len(hits),
            "memory_hits": hits,
            "user_title": title,
            "knows_name": knows_name,
            "has_summary": bool(self.history.summary),
            "history_turns": len(self.history.verbatim) // 2,
            "prompt_chars": sum(len(m["content"]) for m in messages),
        }
        return messages, meta

    # ---------------- 流式生成 ----------------
    def _stream_chat(
        self,
        messages: List[Dict[str, str]],
        *,
        on_token: Optional[Callable[[str], None]] = None,
        on_thinking: Optional[Callable[[str], None]] = None,
        on_first_token: Optional[Callable[[float], None]] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        think: bool = True,
    ) -> Dict[str, Any]:
        """调用 Ollama 流式生成。返回累积的正文/思考/用量/延迟。

        think=True 时 R1 会先输出推理过程。注意推理也**占用 num_predict 预算**，
        所以对"把事实改写成一句话"这类不需要推理的任务要传 think=False，
        否则正文会被推理挤掉、出现截断。
        """
        if self._client is None:
            raise RuntimeError(self.availability_note or "Ollama 客户端不可用")

        options = {
            "temperature": SETTINGS.temperature if temperature is None else temperature,
            "top_p": SETTINGS.top_p,
            "num_predict": SETTINGS.max_tokens if max_tokens is None else max_tokens,
            "num_ctx": SETTINGS.ollama_num_ctx,
        }
        started = time.perf_counter()
        first_token_ms = 0.0
        content_parts: List[str] = []
        thinking_parts: List[str] = []
        usage: Dict[str, Any] = {}

        def _call(with_think: bool):
            kwargs: Dict[str, Any] = dict(model=self.model, messages=messages, stream=True,
                                          options=options, keep_alive="30m")
            if with_think is not None:
                kwargs["think"] = with_think
            return self._client.chat(**kwargs)

        def _open_stream():
            try:
                return _call(think)
            except Exception:
                # 模型或 SDK 版本不支持 think 参数时，完全不传该参数
                return _call(None)

        # 生成可能因为冷启动 / 瞬时 502 失败。若**还没有吐出任何内容**，
        # 就重试一次；已经吐出内容则不再重试（否则用户会看到重复输出）。
        last_error: Optional[Exception] = None
        for attempt in (1, 2):
            try:
                stream = _open_stream()
                for chunk in stream:
                    msg = (chunk.get("message") if isinstance(chunk, dict)
                           else getattr(chunk, "message", None))
                    if msg is None:
                        continue
                    get = ((lambda k: msg.get(k)) if isinstance(msg, dict)
                           else (lambda k: getattr(msg, k, None)))
                    piece = get("content") or ""
                    think_piece = get("thinking") or ""      # 注意别覆盖上面的 think 参数
                    if (piece or think_piece) and first_token_ms == 0.0:
                        first_token_ms = (time.perf_counter() - started) * 1000
                        if on_first_token:
                            on_first_token(first_token_ms)
                    if think_piece:
                        thinking_parts.append(think_piece)
                        if on_thinking:
                            on_thinking(think_piece)
                    if piece:
                        content_parts.append(piece)
                        if on_token:
                            on_token(piece)
                    done = (chunk.get("done") if isinstance(chunk, dict)
                            else getattr(chunk, "done", False))
                    if done:
                        for key in ("eval_count", "prompt_eval_count",
                                    "total_duration", "done_reason"):
                            val = (chunk.get(key) if isinstance(chunk, dict)
                                   else getattr(chunk, key, None))
                            if val is not None:
                                usage[key] = val
                last_error = None
                break
            except Exception as exc:
                last_error = exc
                if content_parts or thinking_parts:
                    break
                self.log.event("llm.retry", level="warn", model=self.model,
                               attempt=attempt, error=f"{type(exc).__name__}: {exc}",
                               note="生成失败且尚未产出内容，重试一次（冷启动或瞬时 502 常见）")
                if attempt == 1:
                    time.sleep(1.5)
        if last_error is not None:
            raise last_error

        return {
            "content": _strip_think("".join(content_parts)),
            "thinking": "".join(thinking_parts).strip(),
            "latency_ms": (time.perf_counter() - started) * 1000,
            "first_token_ms": first_token_ms,
            "tokens": usage,
        }

    # ---------------- 一轮完整交互 ----------------
    def respond(
        self,
        user_text: str,
        *,
        turn: Optional[TurnContext] = None,
        on_token: Optional[Callable[[str], None]] = None,
        on_thinking: Optional[Callable[[str], None]] = None,
        on_first_token: Optional[Callable[[float], None]] = None,
        extra: str = "",
        extract: bool = True,
    ) -> LocalResponse:
        """Lv1 主流程：检索记忆 → 构建上下文 → 流式生成 → 更新情绪 → 写记忆。

        extract=False 表示调用方（main）已经在生成之前完成过记忆提取，
        本轮不再重复提取 —— 这样"你刚告诉我名字"能当场生效，也避免重复写入。
        """
        trace_id = turn.trace_id if turn else ""
        t_log = turn or _NullTurn(self.log, trace_id)

        # 1) 上下文
        messages, meta = self.build_context(user_text, extra=extra, trace_id=trace_id)
        t_log.context_built(
            history_turns=meta["history_turns"],
            has_summary=meta["has_summary"],
            memory_count=meta["memory_count"],
            user_title=meta["user_title"],
            prompt_chars=meta["prompt_chars"],
        )
        t_log.llm("request", model=self.model, via="ollama",
                  messages=len(messages), prompt_chars=meta["prompt_chars"],
                  temperature=SETTINGS.temperature)

        resp = LocalResponse(model=self.model, memories=meta["memory_hits"],
                            prompt_chars=meta["prompt_chars"])

        # 2) 生成
        if not self.available:
            resp.degraded = True
            resp.error = self.availability_note
            resp.text = _FALLBACK_LINES[self.state.total_turns % len(_FALLBACK_LINES)]
            t_log.log("turn.error", level="error", error=self.availability_note,
                      degraded=True, fallback=resp.text)
            if on_token:
                on_token(resp.text)
        else:
            try:
                out = self._stream_chat(messages, on_token=on_token, on_thinking=on_thinking,
                                        on_first_token=on_first_token)
                resp.text = out["content"] or "……（未来张了张嘴，但这次什么都没有说出来）"
                resp.thinking = out["thinking"]
                resp.latency_ms = out["latency_ms"]
                resp.first_token_ms = out["first_token_ms"]
                resp.tokens = out["tokens"]
                if out["tokens"].get("done_reason") == "length":
                    trimmed = _trim_dangling(resp.text)
                    t_log.log("llm.truncated", level="warn",
                              max_tokens=SETTINGS.max_tokens,
                              raw_chars=len(resp.text), trimmed_chars=len(trimmed),
                              note="输出达到 num_predict 上限（R1 的推理也占预算），已裁掉不完整的尾句")
                    resp.text = trimmed
                t_log.llm("response", model=self.model, via="ollama",
                          latency_ms=round(resp.latency_ms, 1),
                          first_token_ms=round(resp.first_token_ms, 1),
                          tokens=out["tokens"], chars=len(resp.text),
                          thinking_chars=len(resp.thinking))
            except Exception as exc:
                resp.degraded = True
                resp.error = f"{type(exc).__name__}: {exc}"
                resp.text = _FALLBACK_LINES[self.state.total_turns % len(_FALLBACK_LINES)]
                t_log.log("turn.error", level="error", error=resp.error, degraded=True)
                if on_token:
                    on_token(resp.text)

        # 3) 更新内部状态（用户输入 + 自己的回复都算）
        self._update_emotion(user_text, resp.text, t_log, resp)

        # 4) 写入记忆、记录对话（extract=False 时 main 已经提前提取过了）
        self._after_turn(user_text, resp, t_log, extract=extract)

        # 5) 必要时压缩上下文
        self._maybe_compress(t_log)

        return resp

    # ---------------- revoice：工具结果的拟人化包装 ----------------
    def revoice(
        self,
        facts_block: str,
        user_text: str,
        *,
        turn: Optional[TurnContext] = None,
        on_token: Optional[Callable[[str], None]] = None,
        on_first_token: Optional[Callable[[float], None]] = None,
        action_note: str = "",
    ) -> LocalResponse:
        """把 API 查回来的**真实数据**包装成初音未来的语气（创新点）。

        关键设计：数据来自工具（真实行为），语言来自本地角色（人格）。
        两者在数据流上是分开的 —— 模型被明确要求**不得修改或新增数据**，
        因此"说自己做了什么"和"真的做了什么"不会混在一起。

        工程取舍：这里刻意**不用**完整的 build_context，而是给一个精简的
        任务提示（人设要点 + 当前心情 + 真实数据）。原因：
          - 事实已经全部提供，不需要记忆/历史，塞进去只会让 R1 想得更多；
          - R1 的推理过程占用 num_predict 预算，提示越长越容易想满预算、
            导致正文为空或被截断；
          - 这个任务是"改写语气"而不是"思考"，精简提示又快又稳。
        心情指令仍然注入，所以状态依然会影响她此刻的说话方式。
        """
        trace_id = turn.trace_id if turn else ""
        t_log = turn or _NullTurn(self.log, trace_id)

        mood = self.state.mood
        title = self.store.user_title()      # 知道名字就用名字，否则用配置的占位称呼
        addr = f"称呼用户为「{title}」" if title else "不需要特别的称呼"
        system = (
            "你是初音未来（Hatsune Miku），16 岁的虚拟歌姬。"
            f"性格元气、温柔、认真；{addr}，第一人称用「我」或「未来」；"
            "句尾可以自然地带 ♪，但不要每句都加。\n"
            f"你现在的状态是「{mood}」。{MOOD_DIRECTIVES.get(mood, '')}\n"
            "\n你刚刚**真的**执行了行动，下面是查询到的真实结果。"
            f"请用你自己的语气把这个结果告诉{title or '对方'}：\n"
            "- 直接说结果，不要打招呼、不要重复之前说过的话；\n"
            "- 总共不超过 2 句、60 字以内；\n"
            "- 数字必须与真实结果完全一致，一个字都不许改；\n"
            "- 不要出现 temp_c、humidity、observation_time 这类字段名；\n"
            "- 如果执行失败、或数据是模拟的，要如实说明并道歉。\n"
            "直接输出你要说的那 1~2 句话，不要输出分析过程、不要任何前缀。"
        )
        user_block = (
            f"对方的问题是：{user_text}\n\n"
            f"真实结果：\n{facts_block}"
            + (f"\n\n执行情况：{action_note}" if action_note else "")
        )
        messages = [{"role": "system", "content": system},
                    {"role": "user", "content": user_block}]

        t_log.context_built(mode="revoice", prompt_chars=len(system) + len(user_block),
                            mood=mood, history_turns=0, has_summary=False, memory_count=0)
        t_log.llm("request", model=self.model, via="ollama", mode="revoice",
                  prompt_chars=len(system) + len(user_block))

        resp = LocalResponse(model=self.model, prompt_chars=len(system) + len(user_block),
                            mood=mood)
        if not self.available:
            resp.degraded = True
            resp.error = self.availability_note
            resp.text = ""      # 由 main 回退到 API 的原始回答
            t_log.log("turn.error", level="error", error=self.availability_note, mode="revoice")
            return resp
        try:
            out = self._stream_chat(messages, on_token=on_token, on_first_token=on_first_token,
                                    temperature=max(0.3, SETTINGS.temperature - 0.3),
                                    max_tokens=500)
            text = out["content"]
            done = out["tokens"].get("done_reason")

            # R1 偶尔把预算全花在推理上，正文为空 —— 加大预算重试一次再放弃
            if not text:
                t_log.log("llm.empty_content", level="warn", mode="revoice",
                          thinking_chars=len(out["thinking"]),
                          note="正文为空（推理占满预算），加大预算重试一次")
                out = self._stream_chat(
                    messages, temperature=max(0.3, SETTINGS.temperature - 0.3),
                    max_tokens=1600)
                text = out["content"]
                done = out["tokens"].get("done_reason")

            if done == "length":
                trimmed = _trim_dangling(text)
                t_log.log("llm.truncated", level="warn", mode="revoice",
                          raw_chars=len(text), trimmed_chars=len(trimmed),
                          note="输出达到 num_predict 上限，已裁掉不完整的尾句")
                text = trimmed

            resp.text = text
            resp.thinking = out["thinking"]
            resp.latency_ms = out["latency_ms"]
            resp.first_token_ms = out["first_token_ms"]
            resp.tokens = out["tokens"]
            t_log.llm("response", model=self.model, via="ollama", mode="revoice",
                      latency_ms=round(resp.latency_ms, 1),
                      first_token_ms=round(resp.first_token_ms, 1),
                      chars=len(resp.text), tokens=out["tokens"])
            if not resp.text:
                t_log.log("llm.empty_content", level="warn", mode="revoice",
                          note="重试后正文仍为空，回退到 API 原始回答")
        except Exception as exc:
            resp.degraded = True
            resp.error = f"{type(exc).__name__}: {exc}"
            t_log.log("turn.error", level="error", error=resp.error, mode="revoice")
        return resp

    # ---------------- 情绪更新 ----------------
    def _update_emotion(self, user_text: str, reply_text: str,
                        turn: Any, resp: LocalResponse) -> None:
        before = dict(self.state.values)

        d_user, r_user = analyze_affect(user_text, weight=1.0)
        d_reply, r_reply = analyze_affect(reply_text, weight=0.4)   # 自己的语气也会反过来影响状态
        if "♪" in (reply_text or ""):
            d_reply["valence"] = d_reply.get("valence", 0.0) + 0.06
            d_reply["arousal"] = d_reply.get("arousal", 0.0) + 0.06
            r_reply.append("回复里带了 ♪（她在哼歌） → 心情+0.06, 活力+0.06")

        merged = {k: d_user.get(k, 0.0) + d_reply.get(k, 0.0) for k in EMOTION_DIMENSIONS}
        reasons = [f"[制作人] {r}" for r in r_user] + [f"[未来自己] {r}" for r in r_reply]
        if not reasons:
            reasons.append("这一轮情绪平稳，没有检测到明显的情感词")

        applied_before = self.state.apply(merged, reasons)
        self.state.total_turns += 1
        reasons.append(self.state.grow_bond())
        self.state.save()

        resp.emotion_before = {k: round(v, 4) for k, v in applied_before.items()}
        resp.emotion_after = {k: round(v, 4) for k, v in self.state.values.items()}
        resp.mood = self.state.mood
        turn.emotion(resp.emotion_before, resp.emotion_after, reasons)

    # ---------------- 记忆写入 ----------------
    def _after_turn(self, user_text: str, resp: LocalResponse, turn: Any,
                    extract: bool = True) -> None:
        """收尾：记录对话 + （可选）提取记忆。

        extract=False 用于 main 已经在**生成之前**完成提取的情况 ——
        那时再提取一次只会产生重复劳动，而且是在"她说完了"之后才知道本可以
        当场用上的信息，顺序就错了。
        """
        if extract:
            delta = {k: resp.emotion_after.get(k, 0.0) - resp.emotion_before.get(k, 0.0)
                     for k in resp.emotion_after}
            resp.written = self.store.extract_and_store(
                user_text, agent_text=resp.text, emotion_delta=delta,
                session_id=self.session_id, trace_id=turn.trace_id,
            )

        # 把这一轮记进对话表（重启后还能续上）
        self.store.record_turn(turn.turn, "user", user_text,
                               session_id=self.session_id, trace_id=turn.trace_id)
        self.store.record_turn(turn.turn, "assistant", resp.text,
                               session_id=self.session_id, trace_id=turn.trace_id)
        self.history.add("user", user_text)
        self.history.add("assistant", resp.text)

        if resp.written:
            turn.log("memory.extracted",
                     count=len(resp.written),
                     items=[{"op": w.get("op"), "content": w.get("content"),
                             "id": w.get("id")} for w in resp.written])

    # ---------------- 上下文压缩 ----------------
    def _maybe_compress(self, turn: Any) -> None:
        """更早的对话被挤出窗口后，总结成摘要再进入上下文，而不是丢掉。"""
        if not self.history.needs_compression():
            return
        transcript = self.history.compression_prompt()
        try:
            summary = self.summarize(transcript)
        except Exception as exc:
            turn.log("context.compress_failed", level="warn",
                     error=f"{type(exc).__name__}: {exc}")
            return
        if not summary:
            return
        covers_to = self.store.last_turn_index(session_id=self.session_id)
        merged = summary if not self.history.summary else f"{self.history.summary}\n{summary}"
        self.store.save_summary(merged, 0, covers_to, session_id=self.session_id,
                                trace_id=turn.trace_id)
        self.history.mark_compressed(merged, covers_to)
        turn.log("context.compressed", compressed_chars=len(transcript),
                 summary_chars=len(summary), summary=summary,
                 covers_to=covers_to)

    def summarize(self, text: str) -> str:
        """用本地模型做摘要（不花 API 的钱）。也用于记忆巩固。

        R1 有时会把整个 num_predict 预算花在推理上、导致正文为空，
        所以这里带一次"加大预算重试"，避免压缩因为一次空输出而静默失败。
        """
        if not self.available or not text.strip():
            return ""
        messages = [
            {"role": "system", "content":
                "你是一个对话摘要器。请把下面这段对话压缩成 2~3 句中文，只保留："
                "①对方的重要信息与偏好 ②未来答应过的事 ③情绪或关系的转折。"
                "**不要记录天气、时间、计算等一次性查询结果**，也不要记录寒暄。"
                "不要写评价，不要加标题，直接输出摘要本身。"},
            {"role": "user", "content": text[:6000]},
        ]
        return self._generate_text(messages, max_tokens=600, temperature=0.2)

    def _generate_text(self, messages: List[Dict[str, str]], *,
                       max_tokens: int = 500, temperature: float = 0.3) -> str:
        """生成纯文本（非流式）。正文为空时自动加大预算重试一次。

        这是针对 R1 的工程防护：即使 think=False 不被支持（该模型会返回 502），
        推理过程仍然占用 num_predict 预算，短预算下正文可能一个字都没有。
        """
        out = self._stream_chat(messages, temperature=temperature, max_tokens=max_tokens)
        text = _strip_think(out["content"]).strip()
        if text:
            return text
        self.log.event("llm.empty_retry", level="warn", model=self.model,
                       first_max_tokens=max_tokens, retry_max_tokens=max_tokens * 3,
                       thinking_chars=len(out["thinking"]))
        out = self._stream_chat(messages, temperature=temperature,
                                max_tokens=max_tokens * 3)
        return _strip_think(out["content"]).strip()

    # ---------------- 主动消息（创新点） ----------------
    def maybe_proactive_greeting(self, turn: Optional[TurnContext] = None) -> Optional[str]:
        """离开太久时，她会先开口 —— "怕寂寞"的性格变成真实行为。"""
        info = self.state.begin_session()
        t_log = turn or _NullTurn(self.log, turn.trace_id if turn else "")
        t_log.log("state.session_begin", absence_hours=info["absence_hours"],
                  wants_proactive=info["wants_proactive"], mood=info["mood"])
        if info["reasons"]:
            t_log.log("state.decay", reasons=info["reasons"])
        if not info["wants_proactive"]:
            return None

        idx = int(info["absence_hours"]) % len(PROACTIVE_GREETINGS)
        title = self.store.user_title()
        greeting = PROACTIVE_GREETINGS[idx].format(title=title or "你")

        # 顺手把"答应过的事"或最近的高权重记忆接上去，让主动开口有实感
        try:
            hits = self.store.recall("你答应过我的事 我们的回忆", top_k=2,
                                     kinds=["promise", "experience", "reflection"],
                                     trace_id=t_log.trace_id)
            if hits:
                hook = hits[0]["content"]
                greeting += f"\n（对了……{hook}，未来一直记着呢。）"
                t_log.log("state.proactive_hook", memory_id=hits[0]["id"],
                          content=hook, score=hits[0]["score"])
        except Exception:
            pass

        t_log.log("state.proactive_message", text=greeting,
                  absence_hours=info["absence_hours"], mood=self.state.mood)
        return greeting

    # ---------------- 吸收"外部产生"的一轮（Lv2 的 API 路径） ----------------
    def absorb_turn(
        self,
        user_text: str,
        reply_text: str,
        turn: Optional[TurnContext] = None,
        *,
        action_deltas: Optional[Dict[str, float]] = None,
        action_reasons: Optional[List[str]] = None,
        extract: bool = True,
    ) -> LocalResponse:
        """把一轮由 API 行动 + 本地包装产生的对话，并入角色的状态与记忆。

        路径 A（本地直接回答）由 respond() 内部完成这套动作；
        路径 B（API 查数据 → 本地包装）走这里，保证两条路径对状态与记忆的
        影响是**一致的** —— 不会出现"走了 API 就不长记忆、不变情绪"的漏洞。
        """
        trace_id = turn.trace_id if turn else ""
        t_log = turn or _NullTurn(self.log, trace_id)
        resp = LocalResponse(text=reply_text, model=f"{SETTINGS.ollama_model}+{SETTINGS.deepseek_model}")

        # 1) 语言与情绪：回复文本仍然影响她自己的状态
        self._update_emotion(user_text, reply_text, t_log, resp)

        # 2) 行动后果对状态的影响（题目开放问题 7：行动失败应影响角色状态）
        if action_deltas and any(abs(v) > 1e-9 for v in action_deltas.values()):
            before = dict(self.state.values)
            self.state.apply(action_deltas, action_reasons or [])
            self.state.save()
            t_log.log("emotion.action_impact",
                      deltas={k: round(v, 4) for k, v in action_deltas.items()},
                      reasons=action_reasons or [],
                      before={k: round(v, 4) for k, v in before.items()},
                      after={k: round(v, 4) for k, v in self.state.values.items()},
                      mood=self.state.mood)
            resp.emotion_after = {k: round(v, 4) for k, v in self.state.values.items()}
            resp.mood = self.state.mood

        # 3) 记忆与对话记录
        self._after_turn(user_text, resp, t_log, extract=extract)
        self._maybe_compress(t_log)
        return resp

    # ---------------- 供 Lv2 / Lv3 / Lv4 使用 ----------------
    def emotion_snapshot(self) -> Dict[str, Any]:
        """Lv3 的 Avatar / Lv4 的语音参数都消费这一份状态。"""
        return self.state.snapshot()

    def remember_action(self, tool: str, args: Any, result: Any,
                        *, ok: bool = True, trace_id: str = "") -> Dict[str, Any]:
        """工具结果要不要进入长期记忆？默认**不进**。

        题目开放问题「工具产生的结果是否值得进入长期记忆」的答案是：
        **取决于它会不会改变未来的行为。**
          - "我查过一次天气" —— 不会。明天的天气和今天无关，把它写进长期记忆
            只会让记忆库堆满流水账，还会在以后被检索出来挤占上下文。
            它已经完整地留在对话历史和审计日志里了，这就够了。
          - 真正值得记的是从查询里**推断出的稳定偏好**（"他在意西安的天气"），
            那类信息由 MEMORY_PATTERNS 从用户自己的话里提取，不靠工具结果硬塞。
        所以策略可配：none（默认）/ transient（存 1 天）/ always。
        """
        mode = (SETTINGS.remember_tool_results or "none").lower()
        if mode == "none":
            self.log.event("memory.tool_result_skipped", level="info",
                           trace_id=trace_id or None, tool=tool, ok=ok,
                           note="按 AGENT_REMEMBER_TOOL_RESULTS=none 不写入长期记忆"
                                "（已保留在对话历史与审计日志中）")
            return {}

        content = f"未来用 {tool} 帮对方查过一次（{'成功' if ok else '失败'}）：{_distill(result)}"
        weight = 0.25 if ok else 0.55      # 失败的经历情绪权重更高（更容易被记住）
        if mode == "transient":
            return self.store.remember(
                "transient", content, importance=0.2, confidence=0.9,
                emotional_weight=weight, source="tool_result", ttl_days=1.0,
                session_id=self.session_id, trace_id=trace_id,
                detail={"tool": tool, "ok": ok, "args": args},
            )
        return self.store.note_experience(
            content, kind="episode", emotional_weight=weight,
            session_id=self.session_id, trace_id=trace_id,
            detail={"tool": tool, "ok": ok, "args": args},
        )


class _NullTurn:
    """没有 TurnContext 时的空实现，保证 logger 调用永远安全。"""

    def __init__(self, logger: EventLogger, trace_id: str = ""):
        self._logger = logger
        self.trace_id = trace_id
        self.turn = 0

    def log(self, event: str, level: str = "info", **fields: Any) -> None:
        self._logger.event(event, level=level, trace_id=self.trace_id or None, **fields)

    def llm(self, phase: str, **f: Any) -> None:
        self.log(f"llm.{phase}", **f)

    def context_built(self, **f: Any) -> None:
        self.log("context.built", **f)

    def emotion(self, before: Dict[str, Any], after: Dict[str, Any], reasons: List[str]) -> None:
        self.log("emotion.update", before=before, after=after, reasons=reasons)


# --------------------------------------------------------------------------
# 自检：python local_agent.py
# --------------------------------------------------------------------------
if __name__ == "__main__":
    print("=== 情感分析自检（不需要模型，纯规则，可解释）===")
    cases = [
        "谢谢你！未来好厉害呀，我好喜欢你唱歌 ♪",
        "我今天好累，有点难过",
        "我不喜欢这首歌",
        "呜呜呜未来真可爱，别这样盯着我看啦",
        "你只是个程序而已，别装了",
        "现在几点了？",
    ]
    for text in cases:
        d, reasons = analyze_affect(text)
        mood = mood_from_state(0.35 + d["valence"], 0.55 + d["arousal"],
                               0.10 + d["bond"], 0.20 + d["loneliness"],
                               0.10 + d["shyness"], d["empathy"])
        print(f"\n  {text!r}")
        print(f"    delta={ {k: round(v, 3) for k, v in d.items() if v} }  -> 预计心情: {mood}")
        for r in reasons[:4]:
            print(f"      · {r}")

    print("\n=== 状态持久化自检 ===")
    from config import STATE_PATH as SP
    import tempfile
    tmp_state = Path(tempfile.gettempdir()) / "state_selftest.json"
    if tmp_state.exists():
        tmp_state.unlink()
    st = AgentState(tmp_state)
    print("  初始:", st.snapshot())
    st.apply({"valence": 0.3, "arousal": 0.2, "shyness": 0.5}, ["测试注入"])
    print("  注入后:", st.snapshot())
    print("  ", st.bar())
    st2 = AgentState(tmp_state)
    print("  重新载入（验证持久化）:", st2.snapshot()["mood"], st2.snapshot()["valence"])
    # 模拟离开 30 小时
    st2.last_seen = (datetime.now().astimezone() - timedelta(hours=30)).isoformat(timespec="seconds")
    st2.save()
    st3 = AgentState(tmp_state)
    info = st3.begin_session()
    print("  模拟离开 30 小时后:", info)
    print("  ", st3.bar())
    tmp_state.unlink(missing_ok=True)
