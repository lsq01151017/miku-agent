"""
tools.py — 工具定义与注册表（Lv2 · Action）
===========================================

题目 4.2 的关键要求：
  "系统还应该能够区分『说自己做了某件事』和『真正执行了某个行为』。
   换句话说：语言输出和系统行为应该是两个可以区分的概念。"

因此这里每个工具返回的是**结构化 ToolResult**，其中带：
  - ok / error        : 是否真的成功
  - data              : 真实返回的数据
  - source            : 数据来源（wttr.in / open-meteo / mock / computed）
  - executed_at       : 真实执行时间
  - duration_ms       : 真实耗时
  - side_effect       : 该行为是否改变了外部世界

当数据源不可用时，工具会**明确降级**并把 source 标为 "mock"，
而不是让模型凭语言假装查过了 —— 这样"说过"和"做过"在数据层面就是可分的。

工具清单（题目要求的 3 个示例）：
  1. get_weather       获取天气（真实 HTTP，多数据源级联降级）
  2. get_current_time  获取当前时间（系统时钟，支持有限时区）
  3. calculate         计算数学表达式（AST 安全求值，不使用 eval）

Lv3/Lv4 预留：ToolSpec 已带 side_effect / requires_confirmation 字段，
新增带副作用的工具（写文件、下单、发消息）只需注册时置位，
调度器会走确认流程；见文件末尾 EXPANSION 说明。
"""

from __future__ import annotations

import ast
import hashlib
import json
import math
import operator
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from config import SETTINGS  # noqa: E402


# ==========================================================================
# 数据结构
# ==========================================================================
@dataclass
class ToolResult:
    """一次真实行动的结果。语言层不得修改 ok / source / data 的语义。"""

    tool: str
    ok: bool
    data: Any = None
    error: Optional[str] = None
    source: str = "unknown"
    duration_ms: float = 0.0
    side_effect: bool = False
    executed_at: str = ""

    def __post_init__(self) -> None:
        if not self.executed_at:
            self.executed_at = datetime.now().astimezone().isoformat(timespec="seconds")

    def to_dict(self) -> Dict[str, Any]:
        return {
            "tool": self.tool,
            "ok": self.ok,
            "data": self.data,
            "error": self.error,
            "source": self.source,
            "duration_ms": round(self.duration_ms, 1),
            "side_effect": self.side_effect,
            "executed_at": self.executed_at,
        }

    def to_tool_message(self) -> str:
        """回传给云端模型的工具结果（必须是字符串）。"""
        return json.dumps(self.to_dict(), ensure_ascii=False)


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: Dict[str, Any]
    func: Callable[..., ToolResult]
    side_effect: bool = False
    requires_confirmation: bool = False

    def to_openai_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


# ==========================================================================
# 工具 1：当前时间
# ==========================================================================
# Windows 上的 Python 3.10 默认不带 IANA 时区库（需要额外装 tzdata），
# 所以这里先尝试 zoneinfo，失败则退回到内置偏移表，再退回本机本地时间。
_TZ_OFFSETS: Dict[str, float] = {
    "asia/shanghai": 8.0, "asia/chongqing": 8.0, "asia/hong_kong": 8.0,
    "asia/tokyo": 9.0, "asia/seoul": 9.0, "asia/singapore": 8.0,
    "asia/kolkata": 5.5, "asia/dubai": 4.0, "europe/london": 0.0,
    "europe/paris": 1.0, "europe/berlin": 1.0, "europe/moscow": 3.0,
    "america/new_york": -5.0, "america/los_angeles": -8.0,
    "america/chicago": -6.0, "australia/sydney": 10.0, "utc": 0.0, "gmt": 0.0,
}
_WEEKDAY_CN = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]


