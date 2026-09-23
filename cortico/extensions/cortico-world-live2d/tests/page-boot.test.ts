/**
 * 播放器页面的启动失败路(`web/app.js` 的 boot):失败不闷着——原因写进 `#why`,
 * 并按失败位置自愈。取件失败(bot 没起来)原地隔几秒重试;绘图上下文建不起来
 * (系统虚拟内存不足时的典型症状)整页刷新。这里用会失败一次的取件与一建就抛的
 * PIXI 替身,把两条恢复路各走一遍。
 *
 * 页面脚本是 IIFE,一个模块图里只 boot 一次:本文件与 page.test.ts 各有自己的
 * 模块图(vitest 按文件隔离),互不串门。
 */
import { afterEach, describe, expect, it } from 'vitest';

interface FakeNode {
  id: string;
  className: string;
  textContent: string;
  style: Record<string, string>;
  children: FakeNode[];
  handlers: Record<string, Array<(event: Record<string, unknown>) => void>>;
  appendChild: (child: FakeNode) => FakeNode;
  addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) => void;
  fire: (type: string, event?: Record<string, unknown>) => void;
}

/** 只够 boot 走到失败的浏览器替身:页面还没建起任何东西,DOM 与网络都是最小件。 */
function stubFailingBoot(): {
  nodes: Map<string, FakeNode>;
  instances: unknown[];
  reloads: number[];
} {
  const nodes = new Map<string, FakeNode>();
  const instances: unknown[] = [];
  const reloads: number[] = [];

  const makeNode = (id: string): FakeNode => {
    let textValue = '';
    const node: FakeNode = {
      id, className: '', style: {}, children: [], handlers: {},
      get textContent() { return textValue; },
      set textContent(value: string) { textValue = value; node.children.length = 0; },
      appendChild(child) { node.children.push(child); return child; },
      addEventListener(type, fn) { (node.handlers[type] = node.handlers[type] ?? []).push(fn); },
      fire(type, event) { for (const fn of node.handlers[type] ?? []) fn(event ?? {}); },
    } as FakeNode;
    return node;
  };
  const nodeFor = (id: string): FakeNode => {
    const existing = nodes.get(id);
    if (existing) return existing;
    const created = makeNode(id);
    nodes.set(id, created);
    return created;
  };

  const globals = globalThis as Record<string, unknown>;
  for (const key of ['document', 'window', 'PIXI', 'fetch', 'EventSource']) {
    if (!saved.has(key)) saved.set(key, globals[key]);
  }
  globals.document = {
    getElementById: (id: string) => nodeFor(id),
    createElement: (tag: string) => makeNode(tag),
    addEventListener: () => {},
  };
  let packCalls = 0;
  globals.fetch = async (url: string) => {
    const target = String(url);
    if (target.includes('channels.json')) {
      packCalls += 1;
      if (packCalls === 1) throw new Error('she is down');
    }
    return { json: async () => ({}) };
  };
  globals.window = {
    innerWidth: 1600,
    innerHeight: 900,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { reload: () => { reloads.push(1); } },
    __DSH_MODEL_FILE__: 'miku.model3.json',
    // 缩短重试间隔(默认 5s):这里的断言等不了那么久。
    __DSH_BOOT_RETRY_MS__: 20,
  };
  globals.PIXI = {
    Application: class { constructor() { throw new Error('no webgl'); } },
    live2d: { Live2DModel: { from: async () => { throw new Error('not reached'); } } },
  };
  globals.EventSource = class {
    onopen: unknown = null;
    onerror: unknown = null;
    onmessage: unknown = null;
    constructor() { instances.push(this); }
  };
  return { nodes, instances, reloads };
}

/** 被替身动过的全局;跑完还回去,别让后面的测试文件跑在替身上。 */
const saved = new Map<string, unknown>();

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
  saved.clear();
});

describe('播放器页面·启动失败', () => {
  it('取件失败原地重试;上下文建不起来提示内存并整页刷新', async () => {
    const stubs = stubFailingBoot();
    await import('../web/app.js');
    const node = (id: string): FakeNode => stubs.nodes.get(id)!;

    // 第一次 boot:取件失败(bot 没起来)。原因上屏,原地重试已排上,还没碰任何恢复动作。
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(node('why').textContent).toContain('取 /pack/channels.json 失败');
    expect(node('why').textContent).toContain('再试');
    expect(stubs.reloads).toHaveLength(0);
    expect(stubs.instances).toHaveLength(0);

    // 重试:取件成功了,但绘图上下文建不起来——提示点名虚拟内存,排的是整页刷新。
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(node('why').textContent).toContain('绘图上下文建不起来');
    expect(node('why').textContent).toContain('虚拟内存不足');
    // 到点刷新了一次;从头到尾没接过推流。
    expect(stubs.reloads).toHaveLength(1);
    expect(stubs.instances).toHaveLength(0);
  });
});
