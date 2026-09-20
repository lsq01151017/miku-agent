/**
 * 播放器页面自己的逻辑:推流帧 → 通道值 → 模型参数,表情切换,以及右下角那块数值面板
 * (情绪六维、心情、表情、正在做的片段、通道值)和取景控件(缩放 / 左右 / 上下 / 复位 / 记住)。
 *
 * 渲染本身(WebGL/Cubism)只有浏览器能验,但页面**应用这些值的那段代码**可以在这里跑起来:
 * 用替身顶掉 document / PIXI / EventSource,喂一帧进去,推几帧,看它写了哪些参数、面板上出现了哪些数。
 *
 * 写参数发生在模型的 `beforeModelUpdate` 上(参数复位之后、更新之前),所以替身把那个钩子
 * 也截下来,由 `pump` 一帧一帧地推——这正是浏览器里每帧发生的事。
 *
 * 页面脚本是 IIFE,一个进程里只会 boot 一次(第二次 import 拿到的是同一份模块),
 * 所以这个文件里的检查都在同一次 boot 之后按顺序做完。
 */
import { afterEach, describe, expect, it } from 'vitest';

interface Written { param: string; value: number; added?: boolean }
interface FakeNode {
  id: string;
  className: string;
  textContent: string;
  value: string;
  style: Record<string, string>;
  children: FakeNode[];
  handlers: Record<string, Array<(event: Record<string, unknown>) => void>>;
  innerHTML: string;
  /** 点过几次(附图钮点开文件选择器这类主动作)。 */
  clicks: number;
  appendChild: (child: FakeNode) => FakeNode;
  removeChild: (child: FakeNode) => void;
  addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) => void;
  fire: (type: string, event?: Record<string, unknown>) => void;
  click: () => void;
}