def _resolve_now(tz_name: str) -> tuple[datetime, str]:
    """返回 (带时区的当前时间, 实际使用的时区描述)。"""
    tz_name = (tz_name or "local").strip()
    if tz_name.lower() in ("local", "", "本机", "本地"):
        return datetime.now().astimezone(), "本机时区"

    try:  # 首选真正的 IANA 时区
        from zoneinfo import ZoneInfo  # noqa: PLC0415

        return datetime.now(ZoneInfo(tz_name)), tz_name
    except Exception:
        pass

    key = tz_name.lower()
    if key in _TZ_OFFSETS:
        hours = _TZ_OFFSETS[key]
        return datetime.now(timezone(timedelta(hours=hours))), f"{tz_name} (UTC{hours:+g})"

    # 最后兜底：本机时间，并如实说明降级
    return datetime.now().astimezone(), f"本机时区（无法识别 {tz_name!r}，已降级）"


def get_current_time(timezone_name: str = "local") -> ToolResult:
    start = time.perf_counter()
    try:
        now, tz_desc = _resolve_now(timezone_name)
        data = {
            "datetime": now.isoformat(timespec="seconds"),
            "date": now.strftime("%Y-%m-%d"),
            "time": now.strftime("%H:%M:%S"),
            "weekday": _WEEKDAY_CN[now.weekday()],
            "timezone": tz_desc,
            "timestamp": int(now.timestamp()),
            "human": f"{now.strftime('%Y年%m月%d日')} {_WEEKDAY_CN[now.weekday()]} {now.strftime('%H:%M:%S')}",
        }
        return ToolResult(
            tool="get_current_time",
            ok=True,
            data=data,
            source="system_clock",
            duration_ms=(time.perf_counter() - start) * 1000,
        )
    except Exception as exc:  # pragma: no cover
        return ToolResult(
            tool="get_current_time",
            ok=False,
            error=f"{type(exc).__name__}: {exc}",
            duration_ms=(time.perf_counter() - start) * 1000,
        )


# ==========================================================================
# 工具 2：天气
# ==========================================================================
_WMO_CODE_CN: Dict[int, str] = {
    0: "晴", 1: "晴间多云", 2: "多云", 3: "阴", 45: "有雾", 48: "雾凇",
    51: "毛毛雨", 53: "小雨", 55: "中雨", 56: "冻毛毛雨", 57: "冻雨",
    61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "强冻雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒", 80: "阵雨",
    81: "强阵雨", 82: "暴雨", 85: "阵雪", 86: "强阵雪",
    95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "强雷暴伴冰雹",
}


def _weather_wttr(city: str, timeout: int) -> Dict[str, Any]:
    """数据源 1：wttr.in（JSON 接口，中英城市名都支持）。"""
    import requests  # 延迟导入，避免影响启动速度

    url = f"https://wttr.in/{city}"
    resp = requests.get(
        url,
        params={"format": "j1", "lang": "zh"},
        timeout=(5, timeout),
        headers={"User-Agent": "heart-heart-heart-agent/1.0"},
    )
    resp.raise_for_status()
    payload = resp.json()
    cur = payload["current_condition"][0]
    today = payload["weather"][0]
    area = payload.get("nearest_area", [{}])[0]
    area_name = ""
    if area.get("areaName"):
        area_name = area["areaName"][0].get("value", "")
    desc = cur.get("weatherDesc", [{}])[0].get("value", "")
    if desc and all(ord(ch) < 128 for ch in desc):  # wttr 有时不返回中文
        lang = cur.get("lang_zh", [{}])
        if lang and lang[0].get("value"):
            desc = lang[0]["value"]
    return {
        "city": area_name or city,
        "condition": desc,
        "temp_c": float(cur["temp_C"]),
        "feels_like_c": float(cur["FeelsLikeC"]),
        "humidity": int(cur["humidity"]),
        "wind_kmph": float(cur["windspeedKmph"]),
        "temp_min_c": float(today["mintempC"]),
        "temp_max_c": float(today["maxtempC"]),
        "observation_time": cur.get("localObsDateTime", ""),
    }


