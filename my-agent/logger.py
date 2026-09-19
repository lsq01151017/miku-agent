"""
logger.py — 可观测性与审计（JSONL 事件流）
==========================================

题目要求（第 5 节）在一次交互之后，能大致回答：
  - Agent 使用了哪些上下文和记忆？      -> context.built / memory.recall
  - 内部状态是否发生变化？              -> emotion.update
  - 是否调用了工具，输入和结果是什么？  -> action.call / action.result
  - 最终产生了什么语言或行为？          -> speech.final
  - 某个决策为什么发生？                -> route.decision（带 matched / reason / score）

实现方式：每个"轮次(turn)"生成一个 trace_id，该轮内所有事件都带同一个
trace_id + 递增 seq，因此一次交互可以用 trace_id 完整重放。
JSONL 每行一个独立 JSON —— 可直接 grep、可被 jq / pandas 读取。
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

# 允许 `python logger.py` 直接运行自检
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import LOG_FILE, SETTINGS  # noqa: E402

_LEVEL_ORDER = {"debug": 10, "info": 20, "warn": 30, "error": 40}

# 不要把密钥写进日志
_SECRET_MARKERS = ("sk-", "api_key", "authorization", "bearer")


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


def _redact(value: Any) -> Any:
    """递归截断超长文本并屏蔽疑似密钥。"""
    if isinstance(value, str):
        low = value.lower()
        if any(m in low for m in _SECRET_MARKERS) and len(value) > 8:
            # 只可能是密钥或含密钥的文本，保留头尾
            return value[:6] + "...<redacted>" + value[-4:]
        return value if len(value) <= 4000 else value[:4000] + f"...<+{len(value) - 4000} chars>"
    if isinstance(value, dict):
        return {k: ("<redacted>" if "key" in str(k).lower() and "api" in str(k).lower() else _redact(v))
                for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_redact(v) for v in value]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return _redact(str(value))


class TurnContext:
    """一轮交互的事件写入句柄。由 EventLogger.turn() 产生。"""

    def __init__(self, logger: "EventLogger", trace_id: str, turn: int, session_id: str):
        self._logger = logger
        self.trace_id = trace_id
        self.turn = turn
        self.session_id = session_id
        self._seq = 0
        self._ended = False
        self.data: Dict[str, Any] = {}   # 本轮关键结论，供 main 汇总打印

    # --- 支持 `with logger.turn(...) as t:` 写法 ---
    def __enter__(self) -> "TurnContext":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        """保证一轮总有收尾事件：即使中途抛异常，trace 也是完整的。

        返回 False 表示不吞掉异常，交给上层处理。
        """
        if exc_type is not None:
            self.log("turn.error", level="error", error=f"{exc_type.__name__}: {exc}")
        if not self._ended:
            self.log("turn.end", note="由上下文管理器收尾")
        return False

    def log(self, event: str, level: str = "info", **fields: Any) -> Dict[str, Any]:
        self._seq += 1
        if event == "turn.end":
            self._ended = True
        record = {
            "ts": _now_iso(),
            "event": event,
            "level": level,
            "trace_id": self.trace_id,
            "turn": self.turn,
            "seq": self._seq,
            "session_id": self.session_id,
        }
        record.update({k: _redact(v) for k, v in fields.items()})
        self._logger.write(record)
        return record

    # --- 语义化快捷方法：保证事件名统一，便于审计 ---
    def user_input(self, text: str) -> None:
        self.log("turn.input", text=text, chars=len(text))

    def route(self, decision: Any) -> None:
        payload = decision.to_dict() if hasattr(decision, "to_dict") else dict(decision)
        self.log("route.decision", **payload)

    def context_built(self, **fields: Any) -> None:
        self.log("context.built", **fields)

    def memory_recall(self, hits: List[Dict[str, Any]], query: str) -> None:
        self.log(
            "memory.recall",
            query=query,
            hit_count=len(hits),
            hits=[
                {
                    "id": h.get("id"),
                    "kind": h.get("kind"),
                    "key": h.get("key"),
                    "content": h.get("content"),
                    "score": h.get("score"),
                    "score_breakdown": h.get("score_breakdown"),
                }
                for h in hits
            ],
        )

    def memory_write(self, op: str, **fields: Any) -> None:
        self.log(f"memory.{op}", **fields)

    def emotion(self, before: Dict[str, Any], after: Dict[str, Any], reasons: List[str]) -> None:
        self.log(
            "emotion.update",
            before=before,
            after=after,
            delta={k: round(after[k] - before[k], 4) for k in after if k in before},
            reasons=reasons,
        )

    def action_call(self, tool: str, args: Any, iteration: int = 1, side_effect: bool = False) -> None:
        self.log("action.call", tool=tool, args=args, iteration=iteration, side_effect=side_effect)

    def action_result(self, tool: str, result: Any, duration_ms: float, ok: bool = True) -> None:
        self.log(
            "action.result",
            tool=tool,
            ok=ok,
            duration_ms=round(duration_ms, 1),
            result=result,
        )

    def llm(self, phase: str, **fields: Any) -> None:
        self.log(f"llm.{phase}", **fields)

    def speech(self, text: str, **fields: Any) -> None:
        self.log("speech.final", text=text, chars=len(text), **fields)


class EventLogger:
    """JSONL 事件写入器。单进程内线程安全，每行 flush。"""

    def __init__(self, path: Path = LOG_FILE, min_level: str = "debug", echo: bool = False):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.min_level = _LEVEL_ORDER.get(min_level, 10)
        self.echo = echo
        self._lock = threading.Lock()
        self._turn_counter = self._infer_turn_counter()

    def _infer_turn_counter(self) -> int:
        """重启后接着已有日志的 turn 序号继续，避免序号回绕造成混淆。"""
        if not self.path.exists():
            return 0
        last = 0
        try:
            with self.path.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        last = max(last, int(json.loads(line).get("turn") or 0))
                    except (ValueError, json.JSONDecodeError):
                        continue
        except OSError:
            return 0
        return last

    @property
    def turn_count(self) -> int:
        return self._turn_counter

    def write(self, record: Dict[str, Any]) -> None:
        if _LEVEL_ORDER.get(record.get("level", "info"), 20) < self.min_level:
            return
        line = json.dumps(record, ensure_ascii=False, default=str)
        with self._lock:
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
                fh.flush()
        if self.echo:
            print(f"  [log] {record.get('event')} {json.dumps({k: v for k, v in record.items() if k not in ('ts','event','level','trace_id','turn','seq','session_id')}, ensure_ascii=False)[:200]}",
                  file=sys.stderr)

    def turn(self, session_id: str = "default") -> TurnContext:
        """开启一轮交互，返回带 trace_id 的写入句柄（配合 with 使用）。"""
        with self._lock:
            self._turn_counter += 1
            turn = self._turn_counter
        trace_id = uuid.uuid4().hex[:12]
        ctx = TurnContext(self, trace_id, turn, session_id)
        ctx.log("turn.start", session_id=session_id)
        return ctx

    def event(self, event: str, level: str = "info", **fields: Any) -> None:
        """不属于任何轮次的事件（启动、退出、异常）。"""
        self.write({"ts": _now_iso(), "event": event, "level": level, **{k: _redact(v) for k, v in fields.items()}})

    # ------------------------------------------------------------------
    # 读取 / 审计（"刚才究竟发生了什么？"）
    # ------------------------------------------------------------------
    def tail(self, n: int = 20, event_filter: Optional[str] = None) -> List[Dict[str, Any]]:
        if not self.path.exists():
            return []
        out: List[Dict[str, Any]] = []
        with self.path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event_filter and event_filter not in str(rec.get("event", "")):
                    continue
                out.append(rec)
        return out[-n:]

    def iter_trace(self, trace_id: str) -> Iterator[Dict[str, Any]]:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("trace_id") == trace_id:
                    yield rec

    def explain_trace(self, trace_id: str) -> str:
        """把一条 trace 还原成人类可读的审计报告。"""
        events = list(self.iter_trace(trace_id))
        if not events:
            return f"未找到 trace_id={trace_id} 的记录"

        lines: List[str] = [f"=== Trace {trace_id} 审计报告 ==="]
        tool_calls: List[str] = []
        for rec in events:
            ev = rec.get("event", "")
            if ev == "turn.start":
                lines.append(f"轮次 #{rec.get('turn')} 开始 @ {rec.get('ts')}")
            elif ev == "turn.input":
                lines.append(f"  用户输入: {rec.get('text')}")
            elif ev == "context.built":
                lines.append(
                    "  上下文: "
                    f"历史 {rec.get('history_turns')} 轮 / "
                    f"摘要 {rec.get('has_summary')} / "
                    f"注入记忆 {rec.get('memory_count')} 条 / "
                    f"prompt {rec.get('prompt_chars')} 字符"
                )
            elif ev == "memory.recall":
                lines.append(f"  记忆检索 \"{rec.get('query')}\" -> {rec.get('hit_count')} 条:")
                for h in rec.get("hits", []):
                    lines.append(f"      [{h.get('kind')}] {h.get('content')}  (score={h.get('score')})")
            elif ev.startswith("memory.") and ev != "memory.recall":
                lines.append(f"  记忆操作 {ev.split('.', 1)[1]}: {json.dumps({k: v for k, v in rec.items() if k not in ('ts','event','level','trace_id','turn','seq','session_id')}, ensure_ascii=False)[:300]}")
            elif ev == "route.decision":
                lines.append(
                    f"  路由决策: {rec.get('route')} (策略={rec.get('policy')}, "
                    f"置信={rec.get('confidence')}) 原因: {rec.get('reason')}"
                )
                if rec.get("matched"):
                    lines.append(f"      命中: {rec.get('matched')}")
            elif ev == "emotion.update":
                lines.append(
                    f"  情绪变化: {rec.get('before')} -> {rec.get('after')}"
                )
                for r in rec.get("reasons", []):
                    lines.append(f"      原因: {r}")
            elif ev == "action.call":
                entry = f"  行动调用 [{rec.get('iteration')}] {rec.get('tool')}({json.dumps(rec.get('args'), ensure_ascii=False)})"
                lines.append(entry)
                tool_calls.append(entry)
            elif ev == "action.result":
                lines.append(
                    f"  行动结果 {rec.get('tool')}: ok={rec.get('ok')} "
                    f"({rec.get('duration_ms')}ms) -> {json.dumps(rec.get('result'), ensure_ascii=False)[:300]}"
                )
            elif ev == "llm.request":
                lines.append(f"  模型请求: {rec.get('model')} (via {rec.get('via')})")
            elif ev == "llm.response":
                lines.append(
                    f"  模型返回: {rec.get('model')} 延迟 {rec.get('latency_ms')}ms"
                    + (f" tokens={rec.get('tokens')}" if rec.get("tokens") else "")
                    + (f" first_token={rec.get('first_token_ms')}ms" if rec.get("first_token_ms") else "")
                )
            elif ev == "speech.final":
                lines.append(f"  最终输出: {rec.get('text')}")
            elif ev == "turn.error":
                lines.append(f"  !! 错误: {rec.get('error')}")
        lines.append(f"--- 共 {len(events)} 条事件，其中真实工具调用 {len(tool_calls)} 次 ---")
        return "\n".join(lines)

    def stats(self) -> Dict[str, Any]:
        events = self.tail(10_000_000)
        by_event: Dict[str, int] = {}
        for rec in events:
            by_event[rec.get("event", "?")] = by_event.get(rec.get("event", "?"), 0) + 1
        return {
            "file": str(self.path),
            "total_events": len(events),
            "by_event": dict(sorted(by_event.items(), key=lambda kv: -kv[1])),
            "turns": max((r.get("turn", 0) or 0) for r in events) if events else 0,
        }


_LOGGER: Optional[EventLogger] = None


def get_logger() -> EventLogger:
    """全局单例。"""
    global _LOGGER
    if _LOGGER is None:
        _LOGGER = EventLogger(LOG_FILE, SETTINGS.log_level, SETTINGS.log_echo)
    return _LOGGER


# --------------------------------------------------------------------------
# 自检
# --------------------------------------------------------------------------
if __name__ == "__main__":
    log = get_logger()
    with log.turn("selftest") as t:
        t.user_input("西安今天天气怎么样？")
        t.log("route.decision", route="api", policy="keyword", confidence=0.9,
              reason="测试", matched={"weather": ["天气"]})
        t.action_call("get_weather", {"city": "西安"})
        t.action_result("get_weather", {"ok": True, "temp_c": 12}, 321.5)
        t.emotion({"valence": 0.1}, {"valence": 0.3}, ["用户语气友好"])
        t.speech("我去查了一下，西安今天 12 度。")
    print(log.explain_trace(t.trace_id))
    print("\nstats:", json.dumps(log.stats(), ensure_ascii=False, indent=2))
