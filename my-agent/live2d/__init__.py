"""
live2d — Lv3 表现层（Avatar）
=============================

把 Agent 的内部状态变成看得见的表情与动作。

- `avatar_server.py`：小型 HTTP + SSE 服务，负责"状态 → 表情"的映射并推给浏览器
- `web/`：前端页面（pixi.js + 官方 Live2D Cubism Core + pixi-live2d-display）
- `models/miku/`：Live2D 模型资产

单独调试（不启动 Agent）：
    python live2d/avatar_server.py --demo --port 8765
"""