def _weather_open_meteo(city: str, timeout: int) -> Dict[str, Any]:
    """数据源 2：Open-Meteo（免费、无需 key）。"""
    import requests

    geo = requests.get(
        "https://geocoding-api.open-meteo.com/v1/search",
        params={"name": city, "count": 1, "language": "zh", "format": "json"},
        timeout=(5, timeout),
    )
    geo.raise_for_status()
    results = geo.json().get("results") or []
    if not results:
        raise ValueError(f"找不到城市 {city!r}")
    loc = results[0]

    fc = requests.get(
        "https://api.open-meteo.com/v1/forecast",
        params={
            "latitude": loc["latitude"],
            "longitude": loc["longitude"],
            "current": "temperature_2m,relative_humidity_2m,apparent_temperature,"
                       "weather_code,wind_speed_10m",
            "daily": "temperature_2m_max,temperature_2m_min",
            "timezone": "auto",
            "forecast_days": 1,
        },
        timeout=(5, timeout),
    )
    fc.raise_for_status()
    data = fc.json()
    cur = data["current"]
    daily = data["daily"]
    return {
        "city": loc.get("name", city),
        "condition": _WMO_CODE_CN.get(int(cur.get("weather_code", -1)), "未知"),
        "temp_c": float(cur["temperature_2m"]),
        "feels_like_c": float(cur.get("apparent_temperature", cur["temperature_2m"])),
        "humidity": int(cur.get("relative_humidity_2m", 0)),
        "wind_kmph": float(cur.get("wind_speed_10m", 0)),
        "temp_min_c": float(daily["temperature_2m_min"][0]),
        "temp_max_c": float(daily["temperature_2m_max"][0]),
        "observation_time": cur.get("time", ""),
    }


def _weather_mock(city: str) -> Dict[str, Any]:
    """数据源 3：离线模拟。**明确标注 mock**，绝不冒充真实数据。

    用 city + 日期做确定性哈希，保证同一天同一城市结果稳定（便于复现与测试）。
    """
    seed = hashlib.sha256(f"{city}:{datetime.now().strftime('%Y-%m-%d')}".encode()).hexdigest()
    n = int(seed[:8], 16)
    base = 8 + (n % 22)                       # 8 ~ 29 度
    conds = ["晴", "多云", "阴", "小雨", "阵雨", "雾"]
    return {
        "city": city,
        "condition": conds[n % len(conds)],
        "temp_c": float(base),
        "feels_like_c": float(base - 1 + (n % 3)),
        "humidity": 40 + (n % 50),
        "wind_kmph": float(3 + (n % 20)),
        "temp_min_c": float(base - 4),
        "temp_max_c": float(base + 4),
        "observation_time": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "note": "离线模拟数据，非真实天气（所有真实数据源均不可达）",
    }


def get_weather(city: str, days: int = 1) -> ToolResult:
    """查询城市天气。按 wttr.in -> Open-Meteo -> mock 的顺序降级，并如实记录来源。"""
    start = time.perf_counter()
    city = (city or "").strip()
    if not city:
        return ToolResult(tool="get_weather", ok=False, error="缺少参数 city",
                          duration_ms=(time.perf_counter() - start) * 1000)

    timeout = SETTINGS.weather_timeout
    errors: List[str] = []
    for source_name, fetcher in (("wttr.in", _weather_wttr), ("open-meteo", _weather_open_meteo)):
        try:
            data = fetcher(city, timeout)
            data["days"] = max(1, int(days or 1))
            return ToolResult(
                tool="get_weather", ok=True, data=data, source=source_name,
                duration_ms=(time.perf_counter() - start) * 1000,
            )
        except Exception as exc:
            errors.append(f"{source_name}: {type(exc).__name__}: {exc}")

    # 全部真实数据源失败 -> 明确降级，不假装成功
    data = _weather_mock(city)
    data["days"] = max(1, int(days or 1))
    return ToolResult(
        tool="get_weather", ok=True, data=data, source="mock",
        error="; ".join(errors) or None,
        duration_ms=(time.perf_counter() - start) * 1000,
    )


