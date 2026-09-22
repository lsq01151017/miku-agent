/**
 * 渲染端:连上 World 的 `/state` 推流,把通道值写到 Live2D 模型上;右下角是同一份数据的数值面板。
 *
 * 分工是清楚的:**World 算通道值**(内部状态 + 词表片段 + 待机动作),这里只做五件事——
 * 把抽象通道名按素材包的 `suggests` 映到模型参数、把突变平滑成动作、在说话时对口型、
 * 让眼睛跟着指针(只眼睛和一点头,不碰身体)、把此刻的数值照实显示出来。
 *
 * 口型是按说话时长跑的振荡,**不是音频同步**:没有语音合成就没有音素时间轴,
 * 说成"唇形同步"是撒谎。说话一停它就回到基线。
 *
 * 缩放、位置、复位是给人用的取景工具:存下来的取景只影响画面,不回写模型,也不进 World。
 *
 * 页面版本随帧下发:与入口注入的不符就自刷新,挂着没刷新的旧标签页重连后自己换成新页面。
 */
(function () {
  'use strict';

  var VIEW_KEY = 'cortico.live2d.view';

  /**
   * 眼神跟随的时间常数(秒):指针一动,眼睛按这个时间常数指数逼近。
   *
   * 不用 pixi 的 `autoInteract`。它把指针映射成从模型中心出发的**角度**,目标点永远落在单位圆上
   * (看哪儿都是满偏),再用速度上限约 0.6/秒的物理逼近,满量程要 1.6 秒才到——又慢又不像在看你;
   * 它还会写 `ParamBodyAngleX`,于是腰跟着鼠标转。这里自己算:按**指针位置**给偏移(看着她的脸
   * 就是看正前方)、指数逼近、只写眼睛和一点头,身体不动。
   */
  var LOOK_TAU_SEC = 0.015;
  /** 眼神跟随的幅度:眼睛满偏,头只跟一点。 */
  var LOOK_EYE_RANGE = 1;
  var LOOK_HEAD_DEG = 6;
  /** 摸头:按住左键在她头上。页面每两秒续一次,World 那边超时自己收。 */
  var PAT_REFRESH_MS = 2000;
  /** 摸头时头跟着手转的幅度(度);平时只跟一点。 */
  var PAT_HEAD_DEG = 22;
  /**
   * 摸头识别区的椭圆:中心与半轴,写成锚点网格范围的分位(画布坐标 Y 向下,从网格上沿量起)。
   * 按真实模型标定:中心在网格上沿往下 0.29 网格高,半轴 0.36 网格宽 / 0.42 网格高——
   * 盖住头顶与额头,下缘落在脸颊上沿附近,不盖嘴与身上。
   */
  var PAT_REGION_CX = 0.53;
  var PAT_REGION_CY = 0.29;
  var PAT_REGION_RX = 0.36;
  var PAT_REGION_RY = 0.42;

  /** 底部输入区留多少条历史(收起时只看得到最近一句);字幕在她说完之后留一会儿再淡掉。 */
  var MINE_LINES = 50;
  /** 拖到多远也要留这么多像素的她可见。 */
  var KEEP_VISIBLE_PX = 80;
  var SUBTITLE_MS = 9000;
  var SYSTEM_SUBTITLE_MS = 6000;
  var AGENT_CHAT_PATH = '/agent/chat';
  var PANEL_MORE_KEY = 'cortico.live2d.panelMore';
  /** 附图与控制台对话框同一套上限:8 张、长边 2048、单张 6MB(终端通道收 8MB)。 */
  var MAX_IMAGES = 8;
  var IMAGE_MAX_EDGE = 2048;
  var IMAGE_MAX_BYTES = 6 * 1024 * 1024;
  var IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

  /** 情绪六维的中文名;与 `bots/miku/persona/emotion.ts` 的维度同键。 */
  var EMOTION_LABELS = {
    valence: '心情', arousal: '活力', bond: '羁绊',
    loneliness: '寂寞', shyness: '害羞', empathy: '关切',
  };

  var el = {
    canvas: document.getElementById('stage'),
    hit: document.getElementById('hit'),
    conn: document.getElementById('conn'),
    why: document.getElementById('why'),
    mood: document.getElementById('mood'),
    bars: document.getElementById('bars'),
    expression: document.getElementById('expression'),
    clips: document.getElementById('clips'),
    speaking: document.getElementById('speaking'),
    clients: document.getElementById('clients'),
    channels: document.getElementById('channels'),
    zoom: document.getElementById('zoom'),
    zoomVal: document.getElementById('zoom-val'),
    offsetX: document.getElementById('offset-x'),
    offsetXVal: document.getElementById('offset-x-val'),
    offsetY: document.getElementById('offset-y'),
    offsetYVal: document.getElementById('offset-y-val'),
    reset: document.getElementById('btn-reset'),
    save: document.getElementById('btn-save'),
    btnDrag: document.getElementById('btn-drag'),
    subtitle: document.getElementById('subtitle'),
    composer: document.getElementById('composer'),
    mine: document.getElementById('mine'),
    composerForm: document.getElementById('composer-form'),
    composerInput: document.getElementById('composer-input'),
    history: document.getElementById('btn-history'),
    tray: document.getElementById('tray'),
    dialogRow: document.getElementById('dialog-row'),
    ctx: document.getElementById('ctx'),
    ctxFill: document.getElementById('ctx-fill'),
    ctxNum: document.getElementById('ctx-num'),
    btnPerm: document.getElementById('btn-perm'),
    permPop: document.getElementById('perm-pop'),
    btnModel: document.getElementById('btn-model'),
    modelPop: document.getElementById('model-pop'),
    btnAttach: document.getElementById('btn-attach'),
    fileInput: document.getElementById('file-input'),
    panelMore: document.getElementById('panel-more'),
    panelMoreButton: document.getElementById('btn-panel'),
  };

  function why(message) {
    if (!el.why) return;
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
  // 表情参数:整组开关的清单(每帧先清零),与当前表情要写的值。都由 World 从模型自己的
  // exp3 推导下发,这里不写死参数名。
  var expressionParams = null;
  var expressionValues = null;
  // 不归通道管的参数定值(例如模型的水印开关),每帧照写一次,免得被表情或动作改回去。
  var overrides = {};
  // 模型自己的眨眼参数:这几路的开合归眨眼逻辑,通道值只在它上面叠加,不覆盖它。
  var blinkParams = {};
  // 取景:画面上的缩放与位置,与模型无关。
  var view = { zoom: 1, x: 0, y: 0 };
  var fitScale = 1;
  // 模型自己的尺寸,加载后量一次(那时 scale 是 1);取景一律用它算,不用会随缩放变的 width/height。
  var naturalW = 0;
  var naturalH = 0;
  var dragging = null;
  // 拖动是开关的:面板「更多」里按下「拖动」以后,覆层上的拖动才生效——平时点画面只是点。
  var dragArmed = false;
  // 摸头:左键按在头上(不开「拖动」)就是摸,不是拖。
  var patting = false;
  var patTimer = null;
  // 摸头识别区锚定的头部网格(ArtMesh id),来自素材包的 /pack/pat.json;空 = 不启用摸头。
  var headMeshes = [];
  /** 只启动一次(见 boot)。 */
  var booted = false;
  // 眼神跟随:目标来自指针位置,当前值指数逼近它。光标停住超过 LOOK_HOLD_MS,
  // 目标才回到正前方——停着不动的那段时间里,她一直盯着它。
  var look = { x: 0, y: 0, targetX: 0, targetY: 0 };
  var lookHoldUntilMs = 0;
  var LOOK_HOLD_MS = 2000;
  var lookParams = null;
  var lastTickMs = 0;
  // 对话:走控制台那条 WebSocket,或者走外部 Agent;字幕文本与它的淡出计时在这里。
  var chatSocket = null;
  var useAgent = false;
  var subtitleText = '';
  var subtitleTimer = null;
  // 附图:进托盘时归一化成 base64,发话时随文本走终端通道的 images 字段。
  var attached = [];
  var attachPending = 0;
  var attachNote = '';
  // 权限真值在 work 配置组里(/dialog/config);没取到过时按钮只占位。
  var permValue = null;
  // 模型选择器:端点清单(/dialog/providers)与各实例的模型目录(/dialog/models)。
  var providerList = null;
  var modelCatalogs = {};
  var barFill = {};
  var barNum = {};
  var channelRows = {};
  // 页面版本(World 注入在入口里,入口与页面脚本的摘要)。帧里带的版本与它不符,说明这份
  // 页面是旧的:刷新成新的——换过页面之后挂着的旧标签页,重连后自己换装,不必记得手动刷新。
  var pageVersion = String(window.__DSH_PAGE_VER__ || '');

  function loadView() {
    try {
      var raw = window.localStorage && window.localStorage.getItem(VIEW_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (typeof saved.zoom === 'number') view.zoom = saved.zoom;
      if (typeof saved.x === 'number') view.x = saved.x;
      if (typeof saved.y === 'number') view.y = saved.y;
    } catch (e) { /* 存不下来就用默认取景 */ }
  }

  function saveView() {
    try {
      if (window.localStorage) window.localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch (e) { /* 同上 */ }
  }

  function fit() {
    if (!app) return;
    app.renderer.resize(window.innerWidth, window.innerHeight);
    if (!model) return;
    fitScale = fitScaleFor();
    applyTransform();
  }

  /**
   * 模型贴合窗口的缩放。
   *
   * 只能用模型自己的尺寸(加载时 scale 是 1,那一刻量到的才是它):模型的 width/height 含当前缩放,
   * 拿它算会把缩放一次次乘回去——拖动时每动一下算一次,她就一会正常一会巨大,看着像多出一个自己。
   */
  function fitScaleFor() {
    if (naturalW <= 0 || naturalH <= 0) return fitScale;
    var base = Math.min(window.innerWidth / naturalW, window.innerHeight / naturalH);
    // 窗口量到 0(最小化、切标签)时别把她缩成 0:那看起来就是"模型突然不见了"。
    return isFinite(base) && base > 0 ? base : fitScale;
  }

  /** 缩放与位置套到模型上;取景只影响画面,不回写模型。 */
  function applyTransform() {
    if (!model) return;
    fitScale = fitScaleFor();
    var scale = fitScale * view.zoom;
    // 至少留 KEEP_VISIBLE_PX 像素的她还在画面里:拖到头也不会整个人消失。
    var halfW = (naturalW * scale) / 2;
    var halfH = (naturalH * scale) / 2;
    var limitX = Math.max(0, halfW + window.innerWidth / 2 - KEEP_VISIBLE_PX);
    var limitY = Math.max(0, halfH + window.innerHeight / 2 - KEEP_VISIBLE_PX);
    view.x = Math.max(-limitX, Math.min(limitX, view.x));
    view.y = Math.max(-limitY, Math.min(limitY, view.y));
    model.scale.set(scale);
    model.position.set(window.innerWidth / 2 + view.x, window.innerHeight / 2 + view.y);
    if (el.zoomVal) el.zoomVal.textContent = Math.round(view.zoom * 100) + '%';
    if (el.offsetXVal) el.offsetXVal.textContent = String(Math.round(view.x));
    if (el.offsetYVal) el.offsetYVal.textContent = String(Math.round(view.y));
    if (el.offsetX) el.offsetX.value = String(Math.round(view.x));
    if (el.offsetY) el.offsetY.value = String(Math.round(view.y));
  }

  /**
   * 输入区与字幕。
   *
   * 按操作员看到的来分:她的话是**字幕**(浮在模型上方的一条扁条,一段一段替换),我发过的话
   * 只在底部输入区里列着(扁平的,没有滚动条)。两条路都能接:
   *   - 配了 `agentUrl`:输入 `POST` 本 World 的 `/agent/chat`,由 World 转给外部 Agent,把它
   *     吐回来的增量流回来当字幕(同一段文本也驱动她的动作);
   *   - 只配了 `consoleUrl`:输入走 `/chat` 这条 WebSocket,与控制台的终端页是同一个对话。
   */
  function bindComposer() {
    if (!el.composer) return;
    if (el.composerForm) {
      el.composerForm.addEventListener('submit', function (event) {
        if (event && event.preventDefault) event.preventDefault();
        if (attachPending > 0) return;   // 图还在归一化,别把半批发出去
        var text = el.composerInput ? String(el.composerInput.value || '').trim() : '';
        var images = attached.splice(0, attached.length);
        if (text === '' && images.length === 0) return;
        if (el.composerInput) el.composerInput.value = '';
        attachNote = '';
        renderTray();
        say(text, images);
      });
    }
    if (el.history) el.history.addEventListener('click', toggleHistory);
    if (el.btnAttach && el.fileInput) {
      el.btnAttach.addEventListener('click', function () { el.fileInput.click(); });
      el.fileInput.addEventListener('change', function (event) {
        var target = event.currentTarget || {};
        addFiles(target.files || []);
        target.value = '';   // 同一张再选一次也要触发 change
      });
    }
    // 拖图进输入区、往输入框里贴图,与点附图钮同一条路。
    el.composer.addEventListener('dragover', function (event) {
      var types = event.dataTransfer ? event.dataTransfer.types : null;
      if (!types || Array.prototype.indexOf.call(types, 'Files') < 0) return;
      event.preventDefault();
      setDragover(true);
    });
    el.composer.addEventListener('dragleave', function () { setDragover(false); });
    el.composer.addEventListener('drop', function (event) {
      setDragover(false);
      var files = event.dataTransfer ? event.dataTransfer.files : null;
      if (!files || files.length === 0) return;
      event.preventDefault();
      addFiles(files);
    });
    if (el.composerInput) {
      el.composerInput.addEventListener('paste', function (event) {
        var all = event.clipboardData ? event.clipboardData.files : [];
        var files = Array.prototype.filter.call(all, isImageFile);
        if (files.length === 0) return;
        event.preventDefault();
        addFiles(files);
      });
    }
    fetch('/pack/chat.json', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (info) {
        useAgent = Boolean(info && info.agent);
        if (!info || (!info.enabled && !info.agent)) {
          showSubtitle('这一页没有接话的地方:在 worlds.live2d.consoleUrl 或 agentUrl 里填一个地址。', true);
          return;
        }
        el.composer.className = 'glass';
        if (!useAgent) openChat();
        // 走控制台的那三样(用量/模型/权限)没配控制台就不出现;附图与历史、发送不依赖控制台。
        if (info.console && el.dialogRow) {
          el.dialogRow.className = 'on';
          bindDialogBar();
        }
      })
      .catch(function () { showSubtitle('取 /pack/chat.json 失败,输入区没开。', true); });
  }

  /** 我说了一句话:记在底部,再按接的是哪条路发出去;图随文本一起走。 */
  function say(text, images) {
    addMine(text, images ? images.length : 0);
    if (useAgent) sendToAgent(text);
    else sendChat(text, images);
  }

  /** 我发过的话:平时只留最近一句,按「历史」展开;一条一行,不出现滚动条。 */
  function addMine(text, imageCount) {
    if (!el.mine) return;
    var line = document.createElement('div');
    var mark = imageCount > 0 ? '[图×' + imageCount + ']' : '';
    line.textContent = text === '' ? mark : text + (mark ? ' ' + mark : '');
    el.mine.appendChild(line);
    while (el.mine.children.length > MINE_LINES) el.mine.removeChild(el.mine.children[0]);
    if (el.history) {
      el.history.textContent = el.mine.children.length > 1
        ? (el.composer && el.composer.className.indexOf('expanded') >= 0 ? '收起' : '历史 ' + el.mine.children.length)
        : '历史';
      el.history.disabled = el.mine.children.length <= 1;
    }
  }

  /** 展开/收起我发过的话:收起时只看得到最近一句。 */
  function toggleHistory() {
    if (!el.composer || !el.history) return;
    var expanded = el.composer.className.indexOf('expanded') >= 0;
    el.composer.className = expanded
      ? el.composer.className.replace(' expanded', '')
      : el.composer.className + ' expanded';
    el.history.textContent = el.composer.className.indexOf('expanded') >= 0
      ? '收起'
      : (el.mine && el.mine.children.length > 0 ? '历史 ' + el.mine.children.length : '历史');
  }

  /** 字幕换一整段(终端通道给的是整句)。 */
  function showSubtitle(text, system) {
    subtitleText = typeof text === 'string' ? text : '';
    renderSubtitle(system ? SYSTEM_SUBTITLE_MS : SUBTITLE_MS);
  }

  /** 字幕接一段增量(外部 Agent 是流着吐的)。 */
  function appendSubtitle(delta) {
    subtitleText += delta;
    renderSubtitle(SUBTITLE_MS);
  }

  function renderSubtitle(holdMs) {
    if (!el.subtitle) return;
    // 换行照显,但行尾空白与空行去掉:流式吐字时它们会多顶出一行,看着就是凭空多出来的行距。
    var shown = subtitleText.replace(/[ \t]+$/gm, '').replace(/\n{2,}/g, '\n').replace(/\n+$/, '');
    el.subtitle.textContent = shown;
    el.subtitle.className = shown === '' ? 'glass' : 'glass on';
    if (subtitleTimer !== null) clearTimeout(subtitleTimer);
    subtitleTimer = setTimeout(function () {
      subtitleTimer = null;
      // 她还在说就先留着;说完了这一条自己淡掉。
      if (!speaking) el.subtitle.className = 'glass';
    }, holdMs);
  }

  /** 新的一段开始时把上一条字幕清掉:她的下一句不是接在上一句后面。 */
  function beginSubtitle() { subtitleText = ''; }

  function openChat() {
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      chatSocket = new WebSocket(protocol + '//' + window.location.host + '/chat');
    } catch (e) {
      showSubtitle('打不开对话通道:' + e.message, true);
      return;
    }
    chatSocket.onopen = function () { sendChat(null); };
    chatSocket.onclose = function () { showSubtitle('对话通道断开了,刷新页面重连。', true); };
    chatSocket.onerror = function () { showSubtitle('对话通道连不上。', true); };
    chatSocket.onmessage = function (event) {
      var payload;
      try { payload = JSON.parse(event.data); } catch (e) { return; }
      if (!payload) return;
      if (payload.type === 'sys' && typeof payload.text === 'string') { showSubtitle(payload.text, true); return; }
      if (typeof payload.text !== 'string' || payload.text === '') return;
      var from = typeof payload.from === 'string' ? payload.from : '';
      if (from === '制作人' || from === '控制台') return;   // 我自己的话已经记在输入区了
      if (from === '') { showSubtitle(payload.text, true); return; }
      if (!speaking) beginSubtitle();
      showSubtitle(payload.text);
    };
  }

  /** `text` 为 null 时只报上名字(连上就报一次);有图时随文本一起发。 */
  function sendChat(text, images) {
    if (!chatSocket || chatSocket.readyState !== 1) return;
    if (text === null) {
      chatSocket.send(JSON.stringify({ type: 'hello', name: '制作人' }));
      return;
    }
    var payload = { type: 'msg', text: text };
    if (images && images.length > 0) {
      payload.images = images.map(function (img) {
        return { mime: img.mime, base64: img.base64, name: img.name };
      });
    }
    chatSocket.send(JSON.stringify(payload));
  }

  /** 外部 Agent:一句话 POST 到本 World,它转给 Agent 并把返回的增量流回来。 */
  function sendToAgent(text) {
    beginSubtitle();
    fetch(AGENT_CHAT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    }).then(function (response) {
      if (!response.body || typeof response.body.getReader !== 'function') return response.text();
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var pump = function () {
        return reader.read().then(function (result) {
          if (result.done) return;
          buffer += decoder.decode(result.value, { stream: true });
          var at;
          while ((at = buffer.indexOf('\n\n')) >= 0) {
            var block = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            block.split('\n').forEach(function (line) {
              if (line.indexOf('data:') !== 0) return;
              handleAgentChunk(line.slice(5).trim());
            });
          }
          return pump();
        });
      };
      return pump();
    }).catch(function (error) {
      showSubtitle('送不出去:' + error.message, true);
    });
  }

  function handleAgentChunk(payload) {
    if (payload === '' || payload === '[DONE]') return;
    var text = payload;
    if (payload.charAt(0) === '{') {
      try {
        var parsed = JSON.parse(payload);
        if (typeof parsed.error === 'string') { showSubtitle(parsed.error, true); return; }
        if (parsed.done) return;
        text = typeof parsed.delta === 'string' ? parsed.delta : '';
      } catch (e) { /* 不是 JSON 就整段当文本 */ }
    }
    if (text !== '') appendSubtitle(text);
  }

  // ── 对话框四件套:附图、上下文用量、运行开关、模型选择 ────────────────────
  // 数据都在 World 那边转一手(/dialog/* 与状态帧),页面只连 18795 这一个来源。

  function isImageFile(file) {
    return file && IMAGE_MIMES.indexOf(file.type) >= 0;
  }

  function readAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('读不进 ' + (file.name || '图片'))); };
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.readAsDataURL(file);
    });
  }

  /** 只缩不放:长边不超过上限的原样保留。 */
  function fitWithin(width, height, maxEdge) {
    var edge = Math.max(width, height);
    if (!(edge > maxEdge) || maxEdge <= 0) return { width: width, height: height };
    var scale = maxEdge / edge;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  function encodeBitmap(bitmap, width, height, mime, quality) {
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    if (!ctx) return Promise.reject(new Error('画不出缩放图'));
    ctx.drawImage(bitmap, 0, 0, width, height);
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('编码失败'));
      }, mime, quality);
    });
  }

  /**
   * 归一化一张图:能解码就只缩不放(长边 2048),超字节上限退 JPEG;解码不了(或环境里没有
   * 解码 API)就原样读 base64,由终端通道的字节上限把门。
   */
  function normalizeImage(file) {
    if (!isImageFile(file)) {
      return Promise.reject(new Error((file.name || '这个文件') + '不是 JPEG/PNG/WebP/GIF'));
    }
    var name = file.name || 'image';
    if (typeof createImageBitmap !== 'function') {
      if (file.size > IMAGE_MAX_BYTES) return Promise.reject(new Error(name + '超过 6MB'));
      return readAsDataURL(file).then(function (url) {
        return { name: name, mime: file.type, base64: url.slice(url.indexOf(',') + 1),
                 bytes: file.size, width: 0, height: 0, src: url };
      });
    }
    var bitmap = null;
    return Promise.resolve().then(function () {
      return createImageBitmap(file);
    }).then(function (decoded) {
      bitmap = decoded;
      var fitted = fitWithin(bitmap.width, bitmap.height, IMAGE_MAX_EDGE);
      var untouched = fitted.width === bitmap.width && fitted.height === bitmap.height
        && file.size <= IMAGE_MAX_BYTES;
      if (untouched) {
        return readAsDataURL(file).then(function (url) {
          return { name: name, mime: file.type, base64: url.slice(url.indexOf(',') + 1),
                   bytes: file.size, width: bitmap.width, height: bitmap.height, src: url };
        });
      }
      // 缩放后先试原格式(GIF 没有 canvas 编码器,退 PNG);超字节上限再退 JPEG。
      var preferred = file.type === 'image/gif' ? 'image/png' : file.type;
      return encodeBitmap(bitmap, fitted.width, fitted.height, preferred).then(function (blob) {
        var mime = preferred;
        var chain = Promise.resolve(blob);
        if (blob.size > IMAGE_MAX_BYTES && preferred !== 'image/jpeg') {
          chain = encodeBitmap(bitmap, fitted.width, fitted.height, 'image/jpeg', 0.85).then(function (jpeg) {
            mime = 'image/jpeg';
            return jpeg;
          });
        }
        return chain.then(function (final) {
          if (final.size > IMAGE_MAX_BYTES) throw new Error(name + '缩放后仍超过 6MB');
          return readAsDataURL(final).then(function (url) {
            return { name: name, mime: mime, base64: url.slice(url.indexOf(',') + 1),
                     bytes: final.size, width: fitted.width, height: fitted.height, src: url };
          });
        });
      });
    }).then(function (image) {
      if (bitmap) bitmap.close();
      return image;
    }, function (error) {
      if (bitmap) bitmap.close();
      throw error instanceof Error ? error : new Error(String(error));
    });
  }

  /** 收一批文件:超张数整批拒;单张失败只报那一张,其余照收。 */
  function addFiles(files) {
    var list = Array.prototype.filter.call(files, isImageFile);
    if (list.length === 0) return;
    if (attached.length + attachPending + list.length > MAX_IMAGES) {
      attachNote = '一条消息最多 ' + MAX_IMAGES + ' 张图';
      renderTray();
      return;
    }
    attachNote = '';
    attachPending += list.length;
    renderTray();
    list.forEach(function (file) {
      normalizeImage(file).then(function (image) {
        attached.push(image);
        renderTray();
      }, function (error) {
        attachNote = error.message || String(error);
        renderTray();
      }).then(function () {
        attachPending -= 1;
        renderTray();
      });
    });
  }

  /** 图托盘:缩略图、移除钮与拒收/处理中的说明。 */
  function renderTray() {
    if (!el.tray) return;
    el.tray.textContent = '';
    if (attachNote) {
      var note = document.createElement('div');
      note.className = 'note';
      note.textContent = attachNote;
      el.tray.appendChild(note);
    }
    attached.forEach(function (at) {
      var thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.title = at.name + ' · ' + Math.round(at.bytes / 1024) + 'KB'
        + (at.width ? ' · ' + at.width + '×' + at.height : '');
      var img = document.createElement('img');
      img.src = at.src;
      img.alt = at.name;
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = '移除 ' + at.name;
      remove.addEventListener('click', function () {
        var at2 = attached.indexOf(at);
        if (at2 >= 0) attached.splice(at2, 1);
        attachNote = '';
        renderTray();
      });
      thumb.appendChild(img);
      thumb.appendChild(remove);
      el.tray.appendChild(thumb);
    });
    if (attachPending > 0) {
      var pend = document.createElement('div');
      pend.className = 'note';
      pend.textContent = '处理 ' + attachPending + ' 张…';
      el.tray.appendChild(pend);
    }
    el.tray.className = (attached.length > 0 || attachNote !== '' || attachPending > 0) ? 'on' : '';
  }

  function setDragover(on) {
    if (!el.composer) return;
    var has = el.composer.className.indexOf('dragover') >= 0;
    if (on && !has) el.composer.className += ' dragover';
    if (!on && has) el.composer.className = el.composer.className.replace(' dragover', '');
  }

  function fmtCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  /** 权限按钮:真权限(每次问/放行/关),值在 work 配置组;没取到之前只占位,不动作。 */
  function renderPermChip() {
    if (!el.btnPerm) return;
    var known = permValue === 'ask' || permValue === 'trusted' || permValue === 'off';
    el.btnPerm.textContent = !known ? '权限 —'
      : (permValue === 'ask' ? '权限·每次问' : (permValue === 'trusted' ? '权限·已放行' : '权限·已关'));
    el.btnPerm.className = !known ? '' : (permValue === 'trusted' ? 'trusted' : (permValue === 'off' ? 'off' : ''));
    el.btnPerm.title = !known ? '权限:还没取到'
      : (permValue === 'ask' ? '权限:她请 DSH 干活,越出工作区的动作要在 DSH 里点允许'
        : (permValue === 'trusted' ? '权限:全放行,不再弹审批卡' : '权限:关着,她请不动 DSH'));
  }

  /** 状态帧 → 读数行:用量条按预算画,过软预警线变黄、满变红;运行牌子照帧里的画。 */
  function renderStatus(status) {
    if (!status || typeof status !== 'object') return;
    var est = typeof status.estTokens === 'number' ? status.estTokens : null;
    var max = typeof status.maxTokens === 'number' && status.maxTokens > 0
      ? status.maxTokens
      : (typeof status.hardTokens === 'number' && status.hardTokens > 0 ? status.hardTokens : null);
    if (el.ctxNum) {
      el.ctxNum.textContent = est === null ? '—'
        : (max === null ? fmtCount(est) : fmtCount(est) + '/' + fmtCount(max));
    }
    if (el.ctx && el.ctxFill) {
      var ratio = est !== null && max !== null ? est / max : 0;
      el.ctxFill.style.width = (Math.min(1, Math.max(0, ratio)) * 100).toFixed(1) + '%';
      var soft = typeof status.softRatio === 'number' ? status.softRatio : null;
      el.ctx.className = ratio >= 1 ? 'danger' : (soft !== null && ratio >= soft ? 'warn' : '');
      el.ctx.title = '她的上下文用量' + (max !== null ? '(预算 ' + fmtCount(max) + ')' : '');
    }
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (response) {
      return response.json();
    }).catch(function () {
      return { error: '连不上' };
    });
  }

  function bindDialogBar() {
    if (el.btnPerm) {
      el.btnPerm.addEventListener('click', togglePermPop);
      // 权限值在 work 配置组里;那个组不在(work 扩展没装)就把按钮收掉。
      fetch('/dialog/config?group=work', { cache: 'no-store' })
        .then(function (response) { return response.json(); })
        .then(function (out) {
          if (out && out.error) {
            el.btnPerm.style.display = 'none';
            return;
          }
          var value = out && out.values && out.values['worlds.work.permission'];
          if (value === 'ask' || value === 'trusted' || value === 'off') {
            permValue = value;
            renderPermChip();
          }
        })
        .catch(function () { /* 取不到先占位;弹层打开时会再取 */ });
    }
    if (el.btnModel) el.btnModel.addEventListener('click', toggleModelPop);
    if (el.permPop && document.addEventListener) {
      document.addEventListener('pointerdown', function (event) {
        if (el.permPop.className.indexOf('on') < 0) return;
        var target = event.target;
        if (target === el.btnPerm || target === el.permPop) return;
        for (var i = 0; i < el.permPop.children.length; i++) {
          if (el.permPop.children[i] === target) return;
        }
        closePermPop();
      });
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') closePermPop();
      });
    }
    if (el.modelPop && document.addEventListener) {
      document.addEventListener('pointerdown', function (event) {
        if (el.modelPop.className.indexOf('on') < 0) return;
        var target = event.target;
        if (target === el.btnModel || target === el.modelPop) return;
        for (var i = 0; i < el.modelPop.children.length; i++) {
          if (el.modelPop.children[i] === target) return;
        }
        closeModelPop();
      });
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') closeModelPop();
      });
    }
  }

  function toggleModelPop() {
    if (!el.modelPop) return;
    if (el.modelPop.className.indexOf('on') >= 0) {
      closeModelPop();
      return;
    }
    el.modelPop.className = 'glass on';
    refreshModelPop();
  }

  function closeModelPop() {
    if (el.modelPop) el.modelPop.className = 'glass';
  }

  function refreshModelPop() {
    if (!el.modelPop) return;
    el.modelPop.textContent = '';
    var loading = document.createElement('div');
    loading.className = 'note';
    loading.textContent = '取端点清单…';
    el.modelPop.appendChild(loading);
    fetch('/dialog/providers', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (!el.modelPop || el.modelPop.className.indexOf('on') < 0) return;   // 已经收起
        if (data && data.error) { renderModelError(data.error); return; }
        providerList = data;
        renderModelPop(null);
      })
      .catch(function (error) { renderModelError(String(error)); });
  }

  function renderModelError(message) {
    if (!el.modelPop) return;
    el.modelPop.textContent = '';
    var note = document.createElement('div');
    note.className = 'note';
    note.textContent = message;
    el.modelPop.appendChild(note);
  }

  /** 画端点清单;expanded 是已展开模型目录的实例名。 */
  function renderModelPop(expanded) {
    if (!el.modelPop || !providerList) return;
    el.modelPop.textContent = '';
    var active = providerList.active || '';
    if (el.btnModel) {
      var hit = null;
      providerList.instances.forEach(function (instance) {
        if (instance.name === active) hit = instance;
      });
      el.btnModel.textContent = '模型·' + (hit ? (hit.model || hit.name) : (active || '—'));
      el.btnModel.title = hit
        ? '当前:' + hit.name + (hit.model ? ' · ' + hit.model : '')
        : '换她跑在哪个模型上';
    }
    if (!providerList.instances.length) {
      var empty = document.createElement('div');
      empty.className = 'note';
      empty.textContent = '没有端点实例;去控制台「语言模型」页配一个。';
      el.modelPop.appendChild(empty);
      return;
    }
    providerList.instances.forEach(function (instance) {
      var row = document.createElement('div');
      row.className = 'mrow' + (instance.name === active ? ' active' : '');
      var who = document.createElement('span');
      who.className = 'who';
      who.textContent = instance.name;
      var what = document.createElement('span');
      what.className = 'what';
      what.textContent = instance.model || '(未设模型)';
      row.appendChild(who);
      row.appendChild(what);
      row.title = '切到 ' + instance.name + (instance.model ? '(' + instance.model + ')' : '');
      row.addEventListener('click', function () { activateInstance(instance.name); });
      el.modelPop.appendChild(row);
      if (expanded === instance.name) renderCatalogRows(instance);
    });
  }

  /** 某个实例的模型目录:取到过就画成缩进的子行,当前模型打点。 */
  function renderCatalogRows(instance) {
    var catalog = modelCatalogs[instance.name];
    if (!catalog) {
      var loading = document.createElement('div');
      loading.className = 'note';
      loading.textContent = '取模型列表…';
      el.modelPop.appendChild(loading);
      return;
    }
    if (catalog.error) {
      var failed = document.createElement('div');
      failed.className = 'note';
      failed.textContent = '取不到模型列表:' + catalog.error;
      el.modelPop.appendChild(failed);
      return;
    }
    (catalog.models || []).forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'mrow sub' + (entry.id === instance.model ? ' active' : '');
      var what = document.createElement('span');
      what.className = 'what';
      what.textContent = entry.id;
      row.appendChild(what);
      row.title = '切到 ' + instance.name + ' · ' + entry.id;
      row.addEventListener('click', function (event) {
        if (event && event.stopPropagation) event.stopPropagation();
        activateModel(instance.name, entry.id);
      });
      el.modelPop.appendChild(row);
    });
  }

  /** 切端点实例;切完展开它的模型目录,再点子行才在实例内换模型名。 */
  function activateInstance(name) {
    postJson('/dialog/model', { name: name }).then(function (out) {
      if (!out || !out.ok) {
        showSubtitle((out && out.error) || '换模型失败', true);
        return;
      }
      if (providerList) providerList.active = name;
      if (modelCatalogs[name] === undefined) {
        modelCatalogs[name] = null;   // 取的路上
        renderModelPop(name);
        fetch('/dialog/models?name=' + encodeURIComponent(name), { cache: 'no-store' })
          .then(function (response) { return response.json(); })
          .then(function (data) {
            modelCatalogs[name] = data && data.error ? { error: data.error } : data;
            if (el.modelPop && el.modelPop.className.indexOf('on') >= 0) renderModelPop(name);
          })
          .catch(function (error) {
            modelCatalogs[name] = { error: String(error) };
            if (el.modelPop && el.modelPop.className.indexOf('on') >= 0) renderModelPop(name);
          });
      } else {
        renderModelPop(name);
      }
      var shown = null;
      providerList.instances.forEach(function (instance) {
        if (instance.name === name) shown = instance;
      });
      showSubtitle('已切到 ' + name + (shown && shown.model ? '(' + shown.model + ')' : ''), true);
    });
  }

  /** 实例内换模型名:World 会保住模型档的其余键,只改 model。 */
  function activateModel(name, model) {
    postJson('/dialog/model', { name: name, model: model }).then(function (out) {
      if (!out || !out.ok) {
        showSubtitle((out && out.error) || '换模型失败', true);
        return;
      }
      if (providerList) {
        providerList.active = name;
        providerList.instances.forEach(function (instance) {
          if (instance.name === name) instance.model = model;
        });
      }
      renderModelPop(name);
      showSubtitle('已切到 ' + name + ' · ' + model, true);
    });
  }

  // ── 权限选择单(真权限:每次问/放行/关)──────────────────────────────────

  var PERM_STATES = [
    { id: 'ask', label: '每次问', hint: '越界动作要在 DSH 里点允许' },
    { id: 'trusted', label: '放行', hint: '全放行,不弹卡' },
    { id: 'off', label: '关', hint: '她请不动 DSH' },
  ];
  // 配置组的键是 cfg 里的点分路径,不是裸键。
  var PERM_KEY = 'worlds.work.permission';

  function permLabelOf(value) {
    for (var i = 0; i < PERM_STATES.length; i++) {
      if (PERM_STATES[i].id === value) return PERM_STATES[i].label;
    }
    return value;
  }

  function togglePermPop() {
    if (!el.permPop) return;
    if (el.permPop.className.indexOf('on') >= 0) {
      closePermPop();
      return;
    }
    el.permPop.className = 'glass on';
    refreshPermPop();
  }

  function closePermPop() {
    if (el.permPop) el.permPop.className = 'glass';
  }

  function refreshPermPop() {
    if (!el.permPop) return;
    el.permPop.textContent = '';
    var loading = document.createElement('div');
    loading.className = 'note';
    loading.textContent = '取权限…';
    el.permPop.appendChild(loading);
    fetch('/dialog/config?group=work', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (out) {
        if (!el.permPop || el.permPop.className.indexOf('on') < 0) return;   // 已经收起
        if (!out || out.error) {
          renderPermError((out && out.error) || '取不到');
          return;
        }
        var value = out.values && out.values[PERM_KEY];
        if (value !== 'ask' && value !== 'trusted' && value !== 'off') {
          renderPermError('work 配置组里没有 permission 这个值');
          return;
        }
        permValue = value;
        renderPermChip();
        renderPermPop();
      })
      .catch(function (error) { renderPermError(String(error)); });
  }

  function renderPermError(message) {
    if (!el.permPop) return;
    el.permPop.textContent = '';
    var note = document.createElement('div');
    note.className = 'note';
    note.textContent = message;
    el.permPop.appendChild(note);
  }

  function renderPermPop() {
    if (!el.permPop) return;
    el.permPop.textContent = '';
    PERM_STATES.forEach(function (state) {
      var row = document.createElement('div');
      row.className = 'mrow' + (permValue === state.id ? ' active' : '');
      var who = document.createElement('span');
      who.className = 'who';
      who.textContent = state.label;
      var what = document.createElement('span');
      what.className = 'what';
      what.textContent = state.hint;
      row.appendChild(who);
      row.appendChild(what);
      row.title = '权限:' + state.label;
      row.addEventListener('click', function () { setPermission(state.id); });
      el.permPop.appendChild(row);
    });
  }

  /** 写回 work 配置组;控制台按 schema 校验,成了再照新值画。 */
  function setPermission(value) {
    var values = {};
    values[PERM_KEY] = value;
    postJson('/dialog/config', { group: 'work', values: values }).then(function (out) {
      if (!out || !out.ok) {
        showSubtitle((out && out.error) || '改权限失败', true);
        return;
      }
      permValue = value;
      renderPermChip();
      renderPermPop();
      showSubtitle('权限:' + permLabelOf(value), true);
    });
  }

  /** 面板上的取景控件:滑块与拖动都只改 `view`,改完立刻套到模型上。 */
  function bindControls() {
    if (el.zoom) {
      el.zoom.value = String(Math.round(view.zoom * 100));
      el.zoom.addEventListener('input', function () {
        view.zoom = Number(el.zoom.value) / 100;
        applyTransform();
      });
    }
    if (el.offsetX) {
      el.offsetX.value = String(Math.round(view.x));
      el.offsetX.addEventListener('input', function () {
        view.x = Number(el.offsetX.value);
        applyTransform();
      });
    }
    if (el.offsetY) {
      el.offsetY.value = String(Math.round(view.y));
      el.offsetY.addEventListener('input', function () {
        view.y = Number(el.offsetY.value);
        applyTransform();
      });
    }
    if (el.reset) {
      el.reset.addEventListener('click', function () {
        view = { zoom: 1, x: 0, y: 0 };
        if (el.zoom) el.zoom.value = '100';
        if (el.offsetX) el.offsetX.value = '0';
        if (el.offsetY) el.offsetY.value = '0';
        saveView();
        applyTransform();
      });
    }
    if (el.save) {
      el.save.addEventListener('click', function () { saveView(); });
    }

    // 指针全落在覆层上:画布自己不是事件目标,浏览器拖不出它的副本。
    // 拖动要先用面板里的「拖动」开关打开;没开时,左键按在头上是摸头。
    var dragSurface = el.hit || el.canvas;

    /**
     * 她的头在画面上的区域:锚定在素材包点名的头部网格上,按网格**此刻**的顶点量出来。
     * 点击先换算回画布坐标(toModelPosition 吃下取景与缩放),再对网格范围的头顶一圈做
     * 椭圆判定。网格跟着头动,识别区就一直在她头上;不按画布中心与固定分位估——画布中心
     * 不等于内容中心,估出来的区域会整个偏离她实际的头。
     */
    function headHit(clientX, clientY) {
      if (!model || headMeshes.length === 0) return false;
      var local = { x: 0, y: 0 };
      try { model.toModelPosition({ x: clientX, y: clientY }, local); } catch (e) { return false; }
      var box = headBox();
      if (!box) return false;
      var dx = (local.x - (box.x + box.width * PAT_REGION_CX)) / (box.width * PAT_REGION_RX);
      var dy = (local.y - (box.y + box.height * PAT_REGION_CY)) / (box.height * PAT_REGION_RY);
      return dx * dx + dy * dy <= 1;
    }

    /** 锚点网格此刻的并集范围(画布像素);一个都取不到就没有识别区。 */
    function headBox() {
      var internal = model && model.internalModel;
      if (!internal || typeof internal.getDrawableBounds !== 'function') return null;
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (var i = 0; i < headMeshes.length; i++) {
        var b = null;
        try { b = internal.getDrawableBounds(headMeshes[i]); } catch (e) { b = null; } // 模型没有这个网格
        if (!b) continue;
        x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
      }
      return isFinite(x0) ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
    }

    function sendPat(active) {
      try {
        fetch('/pat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: active }),
        }).catch(function () { /* 心跳会再试 */ });
      } catch (e) { /* 同上 */ }
    }

    function startPat() {
      if (patting) return;
      patting = true;
      sendPat(true);
      patTimer = setInterval(function () { sendPat(true); }, PAT_REFRESH_MS);
    }

    function endPat() {
      if (!patting) return;
      patting = false;
      if (patTimer) { clearInterval(patTimer); patTimer = null; }
      sendPat(false);
    }

    var setArmed = function (armed) {
      dragArmed = armed;
      if (!armed) dragging = null; // 开关关掉时若正拖着,就地停手
      if (el.btnDrag) {
        el.btnDrag.className = armed ? 'on' : '';
        el.btnDrag.textContent = armed ? '拖动：开' : '拖动：关';
      }
      if (dragSurface && dragSurface.className.indexOf) {
        dragSurface.className = dragSurface.className
          .replace(' armed', '').replace(' dragging', '') + (armed ? ' armed' : '');
      }
    };
    if (el.btnDrag && el.btnDrag.addEventListener) {
      el.btnDrag.addEventListener('click', function () { setArmed(!dragArmed); });
    }
    if (dragSurface && dragSurface.addEventListener) {
      dragSurface.addEventListener('pointerdown', function (event) {
        if (event && event.preventDefault) event.preventDefault();
        // 「拖动」没开时:左键按在头上是摸头,按在别处什么也不做。
        if (!dragArmed) {
          if (event.button === 0 && headHit(event.clientX, event.clientY)) startPat();
          return;
        }
        dragging = { x: event.clientX, y: event.clientY, fromX: view.x, fromY: view.y };
        if (dragSurface.className.indexOf('dragging') < 0) dragSurface.className += ' dragging';
        if (dragSurface.setPointerCapture) { try { dragSurface.setPointerCapture(event.pointerId); } catch (e) { /* 可选 */ } }
      });
      dragSurface.addEventListener('pointermove', function (event) {
        if (!dragging) return;
        // 松手时鼠标可能在窗口外(pointerup 收不到):这时按键已经不按了,直接当成松手,
        // 否则她会跟着鼠标一路滑出画面——看着就是"模型突然消失"。
        if (event.buttons === 0) { dragging = null; dragSurface.className = dragSurface.className.replace(' dragging', ''); return; }
        view.x = dragging.fromX + (event.clientX - dragging.x);
        view.y = dragging.fromY + (event.clientY - dragging.y);
        applyTransform();
      });
      var release = function () {
        endPat();
        if (!dragging) return;
        dragging = null;
        dragSurface.className = dragSurface.className.replace(' dragging', '');
        saveView();
      };
      dragSurface.addEventListener('pointerup', release);
      dragSurface.addEventListener('pointercancel', release);
      // 指针在窗口外松开、或切走标签页时也要收尾。
      if (window.addEventListener) {
        window.addEventListener('pointerup', release);
        window.addEventListener('blur', release);
        // 手离开窗口,摸头也就结束了(拖动不受影响:捕获还在,松手才收)。
        window.addEventListener('pointerleave', endPat);
      }
      dragSurface.addEventListener('dragstart', function (event) {
        if (event && event.preventDefault) event.preventDefault();
      });
    }
    if (document.addEventListener) {
      document.addEventListener('dragstart', function (event) {
        if (event && event.preventDefault) event.preventDefault();
      }, true);
    }
  }

  /** 面板的「更多」:情绪那几条常显,其余收起,用时展开;记住上次的选择。 */
  function bindPanelMore() {
    if (!el.panelMore || !el.panelMoreButton) return;
    var expanded = false;
    try {
      expanded = window.localStorage && window.localStorage.getItem(PANEL_MORE_KEY) === '1';
    } catch (e) { /* 读不到就用收起 */ }
    setPanelMore(expanded);
    el.panelMoreButton.addEventListener('click', function () {
      setPanelMore(el.panelMore.className.indexOf('collapsed') >= 0);
    });
  }

  function setPanelMore(expanded) {
    if (!el.panelMore || !el.panelMoreButton) return;
    el.panelMore.className = expanded ? '' : 'collapsed';
    el.panelMoreButton.textContent = expanded ? '收起 ▴' : '更多 ▾';
    try {
      if (window.localStorage) window.localStorage.setItem(PANEL_MORE_KEY, expanded ? '1' : '0');
    } catch (e) { /* 同上 */ }
  }

  /**
   * 眼神跟随的输入:指针在页面上的位置,折算成模型中心出发的 [-1,1] 偏移。
   *
   * 用整页而不是画布:鼠标移到面板上她也该看过去。光标一动就盯向它;停住满
   * `LOOK_HOLD_MS` 才许把眼神收回来(在 tick 里判),指针离开窗口则立刻收。
   */
  function bindLook() {
    var onMove = function (event) {
      if (typeof event.clientX !== 'number') return;
      var halfW = Math.max(1, window.innerWidth / 2);
      var halfH = Math.max(1, window.innerHeight / 2);
      look.targetX = Math.max(-1, Math.min(1, (event.clientX - window.innerWidth / 2) / halfW));
      look.targetY = Math.max(-1, Math.min(1, (event.clientY - window.innerHeight / 2) / halfH));
      lookHoldUntilMs = performance.now() + LOOK_HOLD_MS;
    };
    var onLeave = function () { look.targetX = 0; look.targetY = 0; lookHoldUntilMs = 0; };
    if (window.addEventListener) {
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerleave', onLeave);
      window.addEventListener('blur', onLeave);
    }
  }

  /**
   * 显卡上下文丢了(切标签太久、驱动回收)时,画面会突然变成空白——那看着就是"模型消失了"。
   * 这里给一句能读懂的话,别让人以为是她坏了。
   */
  function bindContextLoss() {
    if (!el.canvas || !el.canvas.addEventListener) return;
    el.canvas.addEventListener('webglcontextlost', function (event) {
      if (event && event.preventDefault) event.preventDefault();
      why('显卡上下文丢了(常见于切走标签页太久),画面会空着。刷新这一页就回来。');
    });
    el.canvas.addEventListener('webglcontextrestored', function () {
      if (el.why) el.why.style.display = 'none';
    });
  }

  /** 眼神跟随的参数名:由通道表决定(换模型只换映射),缺了就用 Cubism 的通用名。 */
  function resolveLookParams() {
    return {
      eyeX: channelParam.EyeRightX || 'ParamEyeBallX',
      eyeY: channelParam.EyeRightY || 'ParamEyeBallY',
      headX: channelParam.FaceAngleX || 'ParamAngleX',
      headY: channelParam.FaceAngleY || 'ParamAngleY',
    };
  }

  /** 情绪六维的行:一条一次建好,之后只改宽度与数字。 */
  function buildBars() {
    if (!el.bars) return;
    el.bars.innerHTML = '';
    Object.keys(EMOTION_LABELS).forEach(function (key) {
      var row = document.createElement('div');
      row.className = 'row';
      var name = document.createElement('span');
      name.textContent = EMOTION_LABELS[key];
      var track = document.createElement('span');
      track.className = 'bar';
      var fill = document.createElement('i');
      var num = document.createElement('span');
      num.className = 'num';
      num.textContent = '0.00';
      track.appendChild(fill);
      row.appendChild(name);
      row.appendChild(track);
      row.appendChild(num);
      el.bars.appendChild(row);
      barFill[key] = fill;
      barNum[key] = num;
    });
  }

  function updateBars(emotion) {
    if (!emotion) return;
    Object.keys(EMOTION_LABELS).forEach(function (key) {
      var value = typeof emotion[key] === 'number' ? emotion[key] : 0;
      var fill = barFill[key];
      var num = barNum[key];
      // valence 的取值范围是 -1..1,其余是 0..1;条子统一映射成 0..100%。
      var pct = key === 'valence' ? ((value + 1) / 2) * 100 : value * 100;
      if (fill && fill.style) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
      if (num) num.textContent = value.toFixed(2);
    });
  }

  /** 通道值的行:通道表是活的那一份,帧里出现什么就补一行,之后只更新数字。 */
  function updateChannels(channels) {
    if (!el.channels) return;
    Object.keys(channels).sort().forEach(function (channel) {
      var row = channelRows[channel];
      if (!row) {
        row = document.createElement('div');
        var name = document.createElement('span');
        name.textContent = channel;
        var num = document.createElement('span');
        row.appendChild(name);
        row.appendChild(num);
        el.channels.appendChild(row);
        channelRows[channel] = { num: num };
        row = channelRows[channel];
      }
      if (row.num) row.num.textContent = Number(channels[channel]).toFixed(2);
    });
  }

  async function boot() {
    // 只许进一次:脚本万一被加载两次,第二个 PIXI 应用会拿到同一个 canvas 的同一个 WebGL 上下文,
    // 两个舞台各画一个模型——屏幕上就是两个她。
    if (booted) return;
    booted = true;
    if (typeof PIXI === 'undefined' || !PIXI.live2d || !PIXI.live2d.Live2DModel) {
      why('播放器库没加载成功:检查 worlds.live2d.webDir 指向的目录里有没有 js/ 下那三个文件。');
      return;
    }
    loadView();
    buildBars();
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
    // 摸头的头部网格拿不到就没有这一层,页面其余照常。
    try {
      var patPack = await (await fetch('/pack/pat.json', { cache: 'no-store' })).json();
      headMeshes = (Array.isArray(patPack.headMeshes) ? patPack.headMeshes : []).filter(function (id) {
        return typeof id === 'string' && id !== '';
      });
    } catch (e) { /* 同上 */ }

    app = new PIXI.Application({
      view: el.canvas,
      autoStart: true,
      backgroundAlpha: 0,
      resizeTo: window,
      antialias: true,
    });

    var modelUrl = '/model/' + encodeURIComponent(window.__DSH_MODEL_FILE__ || '');
    try {
      // 关掉 pixi 自带的指针交互:眼神跟随我们自己算(见 LOOK_TAU_SEC 那段),否则腰会跟着鼠标转。
      model = await PIXI.live2d.Live2DModel.from(modelUrl, { autoInteract: false });
    } catch (e) {
      why('模型加载失败:' + e.message + '\n检查 worlds.live2d.modelDir。');
      return;
    }
    app.stage.addChild(model);
    // 刚加载完 scale 是 1,此刻的 width/height 才是模型自己的尺寸,后面都会带上缩放。
    naturalW = model.width;
    naturalH = model.height;
    fitScale = fitScaleFor();
    model.anchor.set(0.5, 0.5);
    blinkParams = blinkParameters(model.internalModel);
    lookParams = resolveLookParams();
    applyTransform();
    bindControls();
    bindPanelMore();
    bindLook();
    bindComposer();
    bindContextLoss();
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
   * 每帧写一次参数:通道值 + 口型 + 眼神跟随 + 表情开关 + 参数定值。
   *
   * 写入顺序是契约:通道与口型(眨眼组走加法,其余赋值) → 眼神跟随(加法) → 表情开关(先
   * 清零整组,再写当前那张的值) → 参数定值(赋值,最后写,只赢它点名的参数)。后一步可以
   * 叠加或覆盖前一步,反过来不行。
   *
   * 模型没有的参数(缺件)静默跳过,那正是 `losesIfMissing` 说的。眨眼参数与眼神跟随走加法
   * (叠加在通道值上),其余走赋值。
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
      var value = current[channel];
      var range = channelRange[channel];
      if (range) value = Math.min(range[1], Math.max(range[0], value));
      writeParam(core, param, value);
    });
    // 口型单独写:说话时是自己的振荡,不说话时听 World 的(片段能让她「张嘴」),两者取大的
    // 那个,所以说话当中被要求张嘴也看得出来。不平滑也不走 current——tick 把 MouthOpen 摘出
    // 平滑就是为了让它每帧直取帧值:片段的包络自带起落,再平滑一遍会把「张嘴」的峰值磨掉。
    var mouthParam = channelParam.MouthOpen;
    if (mouthParam) {
      var mouthValue = Math.max(mouthOpen, typeof target.MouthOpen === 'number' ? target.MouthOpen : 0);
      var mouthRange = channelRange.MouthOpen;
      if (mouthRange) mouthValue = Math.min(mouthRange[1], Math.max(mouthRange[0], mouthValue));
      writeParam(core, mouthParam, mouthValue);
    }
    // 眼神跟随:眼睛满偏,头只跟一点;摸头时头改成跟着手大幅转。不写身体参数——腰不跟着鼠标转。
    if (lookParams) {
      var headDeg = patting ? PAT_HEAD_DEG : LOOK_HEAD_DEG;
      addParam(core, lookParams.eyeX, look.x * LOOK_EYE_RANGE);
      addParam(core, lookParams.eyeY, -look.y * LOOK_EYE_RANGE);
      addParam(core, lookParams.headX, look.x * headDeg);
      addParam(core, lookParams.headY, -look.y * headDeg);
    }
    // 表情开关:先清零整组,再写当前那张的值。库的表情队列永不结束,挂过的表情会一直
    // 叠着(唱歌的开关残留,比心就显示成唱歌),所以这一层不走库,每帧自己写。
    if (expressionParams) {
      for (var i = 0; i < expressionParams.length; i++) {
        try { core.setParameterValueById(expressionParams[i], 0); } catch (e) { /* 模型没有这条参数 */ }
      }
    }
    if (expressionValues) {
      Object.keys(expressionValues).forEach(function (param) {
        try { core.setParameterValueById(param, expressionValues[param]); } catch (e) { /* 同上 */ }
      });
    }
    Object.keys(overrides).forEach(function (param) {
      try { core.setParameterValueById(param, overrides[param]); } catch (e) { /* 同上 */ }
    });
  }

  /**
   * 写一条通道值:眨眼组的参数走加法(开合归眨眼逻辑,通道只在它上面叠加),其余定值。
   * 模型没有这条参数就跳过。
   */
  function writeParam(core, param, value) {
    try {
      if (blinkParams[param]) {
        core.setParameterValueById(param, core.getParameterValueById(param) + value);
      } else {
        core.setParameterValueById(param, value);
      }
    } catch (e) { /* 模型没有这条参数 */ }
  }

  /** 在模型当前值上叠加一个偏移;模型没有这条参数就跳过。 */
  function addParam(core, param, value) {
    if (!param || value === 0) return;
    try {
      if (typeof core.addParameterValueById === 'function') core.addParameterValueById(param, value);
      else core.setParameterValueById(param, core.getParameterValueById(param) + value);
    } catch (e) { /* 模型没有这条参数 */ }
  }

  /**
   * 平滑在自己的帧里推进:通道是"想让它怎样",动作才像动作。写参数不在这一刻。
   *
   * 眼神跟随按**时间常数**逼近(与帧率无关),不用固定步长——固定步长在 30fps 上就慢一半。
   */
  function tick() {
    var now = performance.now();
    var dt = lastTickMs === 0 ? 0.016 : Math.min(0.1, (now - lastTickMs) / 1000);
    lastTickMs = now;
    // 光标停满 LOOK_HOLD_MS:眼神才许离开它,回正前方。停着的那段时间里一直盯着。
    if (lookHoldUntilMs !== 0 && now >= lookHoldUntilMs) {
      look.targetX = 0;
      look.targetY = 0;
      lookHoldUntilMs = 0;
    }
    var ease = 1 - Math.exp(-dt / LOOK_TAU_SEC);
    look.x += (look.targetX - look.x) * ease;
    look.y += (look.targetY - look.y) * ease;

    Object.keys(target).forEach(function (channel) {
      if (channel === 'MouthOpen') return; // 口型不平滑:每帧直取帧值(见 writeFrame)
      var to = target[channel];
      var from = current[channel] === undefined ? 0 : current[channel];
      current[channel] = from + (to - from) * 0.18;
    });
    requestAnimationFrame(tick);
  }

  function listen() {
    var source = new EventSource('/state');
    source.onopen = function () {
      if (!el.conn) return;
      // 徽章保持玻璃底:连上挂 LIVE(伪元素徽标跟着 .on 走),断开只换文本。
      el.conn.className = 'glass on';
      el.conn.textContent = '已连上她的形象';
    };
    source.onerror = function () {
      if (!el.conn) return;
      el.conn.className = 'glass';
      el.conn.textContent = '断开,重连中…';
    };
    source.onmessage = function (event) {
      var payload = JSON.parse(event.data);
      // 帧里的页面版本与入口注入的不符:这份页面是旧的,刷新成新的。文件没动过的重启版本不变,不会白刷。
      if (typeof payload.page === 'string' && payload.page !== pageVersion) {
        window.location.reload();
        return;
      }
      target = payload.channels || {};
      expressionParams = payload.expressionParams || null;
      expressionValues = payload.expressionValues || null;
      var nowSpeaking = Boolean(payload.speaking);
      if (nowSpeaking && !speaking) {
        speakStart = performance.now();
        // 新的一段:上一句字幕清掉,等这一句。
        if (!useAgent) beginSubtitle();
      }
      speaking = nowSpeaking;
      showState(payload);
      renderStatus(payload.status);
    };
  }

  /** 数值面板:照实显示这一刻的 World 状态,不做加工。 */
  function showState(payload) {
    if (el.mood) el.mood.textContent = payload.mood || '—';
    if (el.expression) el.expression.textContent = payload.expression || '—';
    if (el.clips) el.clips.textContent = (payload.clips && payload.clips.length) ? payload.clips.join(', ') : '—';
    if (el.speaking) el.speaking.textContent = payload.speaking ? '是' : '否';
    if (el.clients) el.clients.textContent = String(payload.clients == null ? 0 : payload.clients);
    updateBars(payload.emotion);
    updateChannels(payload.channels || {});
  }

  boot();
})();
