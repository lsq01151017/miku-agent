/**
 * 播放器页面自己的逻辑:推流帧 → 通道值 → 模型参数,以及表情切换。
 *
 * 渲染本身(WebGL/Cubism)只有浏览器能验,但页面**应用这些值的那段代码**可以在这里跑起来:
 * 用替身顶掉 document / PIXI / EventSource,喂一帧进去,看它到底写了哪些参数。
 * 这段代码此前从未被执行过。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Written { param: string; value: number }

/** 一次性的浏览器替身:记录页面写进模型的参数与切过的表情,并让测试能驱动帧。 */
function stubBrowser(): {
  written: Written[];
  expressions: string[];
  instances: Array<{ onmessage: ((event: { data: string }) => void) | null }>;
  /** 跑 n 帧。页面靠 requestAnimationFrame 自续,替身把它截下来手动推。 */
  pump: (frames: number) => void;
} {
  const written: Written[] = [];
  const expressions: string[] = [];
  const instances: Array<{ onmessage: ((event: { data: string }) => void) | null }> = [];
  let pending: (() => void) | null = null;

  const element = (): Record<string, unknown> => ({ style: {}, className: '', textContent: '', appendChild: () => {} });
  const conn = { className: '', textContent: '' };

  const model = {
    width: 100,
    height: 100,
    scale: { set: () => {} },
    anchor: { set: () => {} },
    position: { set: () => {} },
    internalModel: {
      coreModel: { setParameterValueById: (param: string, value: number) => written.push({ param, value }) },
    },
    expression: (name: string) => { expressions.push(name); },
  };

  const globals = globalThis as Record<string, unknown>;
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
  globals.fetch = async () => ({
    json: async () => ({
      FaceAngleZ: { param: 'ParamAngleZ', range: [-30, 30] },
      MouthSmile: { param: 'ParamMouthForm', range: [-1, 1] },
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
      }
    },
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('播放器页面', () => {
  it('把推流帧里的通道值按映射写进模型参数,并切表情', async () => {
    const stubs = stubBrowser();
    await import('../web/app.js');
    // boot() 是异步的:让它把 channels.json 与模型都取完。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stubs.instances.length).toBe(1);

    stubs.instances[0]!.onmessage!({
      data: JSON.stringify({
        channels: { FaceAngleZ: 12, MouthSmile: 0.5, EyeLeftX: 0.9 },
        expression: 'blush',
        speaking: false,
      }),
    });
    stubs.pump(6);

    const last = (param: string): number | undefined =>
      stubs.written.filter((entry) => entry.param === param).pop()?.value;

    expect(stubs.expressions).toEqual(['blush']);
    // 平滑是渐进的:推 6 帧之后应当已经朝目标走了一段,但还没到 12。
    expect(last('ParamAngleZ')).toBeGreaterThan(0);
    expect(last('ParamAngleZ')).toBeLessThan(12);
    expect(last('ParamMouthForm')).toBeGreaterThan(0);
    // 通道表里映射是 null 的(EyeLeftX:包说与右眼共用),不该写。
    expect(stubs.written.some((entry) => entry.param === 'ParamEyeBallX')).toBe(false);
  });
});