/** 一次性的浏览器替身:记录页面写进模型的参数、面板上的数与取景,以及对话框。 */
function stubBrowser(): {
  written: Written[];
  scales: number[];
  positions: Array<{ x: number; y: number }>;
  nodes: Map<string, FakeNode>;
  stored: string[];
  instances: Array<{ onmessage: ((event: { data: string }) => void) | null }>;
  sockets: Array<{ url: string; sent: string[]; readyState: number; fire: (data: string) => void }>;
  /** 页面发出去的 POST(摸头的心跳)。 */
  posted: Array<{ url: string; body: string }>;
  /** 页面自刷新的次数:帧里的版本与入口注入的不符时刷新。 */
  reloads: number[];
  /** 摸头识别区的锚点网格范围(画布像素);挪动它即挪动模型的头。 */
  headBounds: { x: number; y: number; width: number; height: number };
  /** 触发 window 上的事件(页面用它接指针)。 */
  fireWindow: (type: string, event: Record<string, unknown>) => void;
  /** 触发 document 上的事件(模型选择器的收起走这里)。 */
  fireDocument: (type: string, event: Record<string, unknown>) => void;
  /** 跑 n 帧:每帧先走页面的 requestAnimationFrame,再走模型的 beforeModelUpdate。 */
  pump: (frames: number) => void;
} {
  const written: Written[] = [];
  const scales: number[] = [];
  const positions: Array<{ x: number; y: number }> = [];
  const nodes = new Map<string, FakeNode>();
  const stored: string[] = [];
  const instances: Array<{ onmessage: ((event: { data: string }) => void) | null }> = [];
  const sockets: Array<{
    url: string; sent: string[]; readyState: number;
    fire: (data: string) => void; onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null;
  }> = [];
  let pending: (() => void) | null = null;
  let beforeModelUpdate: (() => void) | null = null;
  let fakeNowMs = 0;
  const blink = 0.8;

  const makeNode = (id: string): FakeNode => {
    let textValue = '';
    const node: FakeNode = {
      id, className: '', value: '', style: {}, children: [],
      handlers: {}, clicks: 0,
      // 与真 DOM 一致:写 textContent 会清掉子节点(渲染函数靠它整块重画)。
      get textContent() { return textValue; },
      set textContent(value: string) { textValue = value; node.children.length = 0; },
      appendChild(child) { node.children.push(child); return child; },
      removeChild(child) {
        const at = node.children.indexOf(child);
        if (at >= 0) node.children.splice(at, 1);
        return child;
      },
      addEventListener(type, fn) { (node.handlers[type] = node.handlers[type] ?? []).push(fn); },
      fire(type, event) { for (const fn of node.handlers[type] ?? []) fn(event ?? {}); },
      click() { node.clicks += 1; },
      get innerHTML() { return ''; },
      set innerHTML(_value: string) { node.children.length = 0; },
    };
    return node;
  };
  const nodeFor = (id: string): FakeNode => {
    const existing = nodes.get(id);
    if (existing) return existing;
    const created = makeNode(id);
    nodes.set(id, created);
    return created;
  };

  // 摸头识别区的锚点网格(ArtMesh207)在画布上的范围;测试挪动它,验证识别区跟着网格走。
  const headBounds = { x: 20, y: 5, width: 60, height: 30 };
  const model = {
    // PIXI 容器的 width/height 含当前缩放。取景若拿它们算贴合比例,每算一次就再乘一次缩放。
    get width() { return 100 * model.scale.x; },
    get height() { return 100 * model.scale.x; },
    scale: {
      x: 1,
      set(value: number) { scales.push(value); model.scale.x = value; },
    },
    anchor: { set: () => {} },
    position: {
      x: 0,
      y: 0,
      set(x: number, y: number) { model.position.x = x; model.position.y = y; positions.push({ x, y }); },
    },
    // 画面坐标 → 画布像素,与 applyTransform 做的变换互逆(锚点在画布中心 50,50)。
    toModelPosition(point: { x: number; y: number }, out: { x: number; y: number }) {
      out.x = (point.x - model.position.x) / model.scale.x + 50;
      out.y = (point.y - model.position.y) / model.scale.x + 50;
      return out;
    },
    internalModel: {
      settings: {
        groups: [{ Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen'] }],
      },
      coreModel: {
        setParameterValueById: (param: string, value: number) => written.push({ param, value }),
        addParameterValueById: (param: string, value: number) => written.push({ param, value, added: true }),
        getParameterValueById: () => blink,
      },
      getDrawableBounds: (id: string) => (id === 'ArtMesh207' ? { ...headBounds } : null),
      on: (event: string, handler: () => void) => {
        if (event === 'beforeModelUpdate') beforeModelUpdate = handler;
      },
    },
  };

  const globals = globalThis as Record<string, unknown>;
  // 这些全局会一直被后面的测试文件用到:进来之前先存一份,跑完原样还回去。
  for (const key of ['document', 'window', 'requestAnimationFrame', 'PIXI', 'fetch', 'EventSource', 'performance', 'WebSocket', 'FileReader']) {
    if (!saved.has(key)) saved.set(key, globals[key]);
  }
  globals.performance = { now: () => fakeNowMs };
  const documentHandlers: Record<string, Array<(event: Record<string, unknown>) => void>> = {};
  globals.document = {
    getElementById: (id: string) => nodeFor(id),
    createElement: (tag: string) => makeNode(tag),
    addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) => {
      (documentHandlers[type] = documentHandlers[type] ?? []).push(fn);
    },
  };
  const windowHandlers: Record<string, Array<(event: Record<string, unknown>) => void>> = {};
  globals.window = {
    innerWidth: 1600,
    innerHeight: 900,
    addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) => {
      (windowHandlers[type] = windowHandlers[type] ?? []).push(fn);
    },
    fire: (type: string, event: Record<string, unknown>) => {
      for (const fn of windowHandlers[type] ?? []) fn(event);
    },
    localStorage: {
      getItem: () => null,
      setItem: (_key: string, value: string) => { stored.push(value); },
    },
    location: { protocol: 'http:', host: '127.0.0.1:18795', reload: () => { reloads.push(1); } },
    __DSH_MODEL_FILE__: 'miku.model3.json',
    __DSH_PAGE_VER__: 'aa11bb22',
  };
  // 假 WebSocket:记下页面发出去的东西,并让测试能装作她回了话。
  globals.WebSocket = class {
    url: string;
    sent: string[] = [];
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor(url: string) {
      this.url = url;
      const self = this;
      sockets.push(self as never);
      setTimeout(() => { self.readyState = 1; self.onopen?.(); }, 0);
    }
    send(text: string) { this.sent.push(text); }
    close() { this.readyState = 3; this.onclose?.(); }
    fire(data: string) { this.onmessage?.({ data }); }
  };
  globals.requestAnimationFrame = (callback: () => void) => { pending = callback; return 1; };
  globals.PIXI = {
    Application: class { renderer = { resize: () => {} }; stage = { addChild: () => {} }; },
    live2d: { Live2DModel: { from: async () => model } },
  };
  const posted: Array<{ url: string; body: string }> = [];
  /** 页面自刷新的次数:帧里的版本与入口注入的不符时刷新。 */
  const reloads: number[] = [];
  // 附图走 FileReader 读 base64(测试环境没有 createImageBitmap,页面会走原样读入那条路)。
  globals.FileReader = class {
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    result = '';
    readAsDataURL(file: { type: string; fakeB64?: string }): void {
      this.result = `data:${file.type};base64,${file.fakeB64 ?? ''}`;
      this.onload?.();
    }
  };
  globals.fetch = async (url: string, opts?: { method?: string; body?: string }) => {
    const target = String(url);
    if (opts && opts.method === 'POST') {
      posted.push({ url: target, body: String(opts.body) });
      return {
        json: async () => (target.includes('/dialog/') ? { ok: true } : {}),
      };
    }
    return {
      json: async () => {
        if (target.includes('overrides')) return { Param137: 1 };
        if (target.includes('chat.json')) return { enabled: true, agent: false, console: true };
        if (target.includes('pat.json')) return { headMeshes: ['ArtMesh207'] };
        if (target.includes('/dialog/providers')) {
          return {
            active: 'deepseek',
            instances: [
              { name: 'deepseek', kind: 'chat', model: 'miku-x', page: 'llm:chat' },
              { name: 'ollama', kind: 'ollama', model: 'r1', page: 'llm:ollama' },
            ],
          };
        }
        if (target.includes('/dialog/models')) {
          return { models: [{ id: 'miku-x' }, { id: 'miku-y' }] };
        }
        return {
          FaceAngleZ: { param: 'ParamAngleZ', range: [-30, 30] },
          MouthSmile: { param: 'ParamMouthForm', range: [-1, 1] },
          MouthOpen: { param: 'ParamMouthOpenY', range: [0, 1] },
          EyeOpenLeft: { param: 'ParamEyeLOpen', range: [-1, 1] },
          EyeLeftX: { param: null, range: null },
        };
      },
    };
  };
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor() { instances.push(this as never); }
  }
  globals.EventSource = FakeEventSource;

  return {
    written, scales, positions, nodes, stored, instances, sockets, posted, reloads, headBounds,
    fireWindow: (type: string, event: Record<string, unknown>) => {
      for (const fn of windowHandlers[type] ?? []) fn(event);
    },
    fireDocument: (type: string, event: Record<string, unknown>) => {
      for (const fn of documentHandlers[type] ?? []) fn(event);
    },
    pump: (frames: number) => {
      for (let i = 0; i < frames; i++) {
        // 每帧推进 16.7ms:页面按时间常数做的逼近必须看到真实的时间间隔。
        fakeNowMs += 16.7;
        const callback = pending;
        pending = null;
        callback?.();
        beforeModelUpdate?.();
      }
    },
  };
}

