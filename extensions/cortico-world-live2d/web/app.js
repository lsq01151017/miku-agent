/**
 * 渲染端:连上 World 的 `/state` 推流,把通道值写到 Live2D 模型上。
 *
 * 分工是清楚的:**World 算通道值**(内部状态 + 词表片段),这里只做三件事——
 * 把抽象通道名按素材包的 `suggests` 映到模型参数、把突变平滑成动作、在说话时对口型。
 *
 * 口型是按说话时长跑的振荡,**不是音频同步**:没有语音合成就没有音素时间轴,
 * 说成"唇形同步"是撒谎。说话一停它就回到基线。
 */
(function () {
  'use strict';

  var el = {
    canvas: document.getElementById('stage'),
    conn: document.getElementById('conn'),
    why: document.getElementById('why'),
  };

  function why(message) {
    el.why.style.display = 'block';
    el.why.textContent = message;
  }

  // 通道 → 模型参数。`suggests` 里开头的 Param* 才是参数名,其余是给人的说明。
  var channelParam = {};
  // 通道量程,裁剪用。
  var channelRange = {};
  var model = null;
  var app = null;
  var target = {};   // World 给的通道值
  var current = {};  // 平滑后的当前值
  var speaking = false;
  var speakStart = 0;

  function buildMapping(params) {
    Object.keys(params).forEach(function (channel) {
      var spec = params[channel] || {};
      var hit = /^(Param[A-Za-z0-9_]+)/.exec(String(spec.suggests || ''));
      if (hit) channelParam[channel] = hit[1];
      if (spec.range) channelRange[channel] = spec.range;
    });
  }

  function fit() {
    if (!app) return;
    app.renderer.resize(window.innerWidth, window.innerHeight);
  }

  async function boot() {
    if (typeof PIXI === 'undefined' || !PIXI.live2d || !PIXI.live2d.Live2DModel) {
      why('播放器库没加载成功:检查 worlds.live2d.webDir 指向的目录里有没有 js/ 下那三个文件。');
      return;
    }
    try {
      var paramsResp = await fetch('/pack/params.json', { cache: 'no-store' });
      buildMapping(await paramsResp.json());
    } catch (e) {
      why('取 /pack/params.json 失败:' + e.message);
      return;
    }

    app = new PIXI.Application({
      view: el.canvas,
      autoStart: true,
      backgroundAlpha: 0,
      resizeTo: window,
      antialias: true,
    });

    var modelUrl = '/model/' + encodeURIComponent(window.__DSH_MODEL_FILE__ || '');
    try {
      model = await PIXI.live2d.Live2DModel.from(modelUrl, { autoInteract: true });
    } catch (e) {
      why('模型加载失败:' + e.message + '\n检查 worlds.live2d.modelDir。');
      return;
    }
    app.stage.addChild(model);
    var scale = Math.min(window.innerWidth / model.width, window.innerHeight / model.height);
    model.scale.set(scale);
    model.anchor.set(0.5, 0.5);
    model.position.set(window.innerWidth / 2, window.innerHeight / 2);
    window.addEventListener('resize', fit);
    tick();
    listen();
  }

  /** 把通道值写到参数上;模型没有的参数(缺件)静默跳过,那正是 losesIfMissing 说的。 */
  function apply() {
    if (!model || !model.internalModel) return;
    var core = model.internalModel.coreModel;
    var mouthOpen = 0;
    if (speaking) {
      var elapsed = (performance.now() - speakStart) / 1000;
      // 按音节节奏开合,幅度随说话时长轻微衰减,避免一直大张嘴。
      mouthOpen = Math.max(0, 0.42 + 0.3 * Math.sin(elapsed * 11.5) + 0.1 * Math.sin(elapsed * 27));
    }
    Object.keys(current).forEach(function (channel) {
      var param = channelParam[channel];
      if (!param) return;
      var value = channel === 'MouthOpen' ? mouthOpen : current[channel];
      var range = channelRange[channel];
      if (range) value = Math.min(range[1], Math.max(range[0], value));
      try { core.setParameterValueById(param, value); } catch (e) { /* 模型没有这条参数 */ }
    });
  }

  /** 每帧把当前值往目标值推一点:通道是"想让它怎样",动作才像动作。 */
  function tick() {
    Object.keys(target).forEach(function (channel) {
      if (channel === 'MouthOpen') return; // 口型归说话,不跟通道
      var to = target[channel];
      var from = current[channel] === undefined ? 0 : current[channel];
      current[channel] = from + (to - from) * 0.18;
    });
    apply();
    requestAnimationFrame(tick);
  }

  function listen() {
    var source = new EventSource('/state');
    source.onopen = function () {
      el.conn.className = 'on';
      el.conn.textContent = '已连上她的形象';
    };
    source.onerror = function () {
      el.conn.className = '';
      el.conn.textContent = '断开,重连中…';
    };
    source.onmessage = function (event) {
      var payload = JSON.parse(event.data);
      target = payload.channels || {};
      var nowSpeaking = Boolean(payload.speaking);
      if (nowSpeaking && !speaking) speakStart = performance.now();
      speaking = nowSpeaking;
    };
  }

  boot();
})();
