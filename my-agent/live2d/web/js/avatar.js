/* ============================================================
   avatar.js — Live2D 表现层前端
   ------------------------------------------------------------
   设计原则：**前端不做任何状态决策**。
   它只做三件事：
     1. 画模型；
     2. 从 /api/expressions 拿到"表情名 -> 参数值"的映射（后端给的）；
     3. 从 /events 收到 "primary / layers / speaking" 后，把参数平滑过去。
   所以"什么心情摆什么表情"这件事完全在后端，可解释、可审计。
   ============================================================ */

(function () {
  "use strict";

  const MOOD_LABELS = {
    valence: "心情", arousal: "活力", bond: "羁绊",
    loneliness: "寂寞", shyness: "害羞", empathy: "关切",
  };

  const el = {
    canvas: document.getElementById("stage"),
    conn: document.getElementById("conn"),
    connText: document.getElementById("conn-text"),
    pThinking: document.getElementById("p-thinking"),
    pActing: document.getElementById("p-acting"),
    pSpeaking: document.getElementById("p-speaking"),
    mood: document.getElementById("hud-mood"),
    bars: document.getElementById("hud-bars"),
    name: document.getElementById("hud-name"),
    turn: document.getElementById("hud-turn"),
    route: document.getElementById("hud-route"),
    tools: document.getElementById("hud-tools"),
    subtitle: document.getElementById("subtitle"),
    zoom: document.getElementById("zoom"),
    zoomVal: document.getElementById("zoom-val"),
    btnReset: document.getElementById("btn-reset"),
    btnExp: document.getElementById("btn-exp"),
    error: document.getElementById("error"),
  };

  let app = null;
  let model = null;
  let coreModel = null;

  // 表情相关（全部来自后端）
  let expressionParams = {};   // {表情名: {参数Id: 数值}}
  let allParams = [];          // 所有会被表情控制的参数
  let lipSyncParam = "ParamMouthOpenY";
  let paramExists = {};        // 参数是否真的存在于这个模型

  // 目标是后端说的，当前值是插值出来的（这样表情切换是平滑的而不是硬跳）
  const target = Object.create(null);
  const current = Object.create(null);

  let zoom = 1.0;
  const BASE_FILL = 1.12;

  // 说话口型
  let speakAmp = 0;
  let speakPhase = 0;

  const state = {
    speaking: false, thinking: false, acting: false, text: "", name: "", turn: 0,
    route: "", tools: [], mood: "平静",
  };

  function fail(msg) {
    el.error.classList.remove("hidden");
    el.error.textContent = msg;
    report({ level: "error", message: msg });
  }

  /** 显示可点击的致命错误（用于"打开方式不对"这类需要给出链接的情况）。 */
  function failWith(title, html) {
    el.error.classList.remove("hidden");
    el.error.innerHTML =
      '<div class="err-title">' + title + '</div><div class="err-body">' + html + '</div>';
    report({ level: "error", message: title + " | " + html.replace(/<[^>]+>/g, " ") });
  }

  /** 把诊断信息回报给后端，便于在没有浏览器界面的情况下排查问题。 */
  function report(payload) {
    try {
      fetch("/diag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({
          ua: navigator.userAgent,
          href: location.href,
          protocol: location.protocol,
          webgl: !!document.createElement("canvas").getContext("webgl"),
        }, payload)),
      }).catch(function () {});
    } catch (e) { /* 诊断失败不能影响主流程 */ }
  }

  // ---------------------------------------------------------------- 启动前的自检
  /**
   * 最常见的误用是**直接双击 index.html**。这种情况下浏览器禁止 file:// 页面
   * 读取模型文件，会报出一句毫无信息量的 "Network error"。
   * 所以这里先自己判断，把原因和正确做法直接写清楚。
   */
  function preflight() {
    if (location.protocol === "file:") {
      failWith("打开方式不对：不要直接双击 HTML 文件", [
        "你是用 <code>file://</code> 直接打开了页面。浏览器出于安全限制，",
        "不允许这种方式读取模型文件，所以一定会失败（报错通常是 <code>Network error</code>）。",
        "<br><br><b>正确做法：</b>",
        "<br>1. 回到 <code>my-agent</code> 目录，双击 <code>start_live2d.bat</code>",
        "（或者运行 <code>python main.py --avatar</code>）",
        "<br>2. 然后访问 <a href=\"http://127.0.0.1:8765/\" target=\"_blank\">",
        "http://127.0.0.1:8765/</a>",
        "<br><br>模型文件必须由 Agent 自带的小服务提供，不能从硬盘直接打开。",
      ].join(""));
      return false;
    }
    return true;
  }

  async function main() {
    if (!preflight()) return;

    if (typeof PIXI === "undefined") {
      fail("pixi.js 没加载成功（js/pixi.min.js）。请确认文件存在且服务路径正确。");
      return;
    }
    if (!PIXI.live2d || !PIXI.live2d.Live2DModel) {
      fail("pixi-live2d-display 没加载成功（js/cubism4.min.js）。");
      return;
    }
    if (typeof Live2DCubismCore === "undefined") {
      fail("Live2D Cubism Core 没加载成功（js/live2dcubismcore.min.js）。\n" +
           "这是 Live2D 官方的运行时，模型必需。");
      return;
    }

    // 先确认服务真的在（区分"服务没起"和"模型坏了"）
    try {
      const h = await fetch("/health", { cache: "no-store" });
      if (!h.ok) throw new Error("HTTP " + h.status);
    } catch (e) {
      failWith("连接不到表现层服务", [
        "页面能打开，但取不到 <code>/health</code>，说明提供模型的小服务已经停了。",
        "<br>（Agent 退出后服务也会跟着停。）",
        "<br><br><b>请重新启动：</b>双击 <code>start_live2d.bat</code>，",
        "或运行 <code>python main.py --avatar</code>。",
        "<br><br>当前地址：<code>" + location.origin + "</code>",
      ].join(""));
      return;
    }

    app = new PIXI.Application({
      view: el.canvas,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      resizeTo: window,
    });

    const modelUrl = "models/miku/miku.model3.json";
    try {
      // autoInteract: 视线/头部自动跟随鼠标 —— 一句话就让她"活了"
      model = await PIXI.live2d.Live2DModel.from(modelUrl, {
        autoInteract: true,
        idleMotionGroup: "Idle",
      });
    } catch (e) {
      const detail = (e && e.message ? e.message : String(e));
      failWith("模型加载失败：" + detail, [
        "请求的地址是：<code>" + new URL(modelUrl, location.href).href + "</code>",
        "<br>如果这句是 <code>Network error</code>，通常是服务中途停了；",
        "如果是 <code>404</code>，说明模型目录不在预期位置。",
        "<br><br>可以直接在浏览器里打开上面那个地址验证：",
        "能返回一大段 JSON 才算正常。",
        "<br><br>模型目录应为 <code>my-agent/live2d/models/miku/</code>。",
      ].join(""));
      return;
    }

    app.stage.addChild(model);
    coreModel = model.internalModel.coreModel;

    // 记录模型尺寸，并检查每个表情参数是否真的存在
    let exprResp = { expressions: {}, allParams: [], lipSyncParam: "ParamMouthOpenY" };
    try {
      exprResp = await fetch("/api/expressions", { cache: "no-store" })
        .then(function (r) { return r.json(); });
    } catch (e) {
      // 拿不到表情清单不算致命：模型本身还能显示，只是表情不会变
      report({ level: "error", message: "取 /api/expressions 失败: " + e.message });
    }
    expressionParams = exprResp.expressions || {};
    allParams = exprResp.allParams || [];
    lipSyncParam = exprResp.lipSyncParam || "ParamMouthOpenY";

    allParams.concat([lipSyncParam]).forEach(function (id) {
      let ok = false;
      try {
        ok = typeof coreModel.getParameterIndex === "function"
          ? coreModel.getParameterIndex(id) >= 0
          : true;
      } catch (e) { ok = false; }
      paramExists[id] = ok;
      target[id] = 0;
      current[id] = 0;
    });

    buildBars();
    fit();
    window.addEventListener("resize", fit);
    app.ticker.add(tick);

    report({
      level: "info",
      loaded: true,
      modelSize: {
        w: model.internalModel.originalWidth,
        h: model.internalModel.originalHeight,
      },
      contentBounds: contentBounds ? {
        x: Math.round(contentBounds.x), y: Math.round(contentBounds.y),
        w: Math.round(contentBounds.width), h: Math.round(contentBounds.height),
      } : null,
      viewport: { w: app.screen.width, h: app.screen.height },
      scale: Number(model.scale.x.toFixed(4)),
      expressions: Object.keys(expressionParams),
      missingParams: Object.keys(paramExists).filter(function (k) { return !paramExists[k]; }),
    });

    bindUI();
    connect();
  }

  // ---------------------------------------------------------------- 布局
  /**
   * 自适应缩放。
   *
   * 不能用模型画布尺寸直接算：这个模型的画布是 3500×8888，但角色只占其中一部分，
   * 按照画布高度缩放会让她看起来偏小。所以先按 scale=1 量一次**实际内容边界**
   * (localBounds)，再按内容高度适配 —— 这样画布里有多少空白都不影响。
   * 右下角缩放滑块在此基础上再乘一个系数，供手动微调。
   */
  let contentBounds = null;

  function measure() {
    if (!model) return null;
    const prev = model.scale.x;
    model.scale.set(1);
    let b = null;
    try { b = model.getLocalBounds(); } catch (e) { b = null; }
    model.scale.set(prev);
    return b;
  }

  function fit() {
    if (!model || !app) return;
    const w = app.screen.width;
    const h = app.screen.height;
    const iw = model.internalModel.originalWidth || 1;
    const ih = model.internalModel.originalHeight || 1;

    if (!contentBounds) contentBounds = measure();
    const cw = (contentBounds && contentBounds.width > 1) ? contentBounds.width : iw;
    const ch = (contentBounds && contentBounds.height > 1) ? contentBounds.height : ih;

    // 同时受高度和宽度约束，保证不会被裁掉
    const s = Math.min(h / ch, w / cw) * BASE_FILL * zoom;

    model.anchor.set(0.5, 0.5);
    // 内容边界有偏移时（画布空白不均匀），要把锚点补偿回去，否则会偏向一侧
    if (contentBounds) {
      model.pivot.set(contentBounds.x + contentBounds.width / 2,
                      contentBounds.y + contentBounds.height / 2);
    }
    model.scale.set(s);
    model.position.set(w / 2, h * 0.54);
  }

  function buildBars() {
    el.bars.innerHTML = "";
    Object.keys(MOOD_LABELS).forEach(function (key) {
      const row = document.createElement("div");
      row.className = "bar-row";
      row.innerHTML =
        '<span>' + MOOD_LABELS[key] + '</span>' +
        '<span class="bar-track"><span class="bar-fill" id="bar-' + key + '"></span></span>' +
        '<span class="bar-val" id="val-' + key + '">0.00</span>';
      el.bars.appendChild(row);
    });
  }

  // ---------------------------------------------------------------- 状态更新
  function applyState(s) {
    state.mood = s.mood || "平静";
    state.speaking = !!s.speaking;
    state.thinking = !!s.thinking;
    state.acting = !!s.acting;
    state.route = s.route || "";
    state.tools = s.tools || [];
    state.turn = s.turn || 0;

    // 后端已经决定了 primary / layers，这里只做"该摆什么表情"的执行
    const active = {};
    (s.layers || []).forEach(function (n) { active[n] = true; });
    if (s.primary) active[s.primary] = true;

    allParams.forEach(function (id) { target[id] = 0; });
    Object.keys(active).forEach(function (name) {
      const params = expressionParams[name];
      if (!params) return;
      Object.keys(params).forEach(function (id) {
        // 同一个参数被多个表情指定时，取绝对值更大的那个（避免互相抵消）
        if (Math.abs(params[id]) >= Math.abs(target[id] || 0)) target[id] = params[id];
      });
    });

    // HUD
    el.mood.textContent = state.mood;
    Object.keys(MOOD_LABELS).forEach(function (key) {
      const v = typeof s[key] === "number" ? s[key] : 0;
      const fill = document.getElementById("bar-" + key);
      const val = document.getElementById("val-" + key);
      if (fill) {
        // valence 范围是 -1..1，映射到 0..100%
        const pct = (key === "valence") ? (v + 1) / 2 * 100 : v * 100;
        fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
      }
      if (val) val.textContent = v.toFixed(2);
    });
    el.name.textContent = s.name ? ("称呼：" + s.name) : "还不知道对方的名字";
    el.turn.textContent = state.turn ? ("第 " + state.turn + " 轮") : "";
    el.route.textContent = state.route ? ("路由：" + state.route) : "";
    el.tools.textContent = state.tools.length ? ("已执行：" + state.tools.join(", ")) : "";

    el.pThinking.classList.toggle("on", state.thinking);
    el.pActing.classList.toggle("on", state.acting);
    el.pSpeaking.classList.toggle("on", state.speaking);

    if (typeof s.text === "string") {
      el.subtitle.textContent = s.text;
      el.subtitle.classList.toggle("show", !!s.text);
    }
    el.subtitle.classList.toggle("speaking", state.speaking);
  }

  // ---------------------------------------------------------------- 每帧插值
  function tick() {
    if (!coreModel) return;
    const dt = app.ticker.deltaMS / 1000;

    // 表情参数平滑过渡（约 0.18 秒完成大部分变化）
    const k = Math.min(1, dt * 6.0);
    for (let i = 0; i < allParams.length; i++) {
      const id = allParams[i];
      const t = target[id] || 0;
      current[id] += (t - current[id]) * k;
      if (Math.abs(current[id] - t) < 0.002) current[id] = t;
      if (paramExists[id]) {
        try { coreModel.setParameterValueById(id, current[id]); } catch (e) { /* 忽略 */ }
      }
    }

    // 说话时的口型：没有真实音频，就用一条有节奏的包络驱动 ParamMouthOpenY
    if (state.speaking) {
      speakAmp = Math.min(1, speakAmp + dt * 5);
      speakPhase += dt * 11;
      let v = 0.5 + 0.5 * Math.sin(speakPhase) * Math.sin(speakPhase * 0.37 + 1.1);
      v = Math.max(0, v) * speakAmp;
      if (paramExists[lipSyncParam]) {
        try { coreModel.setParameterValueById(lipSyncParam, v * 0.85); } catch (e) { /* 忽略 */ }
      }
      // 说话时头部有轻微摆动，比完全静止自然
      try {
        coreModel.setParameterValueById("ParamAngleZ", Math.sin(speakPhase * 0.45) * 3.2);
      } catch (e) { /* 忽略 */ }
    } else {
      speakAmp = Math.max(0, speakAmp - dt * 4);
      if (speakAmp > 0 && paramExists[lipSyncParam]) {
        try { coreModel.setParameterValueById(lipSyncParam, speakAmp * 0.2); } catch (e) { /* 忽略 */ }
      }
    }
  }

  // ---------------------------------------------------------------- SSE
  function connect() {
    let es;
    try {
      es = new EventSource("/events");
    } catch (e) {
      fail("EventSource 创建失败：" + e.message);
      return;
    }

    es.onopen = function () {
      el.conn.classList.add("ok");
      el.connText.textContent = "已连接";
      report({ level: "info", sse: "open" });
    };

    es.onmessage = function (ev) {
      try {
        applyState(JSON.parse(ev.data));
      } catch (e) { /* 单条坏数据不应中断画面 */ }
    };

    es.onerror = function () {
      el.conn.classList.remove("ok");
      el.connText.textContent = "重连中…";
      // EventSource 会自己重连，这里不改状态，避免画面闪回默认值
    };
  }

  // ---------------------------------------------------------------- 交互
  function bindUI() {
    el.zoom.addEventListener("input", function () {
      zoom = Number(el.zoom.value) / 100;
      el.zoomVal.textContent = el.zoom.value + "%";
      fit();
    });
    el.btnReset.addEventListener("click", function () {
      zoom = 1.0;
      el.zoom.value = "100";
      el.zoomVal.textContent = "100%";
      fit();
    });
    // 依次试遍所有表情，方便确认模型资产是好的
    el.btnExp.addEventListener("click", function () {
      const names = Object.keys(expressionParams);
      if (!names.length) return;
      let i = 0;
      const step = function () {
        if (i >= names.length) {
          applyState(Object.assign({}, state, { primary: "", layers: [] }));
          return;
        }
        const n = names[i++];
        applyState(Object.assign({}, state, { primary: n, layers: [] }));
        el.subtitle.textContent = "（试表情）" + n;
        el.subtitle.classList.add("show");
        setTimeout(step, 1400);
      };
      step();
    });
  }

  window.addEventListener("error", function (e) {
    report({ level: "error", message: String(e.message || e) });
  });

  main().catch(function (e) {
    fail("初始化异常：\n" + (e && e.stack ? e.stack : String(e)));
  });
})();