# ==========================================================================
# 工具 3：计算
# ==========================================================================
_ALLOWED_BINOPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod, ast.Pow: operator.pow,
}
_ALLOWED_UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_ALLOWED_FUNCS: Dict[str, Callable[..., Any]] = {
    "abs": abs, "round": round, "min": min, "max": max, "sum": sum,
    "sqrt": math.sqrt, "pow": math.pow, "log": math.log, "log10": math.log10,
    "log2": math.log2, "exp": math.exp, "sin": math.sin, "cos": math.cos,
    "tan": math.tan, "asin": math.asin, "acos": math.acos, "atan": math.atan,
    "atan2": math.atan2, "floor": math.floor, "ceil": math.ceil,
    "factorial": math.factorial, "gcd": math.gcd, "hypot": math.hypot,
    "degrees": math.degrees, "radians": math.radians,
}
_ALLOWED_NAMES: Dict[str, float] = {"pi": math.pi, "e": math.e, "tau": math.tau}

_MAX_EXPR_LEN = 300


def _eval_node(node: ast.AST) -> Any:
    """对 AST 做白名单求值。不使用 eval()，杜绝任意代码执行。"""
    if isinstance(node, ast.Expression):
        return _eval_node(node.body)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            return node.value
        raise ValueError(f"不支持的常量类型: {type(node.value).__name__}")
    if isinstance(node, ast.BinOp):
        op = _ALLOWED_BINOPS.get(type(node.op))
        if op is None:
            raise ValueError(f"不支持的运算符: {type(node.op).__name__}")
        left, right = _eval_node(node.left), _eval_node(node.right)
        if isinstance(node.op, ast.Pow) and abs(right) > 1000:
            raise ValueError("指数过大，已拒绝（防止卡死）")
        return op(left, right)
    if isinstance(node, ast.UnaryOp):
        op = _ALLOWED_UNARY.get(type(node.op))
        if op is None:
            raise ValueError(f"不支持的一元运算符: {type(node.op).__name__}")
        return op(_eval_node(node.operand))
    if isinstance(node, ast.Name):
        if node.id in _ALLOWED_NAMES:
            return _ALLOWED_NAMES[node.id]
        raise ValueError(f"未知标识符: {node.id}")
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in _ALLOWED_FUNCS:
            raise ValueError("只允许调用白名单数学函数")
        if node.keywords:
            raise ValueError("不支持关键字参数")
        return _ALLOWED_FUNCS[node.func.id](*[_eval_node(a) for a in node.args])
    if isinstance(node, (ast.List, ast.Tuple)):
        return [_eval_node(e) for e in node.elts]
    raise ValueError(f"不支持的语法: {type(node).__name__}")


def calculate(expression: str) -> ToolResult:
    """安全计算数学表达式，例如 '(15+7)*3/2'、'sqrt(144)+2**10'。"""
    start = time.perf_counter()
    expr = (expression or "").strip()
    if not expr:
        return ToolResult(tool="calculate", ok=False, error="缺少参数 expression",
                          duration_ms=(time.perf_counter() - start) * 1000)
    if len(expr) > _MAX_EXPR_LEN:
        return ToolResult(tool="calculate", ok=False,
                          error=f"表达式过长（>{_MAX_EXPR_LEN} 字符）",
                          duration_ms=(time.perf_counter() - start) * 1000)

    # 常见中文/全角符号归一化，方便模型或用户直接粘贴
    normalized = (expr.replace("×", "*").replace("÷", "/").replace("^", "**")
                      .replace("（", "(").replace("）", ")").replace("，", ",")
                      .replace("％", "%").replace(" ", ""))
    try:
        tree = ast.parse(normalized, mode="eval")
        value = _eval_node(tree)
        if isinstance(value, float):
            if value != value or value in (float("inf"), float("-inf")):
                raise ValueError("结果不是有限数值")
            if abs(value - round(value)) < 1e-12:
                value = int(round(value))
            else:
                value = round(value, 12)
        return ToolResult(
            tool="calculate", ok=True,
            data={"expression": expr, "normalized": normalized, "result": value},
            source="computed",
            duration_ms=(time.perf_counter() - start) * 1000,
        )
    except Exception as exc:
        return ToolResult(
            tool="calculate", ok=False,
            error=f"{type(exc).__name__}: {exc}",
            data={"expression": expr},
            duration_ms=(time.perf_counter() - start) * 1000,
        )


