"""
memory.py — 记忆系统：存储、检索、覆盖修正、遗忘与衰减（Lv2 · Memory）
======================================================================

题目的重点不是"保存聊天记录"，而是：
  "Memory 是一个信息生命周期系统，而不仅仅是一个 Vector Database。"

所以这个模块刻意不引入向量库，而是把**生命周期**做扎实：

  写入 remember()
    ├─ slot 类记忆（identity / preference / relationship / fact / inference）
    │    同一个 key 只保留最新值 → 新信息**覆盖**旧信息（可修正，不累加矛盾）
    ├─ 完全相同的重复信息 → 只做"强化"（reinforce），不产生冗余行
    └─ 累积类记忆（experience / promise / self / episode）→ 多条共存

  检索 recall()
    ├─ 多信号打分：关键词 + 重要度 + **情绪加权** + 新近度 + 频次 + 种类先验
    ├─ 回忆意图提示：把"我叫什么"翻译成"去翻 user.name 槽位"
    ├─ 每条分数都带 breakdown → "为什么想起的是这条"永远可解释
    └─ 被想起会更新 last_accessed / access_count，并轻微强化重要度（回忆本身有作用）

  遗忘 / 失效
    ├─ forget()  显式遗忘（软删除，保留审计痕迹）
    ├─ 时间过期  expires_at 到期 → status=expired
    ├─ 衰减     按半衰期遗忘曲线降低重要度（艾宾浩斯式）
    └─ 归档     极低重要度的琐碎记忆自动退出检索池

  巩固 reflect()
    └─ 把若干轮零碎对话总结成一条高阶记忆（Generative Agents 的 reflection 思路）

存储：SQLite（memory.db，跨会话持久）+ 简单 JSON（对话历史与摘要的补充索引）。
所有生命周期操作都会写进 JSONL 审计日志。
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import (  # noqa: E402
    DB_PATH,
    KIND_PRIORS,
    MEMORY_CONFIG,
    MEMORY_EXTRACT_BLACKLIST,
    MEMORY_EXTRACT_REJECT_CONTENT,
    MEMORY_EXTRACT_REJECT_PHRASE,
    MEMORY_EXTRACT_REJECT_PREFIX,
    MEMORY_EXTRACT_REJECT_SUFFIX,
    MEMORY_KINDS,
    MEMORY_PATTERNS,
    QUERY_INTENT_HINTS,
    RECALL_WEIGHTS,
    SETTINGS,
    turn_emotional_intensity,
)

# 预先归一化"纯指代"黑名单，供 _plausible 做 O(1) 判断
_REJECT_CONTENT_NORMALIZED = {
    re.sub(r"[\s的了吧呢啊呀哦嘛，。,.！!？?、]+", "", item)
    for item in MEMORY_EXTRACT_REJECT_CONTENT
}
from logger import get_logger  # noqa: E402

# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------
_CJK_RUN = re.compile(r"[\u4e00-\u9fff]+")
_ASCII_WORD = re.compile(r"[A-Za-z0-9_]+")


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.now().astimezone().tzinfo)
    return dt


def days_between(later: datetime, earlier: datetime) -> float:
    return max(0.0, (later - earlier).total_seconds() / 86400.0)


def tokenize(text: str) -> Set[str]:
    """中文按字 bigram 切分，英文按词切分。

    不装分词库也能获得不错的模糊匹配：'制作人的名字' -> 制作/作人/人的/的名/名字。
    """
    if not text:
        return set()
    text = text.lower()
    tokens: Set[str] = set(_ASCII_WORD.findall(text))
    for run in _CJK_RUN.findall(text):
        if len(run) == 1:
            tokens.add(run)
        else:
            for i in range(len(run) - 1):
                tokens.add(run[i:i + 2])
    # 去掉过于泛化的单字与 bigram，降低噪声
    return {t for t in tokens if t not in _STOP_TOKENS}


_STOP_TOKENS = {
    "什么", "怎么", "这个", "那个", "一下", "可以", "现在", "就是", "还是",
    "我们", "你们", "他们", "自己", "时候", "如果", "因为", "所以", "但是",
    "的", "了", "是", "在", "我", "你", "他", "她", "它", "吗", "呢", "吧",
    "啊", "和", "与", "就", "都", "也", "很", "有", "没", "不", "要", "会",
}


# ==========================================================================
#  SQLite 存储
# ==========================================================================
_SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    kind              TEXT    NOT NULL,
    key               TEXT,
    subject           TEXT,
    content           TEXT    NOT NULL,
    detail            TEXT,
    importance        REAL    NOT NULL DEFAULT 0.5,
    confidence        REAL    NOT NULL DEFAULT 0.8,
    emotional_weight  REAL    NOT NULL DEFAULT 0.0,
    status            TEXT    NOT NULL DEFAULT 'active',
    superseded_by     INTEGER,
    superseded_from   INTEGER,
    source            TEXT    NOT NULL DEFAULT 'user_stated',
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL,
    last_accessed_at  TEXT,
    last_decay_at     TEXT,
    access_count      INTEGER NOT NULL DEFAULT 0,
    expires_at        TEXT,
    turn_ref          TEXT,
    session_id        TEXT
);
CREATE INDEX IF NOT EXISTS idx_mem_status  ON memories(status);
CREATE INDEX IF NOT EXISTS idx_mem_key     ON memories(key, status);
CREATE INDEX IF NOT EXISTS idx_mem_kind    ON memories(kind, status);
CREATE INDEX IF NOT EXISTS idx_mem_created ON memories(created_at);

-- 记忆生命周期事件（覆盖 / 遗忘 / 过期 / 强化），用于审计"记忆是怎么变的"
CREATE TABLE IF NOT EXISTS memory_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    op          TEXT NOT NULL,
    memory_id   INTEGER,
    kind        TEXT,
    key         TEXT,
    old_content TEXT,
    new_content TEXT,
    reason      TEXT,
    trace_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_mev_trace ON memory_events(trace_id);

-- 对话记录（跨会话保留，重启后仍能续上上下文）
CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    turn       INTEGER NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    trace_id   TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_id, id);

-- 上下文压缩后的摘要（历史太长时，旧对话被总结进这里）
CREATE TABLE IF NOT EXISTS session_summaries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    covers_from     INTEGER,
    covers_to       INTEGER,
    summary         TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    turn_ref        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sum_session ON session_summaries(session_id, id);
"""


