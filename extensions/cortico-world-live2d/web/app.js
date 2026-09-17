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

  // 通道 → 本模型参数,以及量程。映射由 World 解析(它知道部署的修正表),
  // 这里只按结果写参数,不再自己猜 `suggests`。
  var channelParam = {};
  var channelRange = {};
  var model = null;
  var app = null;
  var target = {};   // World 给的通道值
  var current = {};  // 平滑后的当前值
  var speaking = false;
  var speakStart = 0;
  var lastExpression = null;
  var lastExpressionToken = -1;
  // 不归通道管的参数定值(例如模型的水印开关),每帧照写一次,免得被表情或动作改回去。
  var overrides = {};
  // 模型自己的眨眼参数:这几路的开合归眨眼逻辑,通道值只在它上面叠加,不覆盖它。
  var blinkParams = {};

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
      var resp = await fetch('/pack/channels.json', { cache: 'no-store' });
      var channels = await resp.json();
      Object.keys(channels).forEach(function (channel) {
        var spec = channels[channel] || {};
        if (spec.param) channelParam[channel] = spec.param;
        if (spec.range) channelRange[channel] = spec.range;
      });
      var fixed = await (await fetch('/pack/overrides.json', { cache: 'no-store' })).json();
      overrides = fixed || {};
    } catch (e) {
      why('取 /pack/channels.json 失败:' + e.message);
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
    blinkParams = blinkParameters(model.internalModel);
    // Cubism 每帧会把参数复位成模型默认值,所以写参数只有一个正确的时刻:模型复位之后、
    // 更新之前(`beforeModelUpdate`)。自己的 rAF 与模型更新没有固定先后,写早了当帧就被抹掉。
    if (model.internalModel && typeof model.internalModel.on === 'function') {
      model.internalModel.on('beforeModelUpdate', writeFrame);
    }
    window.addEventListener('resize', fit);
    tick();
    listen();
  }

  /**
   * 模型自己的眨眼参数。这几个参数的每一帧值由眨眼逻辑算出,通道只能在它上面叠加:
   * 直接覆盖就等于把眨眼关掉,那比没有表情更像一张假脸。
   */
  function blinkParameters(internal) {
    var ids = {};
    try {
      var groups = (internal.settings && internal.settings.groups) || [];
      for (var i = 0; i < groups.length; i++) {
        if (groups[i] && groups[i].Name === 'EyeBlink') {
          (groups[i].Ids || []).forEach(function (id) { ids[id] = true; });
        }
      }
      var blink = internal.eyeBlink && internal.eyeBlink.parameterIds;
      if (blink) blink.forEach(function (id) { ids[id] = true; });
    } catch (e) { /* 读不到就按"没有眨眼参数"处理 */ }
    return ids;
  }

  /**
   * 每帧写一次参数:通道值 + 参数定值。
   *
   * 模型没有的参数(缺件)静默跳过,那正是 `losesIfMissing` 说的。眨眼参数走加法,
   * 其余走赋值。
   */
  function writeFrame() {
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
      try {
        if (blinkParams[param]) {
          core.setParameterValueById(param, core.getParameterValueById(param) + value);
        } else {
          core.setParameterValueById(param, value);
        }
      } catch (e) { /* 模型没有这条参数 */ }
    });
    Object.keys(overrides).forEach(function (param) {
      try { core.setParameterValueById(param, overrides[param]); } catch (e) { /* 同上 */ }
    });
  }

  /** 平滑在自己的帧里推进:通道是"想让它怎样",动作才像动作。写参数不在这一刻。 */
  function tick() {
    Object.keys(target).forEach(function (channel) {
      if (channel === 'MouthOpen') return; // 口型归说话,不跟通道
      var to = target[channel];
      var from = current[channel] === undefined ? 0 : current[channel];
      current[channel] = from + (to - from) * 0.18;
    });
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
      applyExpression(payload.expression || null, payload.expressionToken);
    };
  }

  /**
   * 表情层:World 给出此刻该挂的那张模型自带表情——先是她台词命中的,过期回到心情那张。
   *
   * 表情与通道写的是不相交的参数组(表情只写 Param125/Param130-137),所以两样都照做,
   * 谁也不覆盖谁。名字与序号都比一遍:同一张表情说第二次时名字没变,序号变了,那也要重放。
   */
  function applyExpression(name, token) {
    var stamp = token === undefined ? null : token;
    if (name === lastExpression && stamp === lastExpressionToken) return;
    lastExpression = name;
    lastExpressionToken = stamp;
    try {
      if (!model || typeof model.expression !== 'function') return;
      if (name) {
        model.expression(name);
        return;
      }
      var manager = model.internalModel && model.internalModel.motionManager
        && model.internalModel.motionManager.expressionManager;
      if (manager && typeof manager.resetExpression === 'function') manager.resetExpression();
    } catch (e) {
      // 不接管连接提示条:表情切不动不该让人以为整个页面坏了。
      console.warn('[live2d] 表情切换失败', name, e);
    }
  }

  boot();
})();