# ==========================================================================
# 注册表
# ==========================================================================
class ToolRegistry:
    """工具的注册、schema 导出与统一调用入口（含计时与错误封装）。"""

    def __init__(self) -> None:
        self._tools: Dict[str, ToolSpec] = {}
        self.call_count = 0

    def register(self, spec: ToolSpec) -> None:
        self._tools[spec.name] = spec

    def get(self, name: str) -> Optional[ToolSpec]:
        return self._tools.get(name)

    def names(self) -> List[str]:
        return list(self._tools)

    def specs(self) -> List[ToolSpec]:
        return list(self._tools.values())

    def schemas(self) -> List[Dict[str, Any]]:
        """OpenAI / DeepSeek tool-calling 格式。"""
        return [spec.to_openai_schema() for spec in self._tools.values()]

    def describe(self) -> str:
        lines = []
        for spec in self._tools.values():
            flag = " [有副作用]" if spec.side_effect else ""
            lines.append(f"  - {spec.name}{flag}: {spec.description.splitlines()[0]}")
        return "\n".join(lines)

    def dispatch(self, name: str, args: Any, allow_side_effects: Optional[bool] = None) -> ToolResult:
        """执行工具。args 可以是 dict 或 JSON 字符串（模型返回的形式）。

        永远返回 ToolResult，不抛异常 —— 让上层（api_agent）能把失败也回传给模型，
        从而体现"行动失败也是真实结果"。
        """
        started = time.perf_counter()
        spec = self._tools.get(name)
        if spec is None:
            return ToolResult(tool=name, ok=False,
                              error=f"未知工具: {name}（可用: {', '.join(self._tools)}）",
                              duration_ms=(time.perf_counter() - started) * 1000)

        if isinstance(args, str):
            try:
                args = json.loads(args) if args.strip() else {}
            except json.JSONDecodeError as exc:
                return ToolResult(tool=name, ok=False,
                                  error=f"参数不是合法 JSON: {exc}", source="parse_error",
                                  duration_ms=(time.perf_counter() - started) * 1000)
        if not isinstance(args, dict):
            return ToolResult(tool=name, ok=False, error="参数必须是 JSON 对象",
                              duration_ms=(time.perf_counter() - started) * 1000)

        # Lv3 预留：带副作用的工具默认拒绝执行，需上层显式放行或走确认流程
        permit = SETTINGS.allow_side_effects if allow_side_effects is None else allow_side_effects
        if spec.side_effect and not permit:
            return ToolResult(
                tool=name, ok=False, side_effect=True,
                error="该工具具有副作用，当前策略要求先获得确认（AGENT_ALLOW_SIDE_EFFECTS=false）",
                duration_ms=(time.perf_counter() - started) * 1000,
            )

        self.call_count += 1
        try:
            result = spec.func(**args)
            if not isinstance(result, ToolResult):
                result = ToolResult(tool=name, ok=True, data=result, source="function")
            result.side_effect = spec.side_effect
            return result
        except TypeError as exc:
            return ToolResult(tool=name, ok=False,
                              error=f"参数不匹配: {exc}",
                              duration_ms=(time.perf_counter() - started) * 1000)
        except Exception as exc:
            return ToolResult(tool=name, ok=False,
                              error=f"{type(exc).__name__}: {exc}",
                              duration_ms=(time.perf_counter() - started) * 1000)


