/**
 * 播放器页面自己的逻辑:推流帧 → 通道值 → 模型参数,以及表情切换。
 *
 * 渲染本身(WebGL/Cubism)只有浏览器能验,但页面**应用这些值的那段代码**可以在这里跑起来:
 * 用替身顶掉 document / PIXI / EventSource,喂一帧进去,推几帧,看它到底写了哪些参数。
 *
 * 写参数发生在模型的 `beforeModelUpdate` 上(参数复位之后、更新之前),所以替身把那个钩子
 * 也截下来,由 `pump` 一帧一帧地推——这正是浏览器里每帧发生的事。
 */
import { afterEach, describe, expect, it } from 'vitest';

interface Written { param: string; value: number }

/** 一次性的浏览器替身:记录页面写进模型的参数与切过的表情,并让测试能驱动帧。 */
function stubBrowser(): {
  written: Written[];
  expressions: string[];
  instances: Array<{ onmessage: ((event: { data: string }) => void) | null }>;
  /** 跑 n 帧:每帧先走页面的 requestAnimationFrame,再走模型的 beforeModelUpdate。 */
  pump: (frames: number) => void;
} {
  const written: Written[] = [];
  const expressions: string[] = [];
  const instances: Array<{ onmessage: ((event: { data: string }) => void) | null }> = [];
  let pending: (() => void) | null = null;
  let beforeModelUpdate: (() => void) | null = null;
  /** 眨眼逻辑自己算出来的参数值;通道值应当在它上面叠加,不是覆盖。 */
  const blink = 0.8;

  const element = (): Record<string, unknown> => ({ style: {}, className: '', textContent: '', appendChild: () => {} });
  const conn = { className: '', textContent: '' };

  const model = {
    width: 100,
    height: 100,
    scale: { set: () => {} },
    anchor: { set: () => {} },
    position: { set: () => {} },
    internalModel: {
      settings: {
        groups: [{ Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen'] }],
      },
      coreModel: {
        setParameterValueById: (param: string, value: number) => written.push({ param, value }),
        getParameterValueById: () => blink,
      },
      on: (event: string, handler: () => void) => {
        if (event === 'beforeModelUpdate') beforeModelUpdate = handler;
      },
    },
    expression: (name: string) => { expressions.push(name); },
  };

  const globals = globalThis as Record<string, unknown>;
  // 这些全局会一直被后面的测试文件用到:进来之前先存一份,跑完原样还回去。
  for (const key of ['document', 'window', 'requestAnimationFrame', 'PIXI', 'fetch', 'EventSource']) {
    if (!saved.has(key)) saved.set(key, globals[key]);
  }
  globals.document = { getElementById: (id: string) => (id === 'conn' ? conn : element()) };
  globals.window = {
    innerWidth: 800,
    innerHeight: 600,
    addEventListener: () => {},
    __DSH_MODEL_FILE__: 'miku.model3.json',
  };
  globals.requestAnimationFrame = (callback: () => void) => { pending = callback; return 1; };
  globals.PIXI = {
    Application: class { renderer = { resize: () => {} }; stage = { addChild: () => {} }; },
    live2d: { Live2DModel: { from: async () => model } },
  };
  globals.fetch = async (url: string) => ({
    json: async () => (String(url).includes('overrides')
      ? { Param137: 1 }
      : {
        FaceAngleZ: { param: 'ParamAngleZ', range: [-30, 30] },
        MouthSmile: { param: 'ParamMouthForm', range: [-1, 1] },
        EyeOpenLeft: { param: 'ParamEyeLOpen', range: [-1, 1] },
        EyeLeftX: { param: null, range: null },
      }),
  });
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor() { instances.push(this as never); }
  }
  globals.EventSource = FakeEventSource;

  return {
    written,
    expressions,
    instances,
    pump: (frames: number) => {
      for (let i = 0; i < frames; i++) {
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

const frame = (body: Record<string, unknown>): string => JSON.stringify(body);

/**
 * 页面脚本是 IIFE,一个进程里只会 boot 一次(第二次 import 拿到的是同一份模块),
 * 所以这个文件里的检查都在同一次 boot 之后按顺序做完。
 */
describe('播放器页面', () => {
  it('把推流帧写进模型参数、按序号重放表情', async () => {
    const stubs = stubBrowser();
    await import('../web/app.js');
    // boot() 是异步的:让它把 channels.json 与模型都取完。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stubs.instances.length).toBe(1);

    const send = (body: Record<string, unknown>): void => {
      stubs.instances[0]!.onmessage!({ data: frame(body) });
    };
    const last = (param: string): number | undefined =>
      stubs.written.filter((entry) => entry.param === param).pop()?.value;

    send({
      channels: { FaceAngleZ: 12, MouthSmile: 0.5, EyeOpenLeft: 0.2, EyeLeftX: 0.9 },
      expression: 'blush',
      expressionToken: 1,
      speaking: false,
    });
    stubs.pump(6);

    expect(stubs.expressions).toEqual(['blush']);
    // 平滑是渐进的:推 6 帧之后应当已经朝目标走了一段,但还没到 12。
    expect(last('ParamAngleZ')).toBeGreaterThan(0);
    expect(last('ParamAngleZ')).toBeLessThan(12);
    expect(last('ParamMouthForm')).toBeGreaterThan(0);
    // 通道表里映射是 null 的(EyeLeftX:包说与右眼共用),不该写。
    expect(stubs.written.some((entry) => entry.param === 'ParamEyeBallX')).toBe(false);
    // 眨眼参数走加法:眨眼逻辑给 0.8,通道在它上面叠加,所以写下去的值始终大于 0.8。
    // 覆盖式写法则会写成一个远小于 0.8 的数——那正好是把眨眼关掉。
    expect(last('ParamEyeLOpen')).toBeGreaterThan(0.8);
    expect(last('ParamEyeLOpen')).toBeLessThanOrEqual(1);
    // 不归通道管的参数定值每帧照写(这份部署把模型的水印开关 Param137 钉成 1)。
    expect(last('Param137')).toBe(1);

    // 表情按序号重放:同一个序号不重放,序号变了(她第二次说「害羞」)要重放。
    send({ channels: { MouthSmile: 0.5 }, expression: 'blush', expressionToken: 1, speaking: false });
    send({ channels: { MouthSmile: 0.5 }, expression: 'blush', expressionToken: 2, speaking: false });
    send({ channels: { MouthSmile: 0.5 }, expression: null, expressionToken: 3, speaking: false });
    expect(stubs.expressions).toEqual(['blush', 'blush']);
  });
});