class MemoryStore:
    """长期记忆 + 对话持久化的统一入口。"""

    def __init__(self, db_path: Path = DB_PATH, session_id: Optional[str] = None):
        self.db_path = Path(db_path)
        self.session_id = session_id or SETTINGS.session_id
        self._log = get_logger()
        self.conn = sqlite3.connect(str(self.db_path))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(_SCHEMA)
        self.conn.commit()

    # ------------------------------------------------------------------
    # 底层
    # ------------------------------------------------------------------
    def close(self) -> None:
        try:
            self.conn.commit()
            self.conn.close()
        except sqlite3.Error:
            pass

    def _event(self, op: str, *, memory_id: Optional[int] = None, kind: Optional[str] = None,
               key: Optional[str] = None, old: Optional[str] = None, new: Optional[str] = None,
               reason: str = "", trace_id: str = "") -> None:
        self.conn.execute(
            "INSERT INTO memory_events (ts, op, memory_id, kind, key, old_content, new_content, reason, trace_id)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (now_iso(), op, memory_id, kind, key, old, new, reason, trace_id),
        )
        self.conn.commit()
        # 同时写 JSONL，让 memory.* 事件和该轮的其它事件共享同一个 trace_id
        self._log.event(f"memory.{op}", level="info", trace_id=trace_id or None,
                        memory_id=memory_id, kind=kind, key=key,
                        old_content=old, new_content=new, reason=reason or None)

    @staticmethod
    def _row_to_dict(row: sqlite3.Row, score: Optional[float] = None,
                     breakdown: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
        d = dict(row)
        if d.get("detail"):
            try:
                d["detail"] = json.loads(d["detail"])
            except (json.JSONDecodeError, TypeError):
                pass
        if score is not None:
            d["score"] = round(score, 4)
        if breakdown is not None:
            d["score_breakdown"] = {k: round(v, 4) for k, v in breakdown.items()}
        return d

    def _kind_defaults(self, kind: str) -> Dict[str, Any]:
        return MEMORY_KINDS.get(kind, MEMORY_KINDS["fact"])

    # ==================================================================
    #  写入：存储 + 冲突处理（覆盖 / 强化）
    # ==================================================================
    def remember(
        self,
        kind: str,
        content: str,
        *,
        key: Optional[str] = None,
        subject: Optional[str] = None,
        importance: Optional[float] = None,
        confidence: Optional[float] = None,
        emotional_weight: float = 0.0,
        source: str = "user_stated",
        detail: Optional[Dict[str, Any]] = None,
        ttl_days: Optional[float] = None,
        session_id: Optional[str] = None,
        trace_id: str = "",
    ) -> Dict[str, Any]:
        """写入一条记忆，并按生命周期规则处理冲突。

        返回 {"id":.., "op": "insert"|"reinforce"|"supersede", ...}
        """
        content = (content or "").strip()
        if not content:
            return {"id": None, "op": "skip", "reason": "空内容"}

        defaults = self._kind_defaults(kind)
        subject = subject or defaults.get("subject", "world")
        imp = float(importance if importance is not None else defaults.get("default_importance", 0.5))
        conf = float(confidence if confidence is not None else defaults.get("default_confidence", 0.8))
        now = now_iso()
        session_id = session_id or self.session_id

        expires_at: Optional[str] = None
        ttl = ttl_days if ttl_days is not None else defaults.get("ttl_days")
        if ttl:
            expires_at = (datetime.now().astimezone() + timedelta(days=float(ttl))).isoformat(timespec="seconds")

        # ---------- 1. slot 类：同一 key 覆盖旧值 ----------
        if key and defaults.get("slot"):
            existing = self.conn.execute(
                "SELECT * FROM memories WHERE key=? AND status='active' ORDER BY id DESC LIMIT 1",
                (key,),
            ).fetchone()
            if existing:
                if self._same_content(existing["content"], content):
                    # 同一个事实再说一次 → 强化，不产生冗余行
                    self.conn.execute(
                        "UPDATE memories SET confidence=MIN(1.0, confidence+0.05),"
                        " importance=MIN(1.0, importance+0.03), updated_at=?,"
                        " last_accessed_at=?, access_count=access_count+1,"
                        " last_decay_at=?, turn_ref=? WHERE id=?",
                        (now, now, now, trace_id or existing["turn_ref"], existing["id"]),
                    )
                    self.conn.commit()
                    self._event("reinforce", memory_id=existing["id"], kind=kind, key=key,
                                new=content, reason="重复信息，强化而非新增", trace_id=trace_id)
                    return {"id": existing["id"], "op": "reinforce", "content": content}

                # 内容不同 → 覆盖：旧记忆标记 superseded，写入新记忆
                cur = self.conn.execute(
                    "INSERT INTO memories (kind,key,subject,content,detail,importance,confidence,"
                    "emotional_weight,status,source,created_at,updated_at,last_accessed_at,"
                    "last_decay_at,access_count,expires_at,turn_ref,session_id)"
                    " VALUES (?,?,?,?,?,?,?,?,'active',?,?,?,?,?,0,?,?,?)",
                    (kind, key, subject, content, json.dumps(detail, ensure_ascii=False) if detail else None,
                     imp, conf, emotional_weight, source, now, now, now, now,
                     expires_at, trace_id, session_id),
                )
                new_id = cur.lastrowid
                self.conn.execute(
                    "UPDATE memories SET status='superseded', superseded_by=?, updated_at=? WHERE id=?",
                    (new_id, now, existing["id"]),
                )
                self.conn.execute("UPDATE memories SET superseded_from=? WHERE id=?", (existing["id"], new_id))
                self.conn.commit()
                self._event("supersede", memory_id=new_id, kind=kind, key=key,
                            old=existing["content"], new=content,
                            reason="新信息与旧信息冲突，旧记忆标记为 superseded", trace_id=trace_id)
                return {"id": new_id, "op": "supersede", "superseded_id": existing["id"],
                        "old_content": existing["content"], "content": content}

        # ---------- 2. 完全相同内容去重（对所有 kind 生效）----------
        dup = self.conn.execute(
            "SELECT id, content FROM memories WHERE kind=? AND content=? AND status='active' LIMIT 1",
            (kind, content),
        ).fetchone()
        if dup:
            self.conn.execute(
                "UPDATE memories SET confidence=MIN(1.0, confidence+0.05), updated_at=?,"
                " last_accessed_at=?, access_count=access_count+1 WHERE id=?",
                (now, now, dup["id"]),
            )
            self.conn.commit()
            self._event("reinforce", memory_id=dup["id"], kind=kind, key=key,
                        new=content, reason="内容完全重复，强化", trace_id=trace_id)
            return {"id": dup["id"], "op": "reinforce", "content": content}

        # ---------- 3. 新记忆 ----------
        cur = self.conn.execute(
            "INSERT INTO memories (kind,key,subject,content,detail,importance,confidence,"
            "emotional_weight,status,source,created_at,updated_at,last_accessed_at,"
            "last_decay_at,access_count,expires_at,turn_ref,session_id)"
            " VALUES (?,?,?,?,?,?,?,?,'active',?,?,?,?,?,0,?,?,?)",
            (kind, key, subject, content, json.dumps(detail, ensure_ascii=False) if detail else None,
             imp, conf, emotional_weight, source, now, now, now, now,
             expires_at, trace_id, session_id),
        )
        new_id = cur.lastrowid
        self.conn.commit()
        self._event("write", memory_id=new_id, kind=kind, key=key, new=content,
                    reason=f"新增记忆（{defaults.get('desc', kind)}）", trace_id=trace_id)
        return {"id": new_id, "op": "insert", "content": content}

    @staticmethod
    def _same_content(a: str, b: str) -> bool:
        """判断两条记忆是否表达同一件事（容忍标点与空白差异）。"""
        norm = lambda s: re.sub(r"[\s，。,.！!？?、；;：:~～]+", "", (s or "")).lower()
        return norm(a) == norm(b)

    # ==================================================================
    #  检索：多信号打分 + 意图提示
    # ==================================================================
    def _candidates(self, kinds: Optional[Sequence[str]] = None) -> List[sqlite3.Row]:
        sql = "SELECT * FROM memories WHERE status='active'"
        params: List[Any] = []
        if kinds:
            sql += f" AND kind IN ({','.join('?' * len(kinds))})"
            params.extend(kinds)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(MEMORY_CONFIG["candidate_limit"])
        return list(self.conn.execute(sql, params))

    def _intent_hint(self, query: str) -> Optional[Dict[str, Any]]:
        for hint in QUERY_INTENT_HINTS:
            if re.search(hint["regex"], query or "", re.IGNORECASE):
                return hint
        return None

    def recall(
        self,
        query: str,
        *,
        top_k: Optional[int] = None,
        kinds: Optional[Sequence[str]] = None,
        trace_id: str = "",
        reinforce: bool = True,
    ) -> List[Dict[str, Any]]:
        """按当前上下文挑出值得重新进入思考的记忆。

        打分完全可解释，每一项都会写进 score_breakdown：
            score = w_kw*关键词 + w_imp*重要度 + w_emo*情绪加权
                  + w_rec*新近度 + w_freq*频次 + w_prior*种类先验  (+ 意图提示 bonus)
        """
        top_k = top_k or SETTINGS.recall_top_k
        now = datetime.now().astimezone()
        now_tokens = tokenize(query)
        hint = self._intent_hint(query)
        scored: List[Tuple[float, Dict[str, float], sqlite3.Row]] = []

        for row in self._candidates(kinds):
            # --- 过期检查（惰性失效）---
            exp = parse_iso(row["expires_at"])
            if exp and exp < now:
                self.conn.execute("UPDATE memories SET status='expired', updated_at=? WHERE id=?",
                                  (now_iso(), row["id"]))
                self._event("expire", memory_id=row["id"], kind=row["kind"], key=row["key"],
                            old=row["content"], reason="超过 expires_at，自动失效", trace_id=trace_id)
                continue

            mem_tokens = tokenize(row["content"])
            overlap = len(now_tokens & mem_tokens)
            kw = min(1.0, (overlap / math.sqrt(len(now_tokens))) / 2.0) if now_tokens else 0.0

            importance = float(row["importance"] or 0.0)
            emo = float(row["emotional_weight"] or 0.0)

            ref = parse_iso(row["last_accessed_at"]) or parse_iso(row["created_at"]) or now
            hl = max(0.5, float(self._kind_defaults(row["kind"]).get("halflife_days", 30.0)))
            recency = math.exp(-days_between(now, ref) / hl)

            freq = min(1.0, math.log1p(row["access_count"] or 0) / math.log1p(10))
            prior = KIND_PRIORS.get(row["kind"], 0.4)

            breakdown = {
                "keyword": RECALL_WEIGHTS["keyword"] * kw,
                "importance": RECALL_WEIGHTS["importance"] * importance,
                "emotional_weight": RECALL_WEIGHTS["emotional_weight"] * emo,
                "recency": RECALL_WEIGHTS["recency"] * recency,
                "frequency": RECALL_WEIGHTS["frequency"] * freq,
                "kind_prior": RECALL_WEIGHTS["kind_prior"] * prior,
                "intent_bonus": 0.0,
            }

            # 意图提示：把"问题"映射到"该翻哪一格记忆"
            if hint:
                hit = False
                if row["key"] and row["key"] in (hint.get("prefer_keys") or []):
                    hit = True
                if row["kind"] in (hint.get("prefer_kinds") or []):
                    hit = True
                if hit:
                    breakdown["intent_bonus"] = hint["bonus"]

            total = sum(breakdown.values())
            if total >= MEMORY_CONFIG["recall_min_score"] and (overlap > 0 or breakdown["intent_bonus"] > 0
                                                               or importance >= 0.75 or emo >= 0.5):
                scored.append((total, breakdown, row))

        scored.sort(key=lambda item: -item[0])

        # 种类配额：避免 6 条记忆全是同一种，保证回忆的多样性
        quota = MEMORY_CONFIG["recall_kind_quota"]
        per_kind: Dict[str, int] = {}
        picked: List[Dict[str, Any]] = []
        for total, breakdown, row in scored:
            k = row["kind"]
            if per_kind.get(k, 0) >= quota:
                continue
            per_kind[k] = per_kind.get(k, 0) + 1
            picked.append(self._row_to_dict(row, total, breakdown))
            if len(picked) >= top_k:
                break

        # 回忆本身会产生作用：更新访问时间、计数并轻微强化
        if picked and reinforce:
            ts = now_iso()
            for item in picked:
                self.conn.execute(
                    "UPDATE memories SET last_accessed_at=?, access_count=access_count+1,"
                    " importance=MIN(1.0, importance+0.02), last_decay_at=? WHERE id=?",
                    (ts, ts, item["id"]),
                )
            self.conn.commit()

        if hint:
            self._log.event("memory.recall_intent", trace_id=trace_id or None,
                            query=query, intent=hint["label"])
        self._log.event("memory.recall", trace_id=trace_id or None, query=query,
                        hit_count=len(picked),
                        hits=[{"id": p["id"], "kind": p["kind"], "key": p["key"],
                               "content": p["content"], "score": p["score"],
                               "score_breakdown": p["score_breakdown"]} for p in picked])
        return picked

    # ==================================================================
    #  遗忘 / 衰减 / 失效
    # ==================================================================
    def forget(
        self,
        *,
        key: Optional[str] = None,
        query: Optional[str] = None,
        memory_id: Optional[int] = None,
        kind: Optional[str] = None,
        reason: str = "用户要求忘记",
        trace_id: str = "",
        hard: bool = False,
    ) -> List[Dict[str, Any]]:
        """显式遗忘。默认软删除（status='forgotten'），保留可审计痕迹。

        注意搜索范围是**所有尚未遗忘的记忆**（含 superseded / archived）：
        用户说"忘记这件事"时，被覆盖过的旧版本也应该一起消失，
        否则"要求忘记"就只产生了半个效果。
        """
        rows: List[sqlite3.Row] = []
        if memory_id is not None:
            rows = list(self.conn.execute(
                "SELECT * FROM memories WHERE id=? AND status!='forgotten'", (memory_id,)))
        elif key:
            rows = list(self.conn.execute(
                "SELECT * FROM memories WHERE key=? AND status!='forgotten'", (key,)))
        elif query:
            tokens = tokenize(query)
            for row in self.conn.execute("SELECT * FROM memories WHERE status!='forgotten'"):
                if tokens & tokenize(row["content"]) or (row["key"] and query in row["key"]):
                    rows.append(row)
        elif kind:
            # 只给 kind 时表示"清掉这一类记忆"（例如清理某类噪声）
            rows = list(self.conn.execute(
                "SELECT * FROM memories WHERE kind=? AND status!='forgotten'", (kind,)))
        if kind:
            rows = [r for r in rows if r["kind"] == kind]

        forgotten: List[Dict[str, Any]] = []
        for row in rows:
            if hard:
                self.conn.execute("DELETE FROM memories WHERE id=?", (row["id"],))
            else:
                self.conn.execute("UPDATE memories SET status='forgotten', updated_at=? WHERE id=?",
                                  (now_iso(), row["id"]))
            forgotten.append({"id": row["id"], "kind": row["kind"], "key": row["key"],
                              "content": row["content"]})
            self._event("forget", memory_id=row["id"], kind=row["kind"], key=row["key"],
                        old=row["content"], reason=reason, trace_id=trace_id)
        self.conn.commit()
        return forgotten

    def forget_all(self, *, reason: str = "用户要求清空记忆", trace_id: str = "") -> int:
        rows = list(self.conn.execute("SELECT id FROM memories WHERE status='active'"))
        self.conn.execute("UPDATE memories SET status='forgotten', updated_at=? WHERE status='active'",
                          (now_iso(),))
        self.conn.commit()
        self._event("forget_all", reason=f"{reason}（共 {len(rows)} 条）", trace_id=trace_id)
        return len(rows)

    def decay(self, *, trace_id: str = "") -> Dict[str, int]:
        """按遗忘曲线衰减重要度，并让过期/琐碎记忆退出检索池。

        衰减从 last_decay_at 起算，因此多次运行不会重复扣分；
        被 recall() 访问过的记忆会把 last_decay_at 重置（相当于"复习巩固"）。
        """
        now = datetime.now().astimezone()
        expired = decayed = archived = 0

        for row in list(self.conn.execute("SELECT * FROM memories WHERE status='active'")):
            exp = parse_iso(row["expires_at"])
            if exp and exp < now:
                self.conn.execute("UPDATE memories SET status='expired', updated_at=? WHERE id=?",
                                  (now_iso(), row["id"]))
                self._event("expire", memory_id=row["id"], kind=row["kind"], key=row["key"],
                            old=row["content"], reason="超过 expires_at", trace_id=trace_id)
                expired += 1
                continue

            start = parse_iso(row["last_decay_at"]) or parse_iso(row["created_at"]) or now
            elapsed_days = days_between(now, start)
            hl = max(0.5, float(self._kind_defaults(row["kind"]).get("halflife_days", 30.0)))
            factor = 0.5 ** (elapsed_days / hl)
            if factor >= 0.999:
                continue

            new_imp = max(0.05, float(row["importance"]) * factor)
            self.conn.execute("UPDATE memories SET importance=?, last_decay_at=?, updated_at=? WHERE id=?",
                              (new_imp, now_iso(), now_iso(), row["id"]))
            decayed += 1
            self._event("decay", memory_id=row["id"], kind=row["kind"], key=row["key"],
                        old=f"importance={row['importance']:.3f}",
                        new=f"importance={new_imp:.3f}",
                        reason=f"半衰期 {hl:.0f} 天，经过 {elapsed_days:.1f} 天", trace_id=trace_id)

            # 琐碎且长期没人想起的记忆 → 归档退出检索池
            if new_imp < 0.08 and row["kind"] in ("episode", "transient", "inference", "dream"):
                self.conn.execute("UPDATE memories SET status='archived', updated_at=? WHERE id=?",
                                  (now_iso(), row["id"]))
                self._event("archive", memory_id=row["id"], kind=row["kind"], key=row["key"],
                            old=row["content"], reason="重要度衰减至阈值以下，归档", trace_id=trace_id)
                archived += 1
        self.conn.commit()
        return {"expired": expired, "decayed": decayed, "archived": archived}

    # ==================================================================
    #  从对话中提取记忆（"什么应该成为记忆"）
    # ==================================================================
    def extract_and_store(
        self,
        user_text: str,
        *,
        agent_text: str = "",
        emotion_delta: Optional[Dict[str, float]] = None,
        session_id: Optional[str] = None,
        trace_id: str = "",
    ) -> List[Dict[str, Any]]:
        """用规则模式从这一轮里抽出值得长期保留的信息。

        设计取舍：不为了提取再调一次模型（省时省钱、且完全可解释）。
        每条写入的记忆都会带上本轮的**情绪加权**，让"重感情"体现在数据里。
        """
        emotion_delta = emotion_delta or {}
        intensity = turn_emotional_intensity(emotion_delta, user_text)
        stored: List[Dict[str, Any]] = []

        for pattern in MEMORY_PATTERNS:
            for match in re.finditer(pattern["regex"], user_text):
                groups = match.groups()
                try:
                    # {0}=整段匹配, {1}=第1个捕获组, ...
                    content = pattern["template"].format(*([match.group(0)] + list(groups)))
                except (IndexError, KeyError):
                    content = match.group(0)
                captured = groups[0] if groups else ""
                if not self._plausible(captured, content):
                    continue
                res = self.remember(
                    pattern["kind"], content,
                    key=pattern.get("key"),
                    importance=pattern.get("importance"),
                    emotional_weight=intensity,
                    source="user_stated" if pattern["kind"] != "inference" else "inferred",
                    session_id=session_id, trace_id=trace_id,
                )
                if res.get("op") in ("insert", "supersede"):
                    stored.append(res)
                elif res.get("op") == "reinforce":
                    stored.append(res)
        return stored

    @staticmethod
    def _plausible(captured: str, content: str) -> bool:
        """过滤明显误匹配与"没有信息量"的捕获。

        这是规则提取的唯一"守门人"，判据刻意保守：
        - 黑名单单字/疑问词（谁、什么、哪里…）
        - 单字功能词开头（来、说、想…）—— 但**不含**常见名字开头字（可、小、明…）
        - 多字功能词开头（可以、因为、如果…）
        - 句子结尾助词（的、了、吗…）
        - **纯指代 / 空指涉**：如"我的名字""这件事"。
          「你要记住我的名字哦」不该变成一条记忆 —— 它没有携带任何事实。
        宁可漏记一条，也不要把垃圾写进长期记忆。
        """
        captured = (captured or "").strip()
        if not captured:
            return False
        if captured in MEMORY_EXTRACT_BLACKLIST:
            return False
        if any(captured.startswith(p) for p in MEMORY_EXTRACT_REJECT_PHRASE):
            return False
        if any(captured.startswith(p) for p in MEMORY_EXTRACT_REJECT_PREFIX) and len(captured) > 1:
            # 单字功能词开头：仅当它确实是功能词而非名字的一部分时才算误匹配。
            # "可可" 这类叠字名字（首字与次字相同）应当放行。
            if captured[0] != captured[1]:
                return False
        if any(captured.endswith(s) for s in MEMORY_EXTRACT_REJECT_SUFFIX):
            return False
        # 纯指代检测：去掉助词与语气词后若仍是空指涉，则丢弃
        normalized = re.sub(r"[\s的了吧呢啊呀哦嘛，。,.！!？?、]+", "", captured)
        if normalized in _REJECT_CONTENT_NORMALIZED:
            return False
        if len(captured) < 2 and not captured.isdigit():
            return False
        return True

    def note_experience(
        self,
        content: str,
        *,
        kind: str = "experience",
        emotional_weight: float = 0.3,
        session_id: Optional[str] = None,
        trace_id: str = "",
        detail: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """记录一条"经历"（例如真实执行过的工具调用结果）。"""
        return self.remember(kind, content, emotional_weight=emotional_weight,
                             source="tool_result" if kind == "episode" else "agent",
                             session_id=session_id, trace_id=trace_id, detail=detail)

    # ==================================================================
    #  记忆巩固（reflection）
    # ==================================================================
    def pending_reflection_turns(self, *, session_id: Optional[str] = None,
                                 min_turns: int = 8) -> List[sqlite3.Row]:
        """找出还没有被巩固进 reflection 的对话轮次。"""
        session_id = session_id or self.session_id
        last = self.conn.execute(
            "SELECT MAX(covers_to) AS m FROM session_summaries WHERE session_id=?", (session_id,)
        ).fetchone()
        after_turn = (last["m"] if last and last["m"] is not None else 0)
        rows = list(self.conn.execute(
            "SELECT * FROM conversations WHERE session_id=? AND turn>? ORDER BY id",
            (session_id, after_turn),
        ))
        return rows if len(rows) >= min_turns else []

    def reflect(
        self,
        summarizer: Callable[[str], str],
        *,
        session_id: Optional[str] = None,
        trace_id: str = "",
        min_turns: int = 8,
    ) -> Optional[Dict[str, Any]]:
        """记忆巩固：把零碎对话总结成一条高阶记忆。

        对应创新点「记忆巩固与反思」。用本地模型做总结（不花 API 的钱）。
        summarizer(text) -> str 由调用方注入，便于替换实现或测试。
        """
        rows = self.pending_reflection_turns(session_id=session_id, min_turns=min_turns)
        if not rows:
            return None
        session_id = session_id or self.session_id
        transcript = "\n".join(f"{'制作人' if r['role'] == 'user' else '未来'}：{r['content']}"
                               for r in rows)
        turns = [r["turn"] for r in rows]
        try:
            summary = (summarizer(transcript) or "").strip()
        except Exception as exc:
            self._event("reflect_failed", reason=f"{type(exc).__name__}: {exc}", trace_id=trace_id)
            return None
        if not summary:
            return None

        res = self.remember(
            "reflection", f"（回顾）{summary}",
            importance=0.75, confidence=0.8, emotional_weight=0.5,
            source="reflection", session_id=session_id, trace_id=trace_id,
            detail={"covers_from": min(turns), "covers_to": max(turns), "turn_count": len(rows)},
        )
        self.conn.execute(
            "INSERT INTO session_summaries (session_id, covers_from, covers_to, summary, created_at, turn_ref)"
            " VALUES (?,?,?,?,?,?)",
            (session_id, min(turns), max(turns), summary, now_iso(), trace_id),
        )
        self.conn.commit()
        self._event("reflect", memory_id=res.get("id"), kind="reflection",
                    new=summary, reason=f"巩固第 {min(turns)}~{max(turns)} 轮对话",
                    trace_id=trace_id)
        return {"id": res.get("id"), "summary": summary,
                "covers": [min(turns), max(turns)], "turn_count": len(rows)}

    # ==================================================================
    #  上下文压缩用的摘要存储
    # ==================================================================
    def save_summary(self, summary: str, covers_from: int, covers_to: int,
                     *, session_id: Optional[str] = None, trace_id: str = "") -> None:
        self.conn.execute(
            "INSERT INTO session_summaries (session_id, covers_from, covers_to, summary, created_at, turn_ref)"
            " VALUES (?,?,?,?,?,?)",
            (session_id or self.session_id, covers_from, covers_to, summary, now_iso(), trace_id),
        )
        self.conn.commit()

    def latest_summary(self, *, session_id: Optional[str] = None) -> Optional[str]:
        row = self.conn.execute(
            "SELECT summary FROM session_summaries WHERE session_id=? ORDER BY id DESC LIMIT 1",
            (session_id or self.session_id,),
        ).fetchone()
        return row["summary"] if row else None

    # ==================================================================
    #  对话持久化（跨会话连续性）
    # ==================================================================
    def record_turn(self, turn: int, role: str, content: str, *,
                    session_id: Optional[str] = None, trace_id: str = "") -> None:
        self.conn.execute(
            "INSERT INTO conversations (session_id, turn, role, content, trace_id, created_at)"
            " VALUES (?,?,?,?,?,?)",
            (session_id or self.session_id, turn, role, content, trace_id, now_iso()),
        )
        self.conn.commit()

    def recent_history(self, *, session_id: Optional[str] = None, limit: int = 40) -> List[Dict[str, str]]:
        """重启后重建对话历史，让角色记得"上次聊到哪"。"""
        rows = self.conn.execute(
            "SELECT role, content FROM conversations WHERE session_id=? ORDER BY id DESC LIMIT ?",
            (session_id or self.session_id, limit),
        ).fetchall()
        return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]

    def last_turn_index(self, *, session_id: Optional[str] = None) -> int:
        row = self.conn.execute(
            "SELECT MAX(turn) AS m FROM conversations WHERE session_id=?",
            (session_id or self.session_id,),
        ).fetchone()
        return int(row["m"] or 0)

    # ==================================================================
    #  供 Prompt 使用 / 供界面查看
    # ==================================================================
    def build_memory_block(self, hits: Sequence[Dict[str, Any]]) -> str:
        """把检索结果渲染成注入 System Prompt 的文本。"""
        if not hits:
            return ""
        lines: List[str] = []
        for h in hits:
            content = h.get("content", "")
            detail = h.get("detail") or {}
            if h.get("kind") == "promise" and isinstance(detail, dict):
                status = detail.get("status", "pending")
                mark = {"pending": "（还没做到）", "kept": "（已经兑现）", "broken": "（没能做到）"}.get(status, "")
                content += mark
            lines.append(f"- {content}")
        return "\n".join(lines)

    def has_name(self) -> bool:
        """是否已经真的被告知过对方的名字（绝不假设、绝不预设）。"""
        row = self.conn.execute(
            "SELECT 1 FROM memories WHERE key='user.name' AND status='active' LIMIT 1"
        ).fetchone()
        return row is not None

    def user_title(self, default: Optional[str] = None) -> str:
        """取出对用户的称呼：知道名字就用名字，否则用配置里的**占位称呼**。

        注意：占位称呼不是"假设的名字"，它只是一个还没有名字时的临时叫法，
        并且会在 Prompt 里明确告诉角色"你还不知道他的名字，这次先问一下"。
        """
        fallback = default if default is not None else SETTINGS.user_title_fallback
        if not fallback:
            return ""
        row = self.conn.execute(
            "SELECT content FROM memories WHERE key='user.name' AND status='active' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if not row:
            return fallback
        m = re.search(r"(?:名字是|是|叫)\s*([^\s，。,.！!？?]{1,12})", row["content"])
        return m.group(1) if m else fallback

    def list_active(self, *, limit: int = 30, kinds: Optional[Sequence[str]] = None) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM memories WHERE status='active'"
        params: List[Any] = []
        if kinds:
            sql += f" AND kind IN ({','.join('?' * len(kinds))})"
            params.extend(kinds)
        sql += " ORDER BY importance DESC, id DESC LIMIT ?"
        params.append(limit)
        return [self._row_to_dict(r) for r in self.conn.execute(sql, params)]

    def timeline(self, *, limit: int = 40) -> List[Dict[str, Any]]:
        """记忆生命周期事件流（谁被覆盖、谁被遗忘、什么时候衰减）。"""
        rows = self.conn.execute(
            "SELECT * FROM memory_events ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    def stats(self) -> Dict[str, Any]:
        by_status = {r["status"]: r["c"] for r in self.conn.execute(
            "SELECT status, COUNT(*) AS c FROM memories GROUP BY status")}
        by_kind = {r["kind"]: r["c"] for r in self.conn.execute(
            "SELECT kind, COUNT(*) AS c FROM memories WHERE status='active' GROUP BY kind")}
        return {
            "db": str(self.db_path),
            "total": sum(by_status.values()),
            "by_status": by_status,
            "active_by_kind": by_kind,
            "conversation_turns": self.conn.execute(
                "SELECT COUNT(*) AS c FROM conversations").fetchone()["c"],
            "summaries": self.conn.execute(
                "SELECT COUNT(*) AS c FROM session_summaries").fetchone()["c"],
            "computed_at": now_iso(),
        }


# --------------------------------------------------------------------------
# 自检：python memory.py
# --------------------------------------------------------------------------
if __name__ == "__main__":
    import tempfile

    tmp_db = Path(tempfile.gettempdir()) / "memory_selftest.db"
    if tmp_db.exists():
        tmp_db.unlink()
    store = MemoryStore(tmp_db, session_id="selftest")

    print("=== 1. 写入与覆盖修正 ===")
    print(store.remember("identity", "制作人的名字是可可", key="user.name", trace_id="t1"))
    print(store.remember("identity", "制作人的名字是可可", key="user.name", trace_id="t1"), "  <- 重复 -> reinforce")
    print(store.remember("identity", "制作人的名字是小满", key="user.name", trace_id="t2"), "  <- 冲突 -> supersede")
    print(store.remember("preference", "制作人喜欢喝咖啡", key="user.like", trace_id="t2"))

    print("\n=== 2. 规则提取 ===")
    for text in ["我叫可可", "我叫小满", "我喜欢下雨天", "记住我下周要交作业",
                 "我答应你下次唱新歌给你听", "我今天好累", "我是来问题目的"]:
        got = store.extract_and_store(text, emotion_delta={"valence": -0.2, "arousal": 0.3}, trace_id="t3")
        ops = [(g.get("op"), g.get("content")) for g in got]
        print(f"  {text!r:22s} -> {ops}")

    print("\n=== 3. 检索（意图提示）===")
    for q in ["你记得我叫什么吗？", "我喜欢什么？", "你答应过我什么？"]:
        hits = store.recall(q, trace_id="t4")
        print(f"\n  Q: {q}")
        for h in hits:
            print(f"    [{h['kind']:11s}] {h['content']}  score={h['score']} {h['score_breakdown']}")

    print("\n=== 4. 遗忘（应能连被覆盖的旧版本一起忘掉）===")
    print("  遗忘前 memory_events 里的 preference：",
          [m["content"] for m in store.list_active(kinds=["preference"])])
    gone = store.forget(query="咖啡", reason="用户说不再喝咖啡了", trace_id="t5")
    print("  实际遗忘：", [(g["content"], g["kind"]) for g in gone])
    print("  遗忘后再检索 '咖啡':", [h["content"] for h in store.recall("咖啡", trace_id="t5")])

    print("\n=== 5. 衰减（把时钟拨回 400 天）===")
    before = {m["id"]: (m["kind"], m["importance"]) for m in store.list_active(limit=50)}
    old = (datetime.now().astimezone() - timedelta(days=400)).isoformat(timespec="seconds")
    store.conn.execute("UPDATE memories SET last_decay_at=?, last_accessed_at=? WHERE status='active'",
                       (old, old))
    store.conn.commit()
    print("  decay:", store.decay(trace_id="t6"))
    after = {m["id"]: (m["kind"], m["importance"]) for m in store.list_active(limit=50)}
    for mid, (kind, imp_before) in before.items():
        if mid in after:
            imp_after = after[mid][1]
            if abs(imp_after - imp_before) > 1e-6:
                print(f"    id={mid} {kind:11s} importance {imp_before:.3f} -> {imp_after:.3f}")

    print("\n=== 6. 记忆巩固（reflection）===")
    for i in range(1, 10):
        store.record_turn(i, "user" if i % 2 else "assistant",
                          f"第{i}轮：我们在聊写歌的事", trace_id="t7")
    res = store.reflect(lambda t: "制作人和未来一起讨论了写新歌的事，气氛很开心。", trace_id="t7")
    print(" ", res)

    print("\n=== 7. 状态总览 ===")
    print(json.dumps(store.stats(), ensure_ascii=False, indent=2))
    print("\n=== 8. 生命周期事件 ===")
    for e in store.timeline(limit=12):
        print(f"  {e['op']:12s} kind={e['kind']} key={e['key']} reason={e['reason']}")
    store.close()
    tmp_db.unlink(missing_ok=True)