/** 被替身动过的全局;跑完要还回去,否则后面的测试文件会跑在替身上。 */
const saved = new Map<string, unknown>();

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
  saved.clear();
});

describe('播放器页面', () => {
  it('写参数、切表情、显示数值、调取景、说话与放置对话框', async () => {
    const stubs = stubBrowser();
    await import('../web/app.js');
    // boot() 是异步的:让它把 channels.json 与模型都取完。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stubs.instances.length).toBe(1);

    const send = (body: Record<string, unknown>): void => {
      stubs.instances[0]!.onmessage!({ data: JSON.stringify(body) });
    };
    const last = (param: string): number | undefined =>
      stubs.written.filter((entry) => entry.param === param).pop()?.value;
    const node = (id: string): FakeNode => stubs.nodes.get(id)!;

    send({
      channels: { FaceAngleZ: 12, MouthSmile: 0.5, MouthOpen: 0.9, EyeOpenLeft: 0.2, EyeLeftX: 0.9 },
      expression: 'blush',
      expressionParams: ['Param130', 'Param133', 'Param134', 'Param135'],
      expressionValues: { Param130: 1 },
      speaking: false,
      emotion: { valence: 0.5, arousal: 0.6, bond: 0.2, loneliness: 0.1, shyness: 0.62, empathy: 0 },
      mood: '害羞',
      clips: ['nod', 'speech_onset'],
      clients: 2,
    });
    stubs.pump(6);

    // ── 参数 ────────────────────────────────────────────────────────────────
    // 表情参数每帧自己写:整组开关先清零,再写当前那张的值。
    expect(last('Param130')).toBe(1);
    expect(last('Param134')).toBe(0);
    // 平滑是渐进的:推 6 帧之后应当已经朝目标走了一段,但还没到 12。
    expect(last('ParamAngleZ')).toBeGreaterThan(0);
    expect(last('ParamAngleZ')).toBeLessThan(12);
    expect(last('ParamMouthForm')).toBeGreaterThan(0);
    // 通道表里映射是 null 的(EyeLeftX:包说与右眼共用),不该写。
    expect(stubs.written.some((entry) => entry.param === 'ParamEyeBallX')).toBe(false);
    // 眨眼参数走加法:眨眼逻辑给 0.8,通道在它上面叠加。
    expect(last('ParamEyeLOpen')).toBeGreaterThan(0.8);
    expect(last('ParamEyeLOpen')).toBeLessThanOrEqual(1);
    // 口型:这一段没有在说话,嘴是 World 给的(片段能让她「张嘴」)。
    expect(last('ParamMouthOpenY')).toBeCloseTo(0.9, 6);
    // 不归通道管的参数定值每帧照写(这份部署把模型的水印开关 Param137 钉成 1)。
    expect(last('Param137')).toBe(1);

    // ── 数值面板 ────────────────────────────────────────────────────────────
    expect(node('mood').textContent).toBe('害羞');
    expect(node('expression').textContent).toBe('blush');
    expect(node('clips').textContent).toBe('nod, speech_onset');
    expect(node('speaking').textContent).toBe('否');
    expect(node('clients').textContent).toBe('2');
    // 六维各一行,数字与条宽都跟着帧走。
    expect(node('bars').children).toHaveLength(6);
    const shyRow = node('bars').children[4]!;
    expect(shyRow.children[2]!.textContent).toBe('0.62');
    expect(shyRow.children[1]!.children[0]!.style.width).toBe('62%');
    const valenceRow = node('bars').children[0]!;
    expect(valenceRow.children[2]!.textContent).toBe('0.50');
    expect(valenceRow.children[1]!.children[0]!.style.width).toBe('75%'); // -1..1 映到 0..100%
    // 通道值:帧里出现的通道各一行。
    expect(node('channels').children.length).toBeGreaterThanOrEqual(4);

    // ── 取景 ────────────────────────────────────────────────────────────────
    const fit = stubs.scales[stubs.scales.length - 1]!;
    stubs.scales.length = 0;
    node('zoom').fire('input');   // 滑块初值 100
    expect(stubs.scales[stubs.scales.length - 1]).toBeCloseTo(fit, 6);

    node('zoom').value = '150' as never;
    node('zoom').fire('input');
    expect(stubs.scales[stubs.scales.length - 1]).toBeCloseTo(fit * 1.5, 6);
    expect(node('zoom-val').textContent).toBe('150%');

    // 左右 / 上下:位置 = 画布中心 + 偏移。
    node('offset-x').value = '40' as never;
    node('offset-x').fire('input');
    node('offset-y').value = '-25' as never;
    node('offset-y').fire('input');
    expect(stubs.positions[stubs.positions.length - 1]).toEqual({ x: 800 + 40, y: 450 - 25 });

    // 画布不接指针:拖它不会有任何位移。
    node('stage').fire('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
    node('stage').fire('pointermove', { clientX: 130, clientY: 90, pointerId: 1 });
    expect(stubs.positions[stubs.positions.length - 1]).toEqual({ x: 800 + 40, y: 450 - 25 });

    // 「拖动」没打开时,覆层上的拖动也不生效——平时点画面只是点。
    node('hit').fire('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
    node('hit').fire('pointermove', { clientX: 130, clientY: 90, pointerId: 1 });
    expect(stubs.positions[stubs.positions.length - 1]).toEqual({ x: 800 + 40, y: 450 - 25 });

    // 打开「拖动」:拖动位移就是取景偏移,松手即存。
    node('btn-drag').fire('click');
    expect(node('btn-drag').textContent).toBe('拖动：开');
    expect(node('btn-drag').className).toBe('on');
    node('hit').fire('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
    node('hit').fire('pointermove', { clientX: 130, clientY: 90, pointerId: 1 });
    expect(stubs.positions[stubs.positions.length - 1]).toEqual({ x: 800 + 70, y: 450 - 35 });
    // 连着拖动,缩放不变:贴合比例只由模型自己的尺寸和窗口决定。
    const scalesBefore = stubs.scales.length;
    node('hit').fire('pointermove', { clientX: 140, clientY: 90, pointerId: 1 });
    node('hit').fire('pointermove', { clientX: 150, clientY: 90, pointerId: 1 });
    expect(stubs.scales.slice(scalesBefore)).toEqual([fit * 1.5, fit * 1.5]);
    node('hit').fire('pointerup', {});
    expect(stubs.stored.length).toBeGreaterThan(0);
    expect(JSON.parse(stubs.stored[stubs.stored.length - 1]!)).toMatchObject({ zoom: 1.5, x: 90, y: -35 });
    // 再按一次关掉:画面回到点不动。
    node('btn-drag').fire('click');
    expect(node('btn-drag').textContent).toBe('拖动：关');
    node('hit').fire('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
    node('hit').fire('pointermove', { clientX: 160, clientY: 90, pointerId: 1 });
    expect(stubs.positions[stubs.positions.length - 1]).toEqual({ x: 800 + 90, y: 450 - 35 });

    // 复位:回到 100% 与画面中心。
    node('btn-reset').fire('click');
    expect(stubs.scales[stubs.scales.length - 1]).toBeCloseTo(fit, 6);
    expect(stubs.positions[stubs.positions.length - 1]).toEqual({ x: 800, y: 450 });
    expect(node('zoom-val').textContent).toBe('100%');
    expect(node('offset-x-val').textContent).toBe('0');

    // ── 摸头:不开「拖动」,左键按在头上就是摸 ─────────────────────────────
    stubs.posted.length = 0;
    stubs.written.length = 0;
    // 识别区跟着锚点网格与取景走,屏幕点一律从画布坐标推出来:画布 → 画面 = *fit,再平移到画布中心所在的屏幕点。
    const headAt = (canvasX: number, canvasY: number): Record<string, number> => ({
      clientX: 800 + (canvasX - 50) * fit,
      clientY: 450 + (canvasY - 50) * fit,
    });
    // 锚点网格(ArtMesh207)的范围是 (20,5)-(80,35):头顶一圈的椭圆中心在网格上沿往下 0.29 网格高。
    const headCx = 20 + 60 * 0.53;
    const headCy = 5 + 30 * 0.29;
    node('hit').fire('pointerdown', { ...headAt(headCx, headCy), button: 0, pointerId: 2 });
    expect(stubs.posted).toEqual([{ url: '/pat', body: '{"active":true}' }]);
    // 摸头时头跟着手大幅转:指针推到最右,头的角度远超平时的 6 度。
    stubs.fireWindow('pointermove', { clientX: 1600, clientY: 450 });
    stubs.pump(8);
    const headTurn = stubs.written.filter((entry) => entry.param === 'ParamAngleX').pop()!;
    expect(headTurn.value).toBeGreaterThan(20);
    node('hit').fire('pointerup', { pointerId: 2 });
    expect(stubs.posted[stubs.posted.length - 1]).toEqual({ url: '/pat', body: '{"active":false}' });
    // 松手后头回到平时的幅度。
    stubs.written.length = 0;
    stubs.pump(8);
    const headAfter = stubs.written.filter((entry) => entry.param === 'ParamAngleX').pop()!;
    expect(headAfter.value).toBeLessThanOrEqual(6);
    // 打在身上不算摸头:肩上的位置(画布 50,70)不触发。
    stubs.posted.length = 0;
    node('hit').fire('pointerdown', { ...headAt(50, 70), button: 0, pointerId: 3 });
    expect(stubs.posted).toEqual([]);
    node('hit').fire('pointerup', { pointerId: 3 });
    // 头动了(转头/晃动),识别区跟着网格走:原来的点摸空,头此刻的位置才触发。
    stubs.headBounds.x += 40;
    node('hit').fire('pointerdown', { ...headAt(headCx, headCy), button: 0, pointerId: 4 });
    expect(stubs.posted).toEqual([]);
    node('hit').fire('pointerup', { pointerId: 4 });
    node('hit').fire('pointerdown', { ...headAt(headCx + 40, headCy), button: 0, pointerId: 4 });
    expect(stubs.posted).toEqual([{ url: '/pat', body: '{"active":true}' }]);
    node('hit').fire('pointerup', { pointerId: 4 });
    stubs.headBounds.x -= 40;
    // 取景变了,识别区跟着画面走:拖走后原屏幕点摸空,头此刻所在的屏幕位置才触发。
    stubs.posted.length = 0;
    node('offset-x').value = '300';
    node('offset-x').fire('input');
    node('hit').fire('pointerdown', { ...headAt(headCx, headCy), button: 0, pointerId: 5 });
    expect(stubs.posted).toEqual([]);
    node('hit').fire('pointerup', { pointerId: 5 });
    node('hit').fire('pointerdown', { ...headAt(headCx + 300 / fit, headCy), button: 0, pointerId: 5 });
    expect(stubs.posted).toEqual([{ url: '/pat', body: '{"active":true}' }]);
    node('hit').fire('pointerup', { pointerId: 5 });
    node('btn-reset').fire('click');

    // ── 眼神跟随:只眼睛和一点头,身体一律不碰 ─────────────────────────────
    stubs.written.length = 0;
    stubs.fireWindow('pointermove', { clientX: 1600, clientY: 450 });
    stubs.pump(8); // 8 帧 ≈ 134ms:时间常数 0.015s,早就该到了
    const eyed = stubs.written.filter((entry) => entry.param === 'ParamEyeBallX');
    expect(eyed.length).toBeGreaterThan(0);
    // 跟得上:推到最右,几帧之内就该走过九成。
    expect(eyed[eyed.length - 1]!.value).toBeGreaterThan(0.9);
    // 叠加在通道值上,不是覆盖。
    expect(eyed[eyed.length - 1]!.added).toBe(true);
    // 腰不跟着鼠标转:身体参数一个都不写。
    expect(stubs.written.some((entry) => entry.param.indexOf('ParamBodyAngle') === 0)).toBe(false);

    // 指针离开窗口:看回正前方。
    stubs.fireWindow('pointerleave', {});
    stubs.pump(25);
    const back = stubs.written.filter((entry) => entry.param === 'ParamEyeBallX').pop()!;
    expect(Math.abs(back.value)).toBeLessThan(0.1);

    // 光标停住:停满两秒前一直盯着它,满两秒才许把眼神收回来。
    stubs.fireWindow('pointermove', { clientX: 1600, clientY: 450 });
    stubs.pump(30); // ≈0.5s:还在盯
    const locked = stubs.written.filter((entry) => entry.param === 'ParamEyeBallX').pop()!;
    expect(locked.value).toBeGreaterThan(0.9);
    stubs.pump(110); // 累计 ≈2.3s:过了两秒,回正前方
    const freed = stubs.written.filter((entry) => entry.param === 'ParamEyeBallX').pop()!;
    expect(Math.abs(freed.value)).toBeLessThan(0.1);

    // ── 对话:她的话是字幕,我发过的话只在底部输入区 ─────────────────────────
    expect(stubs.sockets.length).toBe(1);
    expect(stubs.sockets[0]!.url).toContain('/chat');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stubs.sockets[0]!.sent.join(' ')).toContain('"hello"'); // 连上先报名字
    expect(node('composer').className).toBe('glass');             // 输入区显示出来

    // 我说话:记在底部,发到那条通道上。
    node('composer-input').value = '第一句';
    node('composer-form').fire('submit', { preventDefault: () => {} });
    node('composer-input').value = '第二句';
    node('composer-form').fire('submit', { preventDefault: () => {} });
    expect(node('composer-input').value).toBe('');
    expect(stubs.sockets[0]!.sent.join(' ')).toContain('第一句');
    expect(node('mine').children.map((child) => child.textContent)).toEqual(['第一句', '第二句']);

    // 她回话:进字幕,不进底部输入区。
    stubs.sockets[0]!.fire(JSON.stringify({ type: 'msg', from: '初音未来', text: '在的哦' }));
    expect(node('subtitle').textContent).toBe('在的哦');
    expect(node('subtitle').className).toContain('on');
    expect(node('mine').children).toHaveLength(2);               // 她的回复不落在输入区里

    // 多行字幕原样换行,但行尾空白与空行不留:它们会顶出看不见的行距。
    stubs.sockets[0]!.fire(JSON.stringify({ type: 'msg', from: '初音未来', text: '上半句  \n\n\n下半句\n' }));
    expect(node('subtitle').textContent).toBe('上半句\n下半句');

    // 我自己的回显(终端广播回来)不进字幕,也不再记一行。
    stubs.sockets[0]!.fire(JSON.stringify({ type: 'msg', from: '制作人', text: '第一句' }));
    expect(node('subtitle').textContent).toBe('上半句\n下半句');

    // 底部收起时只看得到最近一句;按「历史」展开,再按收起。
    expect(node('mine').children.map((child) => child.textContent)).toEqual(['第一句', '第二句']);
    expect(node('composer').className).not.toContain('expanded');
    expect(node('btn-history').textContent).toBe('历史 2');
    node('btn-history').fire('click');
    expect(node('composer').className).toContain('expanded');
    expect(node('btn-history').textContent).toBe('收起');
    node('btn-history').fire('click');
    expect(node('composer').className).not.toContain('expanded');
    expect(node('btn-history').textContent).toBe('历史 2');

    // 面板:数值之下的东西默认收起,按「更多」展开。
    expect(node('panel-more').className).toContain('collapsed');
    expect(node('btn-panel').textContent).toBe('更多 ▾');
    node('btn-panel').fire('click');
    expect(node('panel-more').className).not.toContain('collapsed');
    expect(node('btn-panel').textContent).toBe('收起 ▴');
    node('btn-panel').fire('click');
    expect(node('panel-more').className).toContain('collapsed');

    // 取景不会把她拖出画面:推到极限后至少留一节可见。
    node('zoom').value = '30' as never;
    node('zoom').fire('input');
    node('offset-x').value = '400' as never;
    node('offset-x').fire('input');
    const maxOffsetX = 1600;
    expect(Math.abs(Number(node('offset-x-val').textContent))).toBeLessThanOrEqual(maxOffsetX);

    // ── 表情换挡:上一张的开关每帧先清零,不残留 ────────────────────────────
    stubs.written.length = 0;
    send({
      channels: { MouthSmile: 0.5 }, speaking: false, expression: 'sing',
      expressionParams: ['Param130', 'Param133', 'Param134', 'Param135'],
      expressionValues: { Param134: 1 },
    });
    stubs.pump(2);
    send({
      channels: { MouthSmile: 0.5 }, speaking: false, expression: 'heart',
      expressionParams: ['Param130', 'Param133', 'Param134', 'Param135'],
      expressionValues: { Param133: 0, Param134: 0, Param135: 1 },
    });
    stubs.pump(2);
    // 唱歌的 Param134 被清零,比心的 Param135 写上:两个开关不同时满足,不串台。
    expect(last('Param134')).toBe(0);
    expect(last('Param135')).toBe(1);
    expect(node('expression').textContent).toBe('heart');
    expect(node('speaking').textContent).toBe('否');
    expect(node('clips').textContent).toBe('—');

    // ── 页面版本:帧里带的不符即自刷新,相符不动 ─────────────────────────────
    expect(stubs.reloads).toHaveLength(0);   // 前面那些帧都没带版本,不刷
    send({ channels: {}, speaking: false, page: 'aa11bb22' });
    expect(stubs.reloads).toHaveLength(0);   // 与入口注入的一致:不刷
    send({ channels: {}, speaking: false, page: 'ff00ff00' });
    expect(stubs.reloads).toHaveLength(1);   // 不一致:这份页面是旧的,刷新成新的

    // ── 对话框读数行:状态帧里的用量与运行态照实画 ──────────────────────────
    expect(node('dialog-bar').className).toBe('on');   // 配了控制台,读数行出现
    send({
      channels: {}, speaking: false,
      status: { estTokens: 120000, messageCount: 30, paused: false, maxTokens: 240000, softRatio: 0.85, hardTokens: 130000 },
    });
    expect(node('ctx-num').textContent).toBe('120.0k/240.0k');
    expect(node('ctx-fill').style.width).toBe('50.0%');
    expect(node('ctx').className).toBe('');
    expect(node('btn-run').textContent).toBe('运行中');
    // 过软预警线变黄,满过预算变红;暂停态照帧里画。
    send({ channels: {}, speaking: false, status: { estTokens: 210000, paused: false, maxTokens: 240000, softRatio: 0.85 } });
    expect(node('ctx').className).toBe('warn');
    send({ channels: {}, speaking: false, status: { estTokens: 250000, paused: true, maxTokens: 240000, softRatio: 0.85 } });
    expect(node('ctx').className).toBe('danger');
    expect(node('btn-run').textContent).toBe('已暂停');
    expect(node('btn-run').className).toContain('paused');

    // 运行开关:按当前态往反方向扳,POST /dialog/run。
    node('btn-run').fire('click');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stubs.posted.some((p) => p.url === '/dialog/run' && p.body.includes('"action":"resume"'))).toBe(true);
    expect(node('btn-run').textContent).toBe('运行中');   // 先照新值画,下一帧自然对齐

    // ── 模型选择器:清单、激活点、实例内换名 ────────────────────────────────
    node('btn-model').fire('click');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(node('model-pop').className).toContain('on');
    expect(node('btn-model').textContent).toBe('模型 miku-x');
    const rows = node('model-pop').children.filter((child) => child.className.indexOf('mrow') >= 0);
    expect(rows.length).toBe(2);
    expect(rows[0]!.className).toContain('active');       // deepseek 是激活端点
    // 点端点行:POST activate(不带 model),然后展开它的模型目录。
    rows[0]!.fire('click');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stubs.posted.some((p) => p.url === '/dialog/model'
      && p.body.includes('"name":"deepseek"') && !p.body.includes('"model"'))).toBe(true);
    const subs = node('model-pop').children.filter((child) => child.className.indexOf('sub') >= 0);
    expect(subs.map((sub) => sub.children[0]!.textContent)).toEqual(['miku-x', 'miku-y']);
    // 点子行:带 model 的 activate,按钮标签跟着换。
    subs[1]!.fire('click');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stubs.posted.some((p) => p.url === '/dialog/model' && p.body.includes('"model":"miku-y"'))).toBe(true);
    expect(node('btn-model').textContent).toBe('模型 miku-y');
    // 点到弹出单外面:收起。
    stubs.fireDocument('pointerdown', { target: {} });
    expect(node('model-pop').className).not.toContain('on');

    // ── 附图:选图进托盘,随文本一起发;拖入与粘贴同一条路 ───────────────────
    node('btn-attach').fire('click');
    expect(node('file-input').clicks).toBe(1);            // 附图钮点开文件选择器
    node('file-input').fire('change', {
      currentTarget: {
        files: [
          { name: 'a.png', type: 'image/png', size: 1234, fakeB64: 'QUJD' },
          { name: 'b.jpg', type: 'image/jpeg', size: 2048, fakeB64: 'QkNE' },
        ],
        value: '',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    let thumbs = node('tray').children.filter((child) => child.className === 'thumb');
    expect(thumbs.length).toBe(2);
    expect(node('tray').className).toBe('on');
    // 移除一张:托盘少一张,其余不动。
    thumbs[1]!.children[1]!.fire('click');
    thumbs = node('tray').children.filter((child) => child.className === 'thumb');
    expect(thumbs.length).toBe(1);
    // 拖图进输入区:墨线换虚线,松手进托盘。
    node('composer').fire('dragover', { dataTransfer: { types: ['Files'] }, preventDefault: () => {} });
    expect(node('composer').className).toContain('dragover');
    node('composer').fire('drop', {
      dataTransfer: { files: [{ name: 'c.png', type: 'image/png', size: 100, fakeB64: 'Q0NE' }] },
      preventDefault: () => {},
    });
    expect(node('composer').className).not.toContain('dragover');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(node('tray').children.filter((child) => child.className === 'thumb').length).toBe(2);
    // 往输入框里贴图也进托盘。
    node('composer-input').fire('paste', {
      clipboardData: { files: [{ name: 'd.png', type: 'image/png', size: 50, fakeB64: 'REQ=' }] },
      preventDefault: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(node('tray').children.filter((child) => child.className === 'thumb').length).toBe(3);
    // 发话:文本带图一起走 images 字段,底部记一行带图标记,托盘清空。
    node('composer-input').value = '看这张';
    node('composer-form').fire('submit', { preventDefault: () => {} });
    const withImages = stubs.sockets[0]!.sent.filter((s) => s.includes('"msg"')).pop()!;
    expect(withImages).toContain('"text":"看这张"');
    expect(withImages).toContain('"images"');
    expect(withImages).toContain('"name":"a.png"');
    expect(withImages).toContain('"base64":"QUJD"');
    expect(node('mine').children[node('mine').children.length - 1]!.textContent).toBe('看这张 [图×3]');
    expect(node('tray').className).toBe('');
    // 只发图不发字:也发得出去。
    node('file-input').fire('change', {
      currentTarget: { files: [{ name: 'e.png', type: 'image/png', size: 10, fakeB64: 'RQ==' }], value: '' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    node('composer-input').value = '';
    node('composer-form').fire('submit', { preventDefault: () => {} });
    const imageOnly = stubs.sockets[0]!.sent.filter((s) => s.includes('"msg"')).pop()!;
    expect(imageOnly).toContain('"text":""');
    expect(imageOnly).toContain('"name":"e.png"');
    expect(node('mine').children[node('mine').children.length - 1]!.textContent).toBe('[图×1]');
    // 超张数整批拒:托盘里给一句理由,一张不多收。
    node('file-input').fire('change', {
      currentTarget: {
        files: Array.from({ length: 9 }, (_, i) => ({ name: `x${i}.png`, type: 'image/png', size: 10, fakeB64: 'eA==' })),
        value: '',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(node('tray').children.some((child) => child.className === 'note' && child.textContent.includes('最多'))).toBe(true);
    expect(node('tray').children.filter((child) => child.className === 'thumb').length).toBe(0);
  });
});
