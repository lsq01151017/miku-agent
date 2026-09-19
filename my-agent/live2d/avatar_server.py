"""
live2d/avatar_server.py — Live2D 表现层服务（Lv3）
=================================================

作用：把 Agent 的**内部状态**变成能看见的表情和动作。

题目 Lv3 的要求：
  "重点不在模型精度、动画数量或者画面效果，而在于：Agent 的内部状态能否
   通过身体表现出来。……我们关注的是 Avatar 是否真正成为 Agent 状态的一种
   输出，而不是一个独立播放动画的前端组件。"

所以这个模块**不自己维护任何状态** —— 它只是把 local_agent 的 AgentState
（心情/活力/羁绊/寂寞/害羞/关切）以及"正在思考/正在说话/正在调用工具"
翻译成表情名，推给浏览器。前端只负责画，不负责想。

技术选择（为什么不用 npm / 构建工具）：
  - 只用 Python 标准库（http.server），零额外依赖，不需要打包步骤；
  - 静态资源 + Server-Sent Events（SSE）单向推流，够用且极简；
  - 服务跑在**同一个进程的后台线程**里，所以状态更新是直接的内存操作，
    不需要 WebSocket 或任何 IPC。

单独调试（不启动 Agent，自动循环播放各种心情）：
    python live2d/avatar_server.py --demo --port 8765
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import queue
import threading
import time
import urllib.parse
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

LIVE2D_DIR = Path(__file__).resolve().parent
WEB_DIR = LIVE2D_DIR / "web"
MODELS_DIR = LIVE2D_DIR / "models"

# 让浏览器正确解析这些扩展名
mimetypes.add_type("application/octet-stream", ".moc3")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("application/json", ".model3")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")


# --------------------------------------------------------------------------
# 状态容器
# --------------------------------------------------------------------------
DEFAULT_STATE: Dict[str, Any] = {
    "mood": "平静",
    "primary": "",          # 主表情（唱歌/比心/大葱 三选一，或空）
    "layers": [],           # 叠加表情（脸红/前倾/圈圈/QQ人，可同时生效）
    "valence": 0.35,
    "arousal": 0.55,
    "bond": 0.10,
    "loneliness": 0.20,
    "shyness": 0.10,
    "empathy": 0.00,
    "speaking": False,      # 正在说话 → 口型动
    "thinking": False,      # 正在生成
    "acting": False,        # 正在调用工具
    "text": "",             # 她最后说的话（字幕）
    "route": "",            # 本轮走的是 local 还是 api
    "tools": [],            # 本轮真实调用过的工具
    "turn": 0,
    "name": "",             # 她对用户的称呼
    "ts": "",
}


class _AvatarHTTPServer(ThreadingHTTPServer):
    """关掉 SO_REUSEADDR。

    Windows 上 SO_REUSEADDR 的语义和 Linux 不同：它允许**两个进程绑同一个端口**。
    后果很隐蔽 —— "端口被占用"检测会失效，两个进程都以为自己是 8765，
    请求随机落到其中一个（用户可能看到的是旧实例的状态）。
    关掉之后 bind 会正确报错，从而触发换端口逻辑。
    """

    allow_reuse_address = False
    daemon_threads = True


class AvatarServer:
    """把 Agent 状态推给 Live2D 页面的小型 HTTP + SSE 服务。"""

    def __init__(self, host: str = "127.0.0.1", port: int = 8765,
                 root: Path = WEB_DIR, verbose: bool = False):
        self.host = host
        self.port = port
        self.root = Path(root)
        self.verbose = verbose
        self.state: Dict[str, Any] = dict(DEFAULT_STATE)
        self._clients: Set["queue.Queue[Dict[str, Any]]"] = set()
        self._lock = threading.Lock()
        self._httpd: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        self._stopping = False
        self.port_note = ""
        # 表情名 -> {参数Id: 目标值}，从模型的 exp3 文件里读出来
        self.expression_params: Dict[str, Dict[str, float]] = load_expression_params()
        # 浏览器回报的诊断信息（渲染是否成功、缺哪些参数等）
        self.diagnostics: List[Dict[str, Any]] = []

    @property
    def all_expression_params(self) -> List[str]:
        """所有被表情控制过的参数 Id（用于把不活跃的表情参数归零）。"""
        ids: Set[str] = set()
        for params in self.expression_params.values():
            ids.update(params)
        return sorted(ids)

    # ---------------- 生命周期 ----------------
    def start(self) -> str:
        handler = _make_handler(self)
        try:
            self._httpd = _AvatarHTTPServer((self.host, self.port), handler)
            self.port_note = ""
        except OSError as exc:
            # 端口被占用（常见于上次的进程没退干净）。
            # 不要让整个表现层因此失败 —— 换一个系统分配的空闲端口继续。
            requested = self.port
            self.port = 0
            self._httpd = _AvatarHTTPServer((self.host, self.port), handler)
            self.port_note = f"端口 {requested} 被占用（{type(exc).__name__}），已自动改用端口"
        self._httpd.daemon_threads = True
        # 传 0（或被占用后改 0）时由系统分配端口，这里再读回真实值
        self.port = self._httpd.server_address[1]
        if self.port_note:
            self.port_note = f"{self.port_note} {self.port}"
        self._thread = threading.Thread(target=self._httpd.serve_forever,
                                        name="live2d-avatar", daemon=True)
        self._thread.start()
        if self.verbose:
            print(f"[avatar] 服务已启动: {self.url}")
        return self.url

    def stop(self) -> None:
        self._stopping = True
        with self._lock:
            for q in list(self._clients):
                try:
                    q.put_nowait({"__close__": True})
                except Exception:
                    pass
        if self._httpd is not None:
            try:
                self._httpd.shutdown()
                self._httpd.server_close()
            except Exception:
                pass
        self._httpd = None

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}/"

    # ---------------- 状态更新 ----------------
    def update(self, *, _force: bool = False, **fields: Any) -> Dict[str, Any]:
        """合并状态并广播。只有真的变化时才推，避免刷屏。"""
        changed = False
        with self._lock:
            for k, v in fields.items():
                if self.state.get(k) != v:
                    self.state[k] = v
                    changed = True
        if changed or _force:
            self._broadcast()
        return dict(self.state)

    def set_emotion(self, snap: Dict[str, Any], expression: Optional[Dict[str, Any]] = None,
                    name: str = "", turn: int = 0) -> Dict[str, Any]:
        """把 AgentState.snapshot() 灌进来（Lv3 的核心接线）。"""
        fields: Dict[str, Any] = {
            "mood": snap.get("mood", "平静"),
            "valence": snap.get("valence", 0.0),
            "arousal": snap.get("arousal", 0.0),
            "bond": snap.get("bond", 0.0),
            "loneliness": snap.get("loneliness", 0.0),
            "shyness": snap.get("shyness", 0.0),
            "empathy": snap.get("empathy", 0.0),
        }
        if expression is not None:
            fields["primary"] = expression.get("primary", "")
            fields["layers"] = list(expression.get("layers", []))
        if name:
            fields["name"] = name
        if turn:
            fields["turn"] = turn
        return self.update(**fields)

    def push(self, snap: Dict[str, Any], **extra: Any) -> Dict[str, Any]:
        """一次推送：情绪快照 + 行为状态（思考/说话/查询）+ 字幕。

        这是 main.py 唯一需要调用的方法 —— Lv3 的全部映射逻辑都收在这里，
        业务代码不需要知道"元气对应哪个表情"。
        """
        acting = bool(extra.get("acting"))
        expr = expression_for(snap, acting=acting)
        fields: Dict[str, Any] = {
            "mood": snap.get("mood", "平静"),
            "valence": snap.get("valence", 0.0),
            "arousal": snap.get("arousal", 0.0),
            "bond": snap.get("bond", 0.0),
            "loneliness": snap.get("loneliness", 0.0),
            "shyness": snap.get("shyness", 0.0),
            "empathy": snap.get("empathy", 0.0),
            "primary": expr["primary"],
            "layers": expr["layers"],
        }
        for key in ("speaking", "thinking", "acting", "text", "route", "tools",
                    "turn", "name"):
            if key in extra and extra[key] is not None:
                fields[key] = extra[key]
        return self.update(**fields)

    def _broadcast(self) -> None:
        with self._lock:
            payload = dict(self.state)
            payload["ts"] = datetime.now().astimezone().isoformat(timespec="milliseconds")
            self.state["ts"] = payload["ts"]
            targets = list(self._clients)
        for q in targets:
            try:
                q.put_nowait(payload)
            except Exception:
                pass

    @property
    def client_count(self) -> int:
        with self._lock:
            return len(self._clients)


# --------------------------------------------------------------------------
# HTTP 处理
# --------------------------------------------------------------------------
def _make_handler(server: AvatarServer):
    """为每个 server 实例生成 handler（避免用类属性共享状态）。"""

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "MikuAvatar/1.0"

        # ---------- 工具 ----------
        def log_message(self, fmt: str, *args) -> None:
            if server.verbose:
                print(f"[avatar] {self.address_string()} {fmt % args}")

        def _resolve(self, url_path: str) -> Optional[Path]:
            """把 URL 路径映射到磁盘文件。

            自己实现而不复用 SimpleHTTPRequestHandler.translate_path，
            因为模型的贴图/表情文件名是中文，必须按 UTF-8 正确解码，
            并且要严格挡住目录穿越。
            """
            try:
                raw = urllib.parse.urlsplit(url_path).path
                decoded = urllib.parse.unquote(raw, encoding="utf-8", errors="strict")
            except Exception:
                return None
            if decoded in ("", "/"):
                decoded = "/index.html"
            rel = decoded.lstrip("/")
            parts = [p for p in rel.split("/") if p not in ("", ".")]
            if any(p == ".." for p in parts):
                return None

            # /models/... 指向 live2d/models，其余走 web 根目录
            if parts and parts[0] == "models":
                base = MODELS_DIR
                parts = parts[1:]
            else:
                base = server.root
            target = (base.joinpath(*parts)).resolve()
            try:
                target.relative_to(base.resolve())
            except ValueError:
                return None
            return target if target.is_file() else None

        def _send_bytes(self, body: bytes, ctype: str, code: int = 200,
                        extra: Optional[Dict[str, str]] = None) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _send_json(self, obj: Any, code: int = 200) -> None:
            self._send_bytes(json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                             "application/json; charset=utf-8", code)

        # ---------- 路由 ----------
        def do_GET(self) -> None:      # noqa: N802
            path = urllib.parse.urlsplit(self.path).path
            if path == "/events":
                self._sse()
                return
            if path == "/state.json":
                self._send_json(server.state)
                return
            if path == "/health":
                self._send_json({"ok": True, "clients": server.client_count,
                                 "model": server.state.get("mood"), "url": server.url})
                return
            if path == "/api/expressions":
                # 前端靠这个接口拿到"表情名 -> 参数值"，自身不含任何硬编码知识
                self._send_json({
                    "expressions": server.expression_params,
                    "allParams": server.all_expression_params,
                    "lipSyncParam": "ParamMouthOpenY",
                    "moods": sorted({
                        "元气", "开心", "温柔", "害羞", "寂寞",
                        "闹别扭", "低落", "认真", "平静",
                    }),
                })
                return

            if path == "/api/diag":
                # 浏览器回报的渲染诊断（有没有真的加载成功、缺哪些参数）
                with server._lock:
                    self._send_json({"count": len(server.diagnostics),
                                     "items": list(server.diagnostics)})
                return

            target = self._resolve(self.path)
            if target is None:
                self._send_bytes(b"404 not found", "text/plain; charset=utf-8", 404)
                return
            try:
                body = target.read_bytes()
            except OSError as exc:
                self._send_bytes(f"读取失败: {exc}".encode("utf-8"),
                                 "text/plain; charset=utf-8", 500)
                return
            ctype, _ = mimetypes.guess_type(str(target))
            if ctype is None:
                ctype = "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/json",):
                ctype += "; charset=utf-8"
            self._send_bytes(body, ctype)

        def do_HEAD(self) -> None:      # noqa: N802
            self.do_GET()

        def do_POST(self) -> None:      # noqa: N802
            """允许外部（脚本/浏览器/其它进程）推状态或回报诊断。"""
            path = urllib.parse.urlsplit(self.path).path
            try:
                length = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(payload, dict):
                    raise ValueError("body 必须是 JSON 对象")
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc)}, 400)
                return

            if path == "/state":
                server.update(**payload)
                self._send_json({"ok": True, "state": server.state})
                return
            if path == "/diag":
                # 浏览器把渲染诊断回报过来，方便没有图形界面时排查
                with server._lock:
                    server.diagnostics.append(payload)
                    del server.diagnostics[:-50]
                if server.verbose or payload.get("level") == "error":
                    print(f"[avatar][diag:{payload.get('level', 'info')}] "
                          f"{json.dumps(payload, ensure_ascii=False)[:400]}")
                self._send_json({"ok": True})
                return
            self._send_json({"ok": False, "error": "unknown endpoint"}, 404)

        # ---------- SSE ----------
        def _sse(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()

            q: "queue.Queue[Dict[str, Any]]" = queue.Queue()
            with server._lock:
                server._clients.add(q)
            try:
                # 一连上就先给一份当前状态，避免页面空白等待
                self._write_event(server.state)
                while not server._stopping:
                    try:
                        item = q.get(timeout=15)
                    except queue.Empty:
                        self.wfile.write(b": keepalive\n\n")   # 心跳，防连接被回收
                        self.wfile.flush()
                        continue
                    if item.get("__close__"):
                        break
                    self._write_event(item)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                pass
            finally:
                with server._lock:
                    server._clients.discard(q)

        def _write_event(self, payload: Dict[str, Any]) -> None:
            data = json.dumps(payload, ensure_ascii=False)
            self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
            self.wfile.flush()

    return Handler


# --------------------------------------------------------------------------
# 表情 -> 参数：直接从模型文件读，不在代码里写死
# --------------------------------------------------------------------------
def load_expression_params(model_dir: Path = MODELS_DIR / "miku") -> Dict[str, Dict[str, float]]:
    """解析 model3.json + 各 exp3.json，得到 {表情名: {参数Id: 目标值}}。

    这样前端不需要知道"脸红对应 Param130"这类知识 —— 语义留在后端，
    换一个模型也能自动适配，改模型不用改代码。
    """
    result: Dict[str, Dict[str, float]] = {}
    model_json = model_dir / "miku.model3.json"
    try:
        spec = json.loads(model_json.read_text(encoding="utf-8"))
        expressions = spec.get("FileReferences", {}).get("Expressions", [])
    except Exception:
        return result

    for item in expressions:
        name = item.get("Name")
        file = item.get("File")
        if not name or not file:
            continue
        try:
            exp = json.loads((model_dir / file).read_text(encoding="utf-8"))
        except Exception:
            continue
        params = {p["Id"]: float(p.get("Value", 0.0))
                  for p in exp.get("Parameters", []) if p.get("Id")}
        if params:
            result[name] = params
    return result


# --------------------------------------------------------------------------
# 表情映射（从 config 读取；这里只做兜底，保证单独运行也能演示）
# --------------------------------------------------------------------------
def expression_for(snapshot: Dict[str, Any], acting: bool = False) -> Dict[str, Any]:
    """根据状态快照决定"该摆什么表情"。

    真正的映射表在 config.LV3_EXPRESSION_MAP（数据而非代码），
    放在后端算的理由：这张表是可解释、可审计的，也能被日志记录。
    """
    try:
        import sys
        sys.path.insert(0, str(LIVE2D_DIR.parent))
        from config import (LV3_ACTING_EXPRESSION, LV3_EXPRESSION_MAP,  # type: ignore
                            LV3_HAPPY_LEEK, LV3_SHOW_WATERMARK)
    except Exception:
        LV3_EXPRESSION_MAP = {
            "元气": {"primary": "sing", "layers": []},
            "开心": {"primary": "sing", "layers": []},
            "温柔": {"primary": "heart", "layers": []},
            "害羞": {"primary": "", "layers": ["blush"]},
            "寂寞": {"primary": "", "layers": ["lean"]},
            "闹别扭": {"primary": "", "layers": ["swirl"]},
            "低落": {"primary": "", "layers": ["swirl"]},
            "认真": {"primary": "", "layers": ["lean"]},
            "平静": {"primary": "", "layers": []},
        }
        LV3_HAPPY_LEEK = {"min_valence": 0.8, "min_arousal": 0.8, "expression": "leek"}
        LV3_ACTING_EXPRESSION = "swirl"
        LV3_SHOW_WATERMARK = False

    mood = snapshot.get("mood", "平静")
    spec = dict(LV3_EXPRESSION_MAP.get(mood, {"primary": "", "layers": []}))

    # 特别开心 → 掏出标志物（大葱）。这是"情绪强度"而不只是"情绪种类"。
    if (snapshot.get("valence", 0) >= LV3_HAPPY_LEEK["min_valence"]
            and snapshot.get("arousal", 0) >= LV3_HAPPY_LEEK["min_arousal"]):
        spec["primary"] = LV3_HAPPY_LEEK["expression"]

    # 正在调用工具 → 用"圈圈"盖过主表情，让她看起来在努力查资料
    if acting and LV3_ACTING_EXPRESSION:
        spec["primary"] = LV3_ACTING_EXPRESSION

    layers = list(spec.get("layers", []))
    # 水印由作者设定默认打开；关掉时前端会把它的参数归零
    if LV3_SHOW_WATERMARK and "watermark" not in layers:
        layers.append("watermark")
    return {"primary": spec.get("primary", ""), "layers": layers}


# --------------------------------------------------------------------------
# 单独运行：演示模式
# --------------------------------------------------------------------------
def _demo(server: AvatarServer) -> None:
    """不启动 Agent，循环展示各种心情，用来单独验证表现层。"""
    moods = [
        {"mood": "元气", "valence": 0.85, "arousal": 0.9, "bond": 0.3},
        {"mood": "开心", "valence": 0.7, "arousal": 0.5, "bond": 0.4},
        {"mood": "温柔", "valence": 0.4, "arousal": 0.4, "bond": 0.6},
        {"mood": "害羞", "valence": 0.5, "arousal": 0.7, "bond": 0.4, "shyness": 0.8},
        {"mood": "寂寞", "valence": 0.1, "arousal": 0.3, "bond": 0.5, "loneliness": 0.8},
        {"mood": "闹别扭", "valence": -0.3, "arousal": 0.6, "bond": 0.3},
        {"mood": "低落", "valence": -0.5, "arousal": 0.2, "bond": 0.4},
        {"mood": "认真", "valence": 0.2, "arousal": 0.2, "bond": 0.4},
        {"mood": "平静", "valence": 0.35, "arousal": 0.55, "bond": 0.2},
    ]
    print(f"[avatar] 演示模式：每 6 秒换一种心情，共 {len(moods)} 种。Ctrl+C 结束。")
    i = 0
    try:
        while True:
            snap = dict(DEFAULT_STATE)
            snap.update(moods[i % len(moods)])
            expr = expression_for(snap)
            server.set_emotion(snap, expr, name="制作人", turn=i + 1)
            server.update(speaking=True, thinking=False, acting=False,
                          text=f"（演示）现在的心情是「{snap['mood']}」",
                          route="local", tools=[])
            print(f"  心情={snap['mood']:<4} primary={expr['primary'] or '-':<6} "
                  f"layers={expr['layers'] or '-'}  客户端={server.client_count}")
            time.sleep(6)
            i += 1
    except KeyboardInterrupt:
        print("\n[avatar] 演示结束")


def main() -> int:
    ap = argparse.ArgumentParser(description="Live2D 表现层服务（Lv3）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--demo", action="store_true", help="循环展示各种心情")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    server = AvatarServer(host=args.host, port=args.port, verbose=args.verbose)
    server.start()
    print(f"[avatar] 用浏览器打开： {server.url}")
    print(f"[avatar] 模型目录： {MODELS_DIR}")
    if args.demo:
        _demo(server)
    else:
        print("[avatar] 无 --demo：等待 Agent 推送状态。Ctrl+C 结束。")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    server.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