def build_default_registry() -> ToolRegistry:
    reg = ToolRegistry()
    reg.register(ToolSpec(
        name="get_weather",
        description=(
            "查询指定城市的实时天气与今日气温区间。当用户询问天气、气温、是否下雨、"
            "冷热、空气质量等现实世界信息时使用。城市名用中文或英文均可。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "城市名称，例如 西安 / Beijing"},
                "days": {"type": "integer", "description": "预报天数，默认 1", "default": 1},
            },
            "required": ["city"],
        },
        func=get_weather,
    ))
    reg.register(ToolSpec(
        name="get_current_time",
        description=(
            "读取系统当前的真实日期与时间。当用户询问现在几点、今天几号、"
            "星期几，或需要以当前时间为基准做推算时使用。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "timezone_name": {
                    "type": "string",
                    "description": "时区名，例如 Asia/Shanghai；默认 local 表示本机时区",
                    "default": "local",
                }
            },
            "required": [],
        },
        func=get_current_time,
    ))
    reg.register(ToolSpec(
        name="calculate",
        description=(
            "精确计算数学表达式。当用户要求做算术、百分比、开方、乘方等计算时使用，"
            "不要自己心算。支持 + - * / // % ** 与 sqrt/log/sin/cos 等函数。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "expression": {
                    "type": "string",
                    "description": "数学表达式，例如 (15+7)*3/2 或 sqrt(144)+2**10",
                }
            },
            "required": ["expression"],
        },
        func=calculate,
    ))
    return reg


# ==========================================================================
# Lv3 / Lv4 扩展说明
# ==========================================================================
EXPANSION = """
新增工具只需三步（无需改动 api_agent / main）：
  1. 写一个返回 ToolResult 的函数；
  2. registry.register(ToolSpec(name=..., description=..., parameters=<JSON Schema>,
                                func=..., side_effect=True, requires_confirmation=True));
  3. schemas() 会自动把新工具暴露给 deepseek-flash 做 tool calling。

带副作用的工具（写文件、下单、发消息）会因 AGENT_ALLOW_SIDE_EFFECTS=false
被 dispatch() 拦截，返回"需要确认"的失败结果 —— 这就是
"具有副作用的操作是否应该要求确认"这一开放问题的当前答案。
要做成真正的交互式确认，在 api_agent 的 tool-call 循环里插入
一个 confirm(name, args) -> bool 回调即可（预留位置见 api_agent.py）。
"""


# --------------------------------------------------------------------------
# 自检：python tools.py
# --------------------------------------------------------------------------
if __name__ == "__main__":
    registry = build_default_registry()
    print("已注册工具:")
    print(registry.describe())
    print("\n--- 计算 ---")
    for expr in ["(15+7)*3/2", "sqrt(144)+2**10", "100*1.13", "1/0", "import os"]:
        print(f"  {expr!r} -> {json.dumps(registry.dispatch('calculate', {'expression': expr}).to_dict(), ensure_ascii=False)}")
    print("\n--- 时间 ---")
    print(json.dumps(registry.dispatch("get_current_time", {}).to_dict(), ensure_ascii=False, indent=2))
    print(json.dumps(registry.dispatch("get_current_time", {"timezone_name": "Asia/Shanghai"}).to_dict(), ensure_ascii=False))
    print("\n--- 天气（真实网络，失败会自动降级为 mock）---")
    print(json.dumps(registry.dispatch("get_weather", {"city": "西安"}).to_dict(), ensure_ascii=False, indent=2))
    print("\n--- 未知工具 ---")
    print(json.dumps(registry.dispatch("nope", {}).to_dict(), ensure_ascii=False))
