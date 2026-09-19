"""
router.py — 路由判断（Lv2：什么时候该行动，什么时候只需回答）
=============================================================

题目 4.2：
  "Agent 能够判断什么时候仅仅需要回答，什么时候应该采取行动。"

这里的实现是一条**可插拔的策略链**，而不是一堆 if/else。
每条策略只回答"这一轮该不该由我处理"，谁先命中谁负责，
并且**每个决定都带 reason 与 matched 明细**，直接写进 JSONL ——
所以事后永远能回答"它当时为什么走了 API"。

策略顺序（先具体、后一般）：
  1. MemoryForgetPolicy   显式要求忘记 → 真实副作用（删记忆），但仍由角色开口回应
  2. MemoryWritePolicy    显式要求记住 → 真实副作用（写记忆）
  3. MemoryRecallPolicy   "你记得…吗" → 走本地，但注入检索到的记忆
  4. KeywordToolPolicy    天气/时间/计算等关键词 → 走 API 并指定工具
  5. MathExpressionPolicy 纯算式（"123*456"）→ 走 API 用 calculate
  6. SoftQueryPolicy      "帮我查一下…" → 走 API 但让模型自己挑工具
  7. FallbackPolicy       其余 → 走本地人格对话

Lv3 / Lv4 预留：想换成模型判断意图，只需往 chain 里插入一个
ModelIntentPolicy（见文件末尾），Router 本身不用改。
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import (  # noqa: E402
    KEYWORD_ROUTES,
    MATH_EXPRESSION_REGEX,
    MEMORY_INTENT_PATTERNS,
    MEMORY_PATTERNS,
    SETTINGS,
)

# 意图取值
INTENT_CHAT = "chat"
INTENT_TOOL = "tool"
INTENT_MEMORY_WRITE = "memory_write"
INTENT_MEMORY_FORGET = "memory_forget"
INTENT_MEMORY_RECALL = "memory_recall"


@dataclass
class RouteDecision:
    """一次路由决策的完整记录（可直接序列化进日志）。"""

    route: str                       # "local" | "api"
    intent: str                      # 上面那组 INTENT_*
    policy: str = ""                 # 命中的策略名
    reason: str = ""
    confidence: float = 0.0
    matched: Dict[str, Any] = field(default_factory=dict)
    required_tools: List[str] = field(default_factory=list)
    keyword_group: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "route": self.route,
            "intent": self.intent,
            "policy": self.policy,
            "reason": self.reason,
            "confidence": round(self.confidence, 3),
            "matched": self.matched,
            "required_tools": self.required_tools,
            "keyword_group": self.keyword_group,
        }


class RoutePolicy:
    """策略基类。evaluate 返回 None 表示"这一轮不归我管"。"""

    name = "base"
    priority = 100

    def evaluate(self, text: str, ctx: Dict[str, Any]) -> Optional[RouteDecision]:
        raise NotImplementedError


# ==========================================================================
# 1 / 2 / 3：记忆意图
# ==========================================================================
class MemoryForgetPolicy(RoutePolicy):
    """显式要求忘记 —— 这是有真实副作用的行为。"""

    name = "memory_forget"
    priority = 10

    def evaluate(self, text: str, ctx: Dict[str, Any]) -> Optional[RouteDecision]:
        hits = [kw for kw in MEMORY_INTENT_PATTERNS["forget"] if kw in text]
        if not hits:
            return None
        # "忘记" 也可能只是随口一说（如"别忘了我们的约定"），做一次轻量排除
        if re.search(r"(别|不要)(忘|忘记)", text):
            return None
        return RouteDecision(
            route="local", intent=INTENT_MEMORY_FORGET, policy=self.name,
            reason="用户明确要求忘记某事 → 需要真实删除记忆，再由角色回应",
            confidence=0.95, matched={"keywords": hits}, required_tools=[],
        )


class MemoryWritePolicy(RoutePolicy):
    """显式要求记住 —— 同样是真实副作用。"""

    name = "memory_write"
    priority = 20

    def evaluate(self, text: str, ctx: Dict[str, Any]) -> Optional[RouteDecision]:
        hits = [kw for kw in MEMORY_INTENT_PATTERNS["write"] if kw in text]
        if not hits:
            return None
        return RouteDecision(
            route="local", intent=INTENT_MEMORY_WRITE, policy=self.name,
            reason="用户明确要求记住某事 → 写入长期记忆，再由角色确认",
            confidence=0.95, matched={"keywords": hits}, required_tools=[],
        )


class MemoryRecallPolicy(RoutePolicy):
    """"你记得…吗" —— 走本地（人格），但会注入检索到的记忆。"""

    name = "memory_recall"
    priority = 30

    def evaluate(self, text: str, ctx: Dict[str, Any]) -> Optional[RouteDecision]:
        hits = [kw for kw in MEMORY_INTENT_PATTERNS["recall"] if kw in text]
        if not hits:
            return None
        return RouteDecision(
            route="local", intent=INTENT_MEMORY_RECALL, policy=self.name,
            reason="用户在考角色的记忆 → 走本地人格回答，并注入检索到的长期记忆",
            confidence=0.9, matched={"keywords": hits}, required_tools=[],
        )


# ==========================================================================
# 4：关键词 → 工具
# ==========================================================================
class KeywordToolPolicy(RoutePolicy):
    """关键词匹配（题目要求的第一层路由）。"""

    name = "keyword_tool"
    priority = 40

    # 在"聊创作话题"时不该误判成查天气：
    #   反例 ——「我今天在写一首关于下雨天的歌」命中了关键词「下雨」，
    #   但它显然不是在问天气。所以天气组要额外要求出现"真的在问"的信号。
    _TOPIC_MARKERS = [
        "写歌", "歌词", "写一首", "写首", "作曲", "旋律", "编曲", "关于", "主题",
        "故事", "小说", "诗", "比喻", "形容", "象征", "谈到", "聊聊", "讨论",
    ]
    _QUERY_MARKERS = [
        "怎么样", "如何", "查", "多少", "几度", "预报", "实时", "冷不冷",
        "热不热", "带伞", "会不会", "有没有", "℃", "度",
    ]

    def _looks_like_topic_talk(self, text: str) -> bool:
        has_topic = any(m in text for m in self._TOPIC_MARKERS)
        has_query = any(m in text for m in self._QUERY_MARKERS)
        return has_topic and not has_query

    def evaluate(self, text: str, ctx: Dict[str, Any]) -> Optional[RouteDecision]:
        topic_talk = self._looks_like_topic_talk(text)
        for group, spec in KEYWORD_ROUTES.items():
            hits = [kw for kw in spec["keywords"] if kw.lower() in text.lower()]
            if not hits:
                continue
            # 天气组最容易误伤（下雨/晴/雨天都可能是创作话题），故加一道闸
            if group == "weather" and topic_talk:
                ctx.setdefault("skipped", []).append(
                    f"weather 关键词 {hits} 命中，但整句像是在聊创作话题，判定为误匹配")
                continue
            return RouteDecision(
                route=spec["route"], intent=INTENT_TOOL, policy=self.name,
                reason=spec["reason"], confidence=min(0.95, 0.7 + 0.1 * len(hits)),
                matched={"keyword_group": group, "keywords": hits},
                required_tools=list(spec["tools"]), keyword_group=group,
            )
        return None


# ==========================================================================
# 5：纯算式
# ==========================================================================
class MathExpressionPolicy(RoutePolicy):
    """整句话就是一个算式（"123*456" / "sqrt(16)+2"）也应当去算，而不是聊。"""

    name = "math_expression"
    priority = 50

    # 只允许这些字符出现在表达式里 —— 比正则更直观地表达"这确实是一段算式"
    _ALLOWED_CHARS = set("0123456789+-*/%^()., _abcdefghijklmnopqrstuvwxyz")
    _OPERATORS = set("+-*/%^")
    _TAIL_NOISE = re.compile(
        r"(等于多少|是多少|等于几|得多少|等于|计算一下|算一下|是多少呢|呢|呀|吧|=|\?|？)\s*$")

    def evaluate(self, text: str, ctx: Dict[str, Any]) -> Optional[RouteDecision]:
        stripped = (text or "").strip().replace("×", "*").replace("÷", "/")
        stripped = self._TAIL_NOISE.sub("", stripped).strip()

        if not (3 <= len(stripped) <= 200):
            return None
        if "=" in stripped:                                   # 含等号的是方程描述，不是纯算式
            return None
        if any("\u4e00" <= ch <= "\u9fff" for ch in stripped):  # 还有中文 → 不是纯算式
            return None
        if not set(stripped) <= self._ALLOWED_CHARS:           # 出现奇怪符号 → 不接
            return None
        if not any(ch.isdigit() for ch in stripped):           # 必须含数字
            return None
        if not (set(stripped) & self._OPERATORS):              # 必须含运算符
            return None
        if not re.match(MATH_EXPRESSION_REGEX, stripped):      # 结构校验（开头形态）
            return None

        return RouteDecision(
            route="api", intent=INTENT_TOOL, policy=self.name,
            reason="输入本身就是数学表达式 → 交给 calculate 精确计算，不靠语言模型心算",
            confidence=0.85, matched={"expression": stripped},
            required_tools=["calculate"], keyword_group="calc",
        )


# ==========================================================================
# 6：软性查询（"帮我查一下…" 但没说是查什么）
# ==========================================================================
class SoftQueryPolicy(RoutePolicy):
    name = "soft_query"
    priority = 60

    _PATTERNS = [
        r"帮我(?:查|搜|看|找)一?下", r"能不能(?:查|搜)", r"你有办法(?:查|知道)",
        r"上网(?:查|搜)", r"实时(?:的)?(?:信息|数据|情况)", r"最新(?:的)?(?:消息|情况|数据)",
    ]

    def evaluate(self, text: str, ctx: Dict[str, Any]) -> Optional[RouteDecision]:
        for pat in self._PATTERNS:
            m = re.search(pat, text)
            if m:
                return RouteDecision(
                    route="api", intent=INTENT_TOOL, policy=self.name,
                    reason="用户要求查证现实信息 → 走 API，由模型自行选择合适的工具",
                    confidence=0.7, matched={"pattern": m.group(0)},
                    required_tools=[], keyword_group="soft",
                )
        return None


# ==========================================================================
# 7：让模型自己判断（不依赖任何预设词表）
# ==========================================================================
class ModelIntentPolicy(RoutePolicy):
    """把"这句话要不要采取行动"交给模型判断，而不是靠关键词表去猜。

    这是对"我不要预设"的回答：关键词表隐含了"用户会问什么"的假设，
    一旦没命中就只会聊天。这里让模型读一句话后自己回答 ACT / CHAT。

    代价是每轮多一次很便宜的 API 调用（几十个 token，约 0.5~1 秒）,
    所以默认只在**关键词快路径没命中时**才问它（见 Router 的 hybrid 模式）。
    想完全不要这个开销，把 AGENT_ROUTER_MODE 设成 keyword。
    """

    name = "model_intent"
    priority = 70          # 排在关键词策略之后、兜底之前

    def __init__(self, classifier=None, priority: int = 70):
        self.classifier = classifier
        self.priority = priority

    def evaluate(self, text: str, ctx: Dict[str, Any]) -> Optional[RouteDecision]:
        if self.classifier is None:
            return None                       # 未注入分类器（或 API 不可用）时静默跳过
        verdict = self.classifier(text)       # -> {"needs_action": bool, "raw": str} 或 None
        if not verdict:
            return None
        if verdict.get("needs_action"):
            return RouteDecision(
                route="api", intent=INTENT_TOOL, policy=self.name,
                reason="关键词没命中，改由模型判断；模型认为这句话需要查询真实信息或计算",
                confidence=0.6, matched={"model_verdict": verdict}, required_tools=[],
            )
        return RouteDecision(
            route="local", intent=INTENT_CHAT, policy=self.name,
            reason="关键词没命中，改由模型判断；模型认为这只是普通对话或关于角色自身的问题",
            confidence=0.7, matched={"model_verdict": verdict}, required_tools=[],
        )


# ==========================================================================
# 8：兜底 → 本地人格对话
# ==========================================================================
class FallbackPolicy(RoutePolicy):
    name = "fallback"
    priority = 999

    def evaluate(self, text: str, ctx: Dict[str, Any]) -> Optional[RouteDecision]:
        return RouteDecision(
            route="local", intent=INTENT_CHAT, policy=self.name,
            reason="没检测到需要真实行动或外部数据的意图 → 交回本地模型，保持人格连续",
            confidence=0.6, matched={"chars": len(text or "")}, required_tools=[],
        )


# ==========================================================================
# Router
# ==========================================================================
class Router:
    """把策略链跑一遍，返回第一个命中的决定。

    三种模式（AGENT_ROUTER_MODE）：
      keyword  纯关键词快路径，零 API 成本，但没命中就只会聊天
      hybrid   关键词快路径 + 未命中交给模型判断（默认）
      model    连快路径也不用，全部由模型判断（最不依赖预设，但每轮都有 API 调用）
    """

    def __init__(self, policies: Optional[Sequence[RoutePolicy]] = None,
                 mode: Optional[str] = None, intent_classifier=None):
        self.mode = (mode or SETTINGS.router_mode or "hybrid").lower()
        self.intent_classifier = intent_classifier

        if policies is not None:
            chain: List[RoutePolicy] = list(policies)
        else:
            # 记忆意图永远最先判（它们是显式指令，不能被模型判断覆盖）
            chain = [MemoryForgetPolicy(), MemoryWritePolicy(), MemoryRecallPolicy()]
            if self.mode == "model":
                chain.append(ModelIntentPolicy(intent_classifier, priority=35))
            elif self.mode == "keyword":
                chain += [KeywordToolPolicy(), MathExpressionPolicy(), SoftQueryPolicy()]
            else:      # hybrid
                chain += [KeywordToolPolicy(), MathExpressionPolicy(), SoftQueryPolicy(),
                          ModelIntentPolicy(intent_classifier, priority=70)]
            chain.append(FallbackPolicy())

        self.policies: List[RoutePolicy] = sorted(chain, key=lambda p: p.priority)
        self.decisions: List[RouteDecision] = []

    def add_policy(self, policy: RoutePolicy) -> None:
        """Lv3/Lv4 扩展点：插入自定义策略后自动重排优先级。"""
        self.policies.append(policy)
        self.policies.sort(key=lambda p: p.priority)

    def decide(self, text: str, ctx: Optional[Dict[str, Any]] = None) -> RouteDecision:
        ctx = ctx or {}
        for policy in self.policies:
            try:
                decision = policy.evaluate(text, ctx)
            except Exception as exc:      # 单条策略出错不应导致整体失败
                decision = None
                ctx.setdefault("policy_errors", []).append(f"{policy.name}: {exc}")
            if decision is not None:
                self.decisions.append(decision)
                return decision
        return RouteDecision(route="local", intent=INTENT_CHAT, policy="none",
                            reason="所有策略都未命中，默认走本地", confidence=0.3)

    def decide_and_log(self, text: str, turn: Any, ctx: Optional[Dict[str, Any]] = None) -> RouteDecision:
        decision = self.decide(text, ctx)
        if hasattr(turn, "route"):
            turn.route(decision)
        return decision

    def explain(self, text: str) -> str:
        """调试用：不实际路由，只展示每条策略的判断，方便讲清"为什么这样走"。"""
        lines = [f"输入: {text!r}", "策略链（按优先级）:"]
        for policy in self.policies:
            try:
                d = policy.evaluate(text, {})
            except Exception as exc:
                lines.append(f"  [{policy.priority:>3}] {policy.name:<18} 抛错 {exc}")
                continue
            if d is None:
                lines.append(f"  [{policy.priority:>3}] {policy.name:<18} 未命中")
            else:
                lines.append(f"  [{policy.priority:>3}] {policy.name:<18} ✓ 命中 → "
                             f"route={d.route} intent={d.intent} "
                             f"tools={d.required_tools or '-'} 置信={d.confidence:.2f}")
                lines.append(f"        理由: {d.reason}")
                lines.append(f"        依据: {d.matched}")
                break
        return "\n".join(lines)

    def stats(self) -> Dict[str, Any]:
        by_route: Dict[str, int] = {}
        by_policy: Dict[str, int] = {}
        for d in self.decisions:
            by_route[d.route] = by_route.get(d.route, 0) + 1
            by_policy[d.policy] = by_policy.get(d.policy, 0) + 1
        return {"total": len(self.decisions), "by_route": by_route, "by_policy": by_policy}


# ==========================================================================
# Lv3 / Lv4 预留：用模型判断意图（比关键词更鲁棒，但更慢更贵）
# ==========================================================================
class ModelIntentPolicy(RoutePolicy):
    """示例骨架：把"要不要行动"交给模型判断。

    启用方式（无需改 Router）：
        router.add_policy(ModelIntentPolicy(llm_call=my_llm_function, priority=35))
    建议放在 KeywordToolPolicy 之前、MemoryRecallPolicy 之后，
    这样显式记忆意图仍然优先，而模糊表达由模型兜住。

    也可以用 Embedding 做同类替换：把用户输入编码后与一组意图样本比较相似度，
    本质上只是换一个 score 来源，RouteDecision 的结构不用动。
    """

    name = "model_intent"
    priority = 35

    def __init__(self, llm_call=None, priority: int = 35):
        self.llm_call = llm_call
        self.priority = priority

    def evaluate(self, text: str, ctx: Dict[str, Any]) -> Optional[RouteDecision]:
        if self.llm_call is None:
            return None                      # 未注入实现时静默跳过
        # 真实实现大致如下（此处保留接口，避免 Lv1/Lv2 依赖额外模型调用）：
        #   label = self.llm_call("判断这句是否需要查询现实数据，只回答 yes/no", text)
        #   if label == "yes": return RouteDecision(route="api", intent=INTENT_TOOL, ...)
        return None


# --------------------------------------------------------------------------
# 自检：python router.py
# --------------------------------------------------------------------------
if __name__ == "__main__":
    router = Router()
    cases = [
        # 题目要求的 4 个验收用例
        "你好，你是谁？",
        "西安今天天气怎么样？",
        "现在几点了？",
        "你记得我叫什么吗？",
        # 其它情况
        "123*456 等于多少",
        "记住我下周要交作业",
        "忘记我喜欢咖啡这件事吧",
        "我有点难过，陪我说说话",
        "帮我查一下最近有什么新歌",
        "sqrt(144)+2**10 是多少？",
        "今天几号？",
        "你喜欢唱歌吗？",
    ]
    for text in cases:
        d = router.decide(text)
        print(f"{text!r:28s} -> route={d.route:5s} intent={d.intent:14s} "
              f"policy={d.policy:16s} tools={d.required_tools or '-'}")
        print(f"    理由: {d.reason}")
    print("\n=== 决策分布 ===")
    print(router.stats())
    print("\n=== explain 演示 ===")
    print(router.explain("西安今天天气怎么样？"))
