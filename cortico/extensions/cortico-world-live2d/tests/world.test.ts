/**
 * Live2D World:真实端口、真实 HTTP 与 SSE,只有 WebSocket 之外的浏览器端是假的。
 * 模型与播放器库用临时目录里的替身文件——这里验的是路由、推流与驱动,不是 Cubism 渲染。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { nullLogger } from 'cortico/core/util.ts';
import type { WorldHost } from 'cortico/core/types.ts';
import { LIVE2D_DEFAULTS, type Live2DConfigSection } from '../src/config.ts';
import { Live2DWorld } from '../src/world.ts';

const PACK_DIR = join(import.meta.dirname, '..', '..', '..', 'bots', 'miku', 'vtuber-pack');

let root = '';
let webDir = '';
let modelDir = '';
let world: Live2DWorld | null = null;
let port = 0;

/** World 经 host.pushEvent 递进对话的内部事件(摸头);按用例清空。 */
const pushedEvents: Array<{ event: Record<string, unknown>; trigger?: string }> = [];

const host = {
  log: nullLogger(),
  pushEvent: async (event: Record<string, unknown>, opts?: { trigger?: string }) => {
    pushedEvents.push({ event, trigger: opts?.trigger });
    return event as never;
  },
} as unknown as WorldHost;

function config(over: Partial<Live2DConfigSection> = {}): Live2DConfigSection {
  return {
    ...LIVE2D_DEFAULTS,
    enabled: true,
    // 每个用例换一个端口段,避免上一个用例的 TIME_WAIT 影响。
    port,
    packDir: PACK_DIR,
    webDir,
    modelDir,
    ...over,
  };
}

async function start(over: Partial<Live2DConfigSection> = {}): Promise<Live2DWorld> {
  world = new Live2DWorld({ cfg: config(over), packageDir: root });
  await world.start(host);
  // 端口交给系统挑(配置里写 0),再按实际绑上的端口拼 URL:随机端口会撞车,撞上就测到了别人。
  port = Number(new URL(world.url()).port);
  return world;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'live2d-'));
  webDir = join(root, 'player');
  modelDir = join(root, 'model');
  pushedEvents.length = 0;
  mkdirSync(join(webDir, 'js'), { recursive: true });
  mkdirSync(modelDir, { recursive: true });
  for (const name of ['pixi.min.js', 'live2dcubismcore.min.js', 'cubism4.min.js']) {
    writeFileSync(join(webDir, 'js', name), `/* ${name} */`, 'utf8');
  }
  // 模型替身带上四个情绪表情,让表情层在测试里也是活的。exp3 照真实模型的写法:
  // 唱歌/比心共用 Param133-135 各占一位——表情串台正是从这种共用来的。
  writeFileSync(
    join(modelDir, 'miku.model3.json'),
    JSON.stringify({
      version: 3,
      FileReferences: {
        Expressions: ['blush', 'lean', 'sing', 'heart'].map((name) => ({ Name: name, File: `${name}.exp3.json` })),
      },
    }),
    'utf8',
  );
  const exp3s: Record<string, Array<{ Id: string; Value: number; Blend: string }>> = {
    blush: [{ Id: 'Param130', Value: 1, Blend: 'Add' }],
    lean: [{ Id: 'Param132', Value: 1, Blend: 'Add' }],
    sing: [{ Id: 'Param133', Value: 0, Blend: 'Add' }, { Id: 'Param134', Value: 1, Blend: 'Add' }, { Id: 'Param135', Value: 0, Blend: 'Add' }],
    heart: [{ Id: 'Param133', Value: 0, Blend: 'Add' }, { Id: 'Param134', Value: 0, Blend: 'Add' }, { Id: 'Param135', Value: 1, Blend: 'Add' }],
  };
  for (const [name, parameters] of Object.entries(exp3s)) {
    writeFileSync(join(modelDir, `${name}.exp3.json`), JSON.stringify({ Type: 'Live2D Expression', Parameters: parameters }), 'utf8');
  }
  writeFileSync(join(root, 'secret.txt'), '不该被读到', 'utf8');
  // 0 = 让系统挑一个空闲端口;`start()` 起完会把它换成实际端口。
  port = 0;
});

afterEach(async () => {
  if (world) await world.stop();
  world = null;
  rmSync(root, { recursive: true, force: true });
});

const url = (path: string): string => `http://127.0.0.1:${port}${path}`;

/** 读 SSE 流里的第一帧 data。 */
async function firstFrame(signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url('/state'), { signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const match = /^data: (.*)$/m.exec(buffer);
    if (match) {
      await reader.cancel();
      return JSON.parse(match[1]!);
    }
  }
  throw new Error('流里没有 data 帧');
}

describe('静态路由', () => {
  it('页面注入模型文件名,库与模型各自从配置的目录取', async () => {
    await start();
    const page = await (await fetch(url('/'))).text();
    expect(page).toContain('__DSH_MODEL_FILE__');
    expect(page).toContain('miku.model3.json');
    expect(await (await fetch(url('/lib/js/pixi.min.js'))).text()).toContain('pixi.min.js');
    expect(await (await fetch(url('/model/miku.model3.json'))).json()).toMatchObject({ version: 3 });
    expect(await (await fetch(url('/app.js'))).text()).toContain('EventSource');
  });

  it('入口注入的页面版本与帧里带的一致,页面据此自刷新', async () => {
    await start();
    const page = await (await fetch(url('/'))).text();
    const injected = /window\.__DSH_PAGE_VER__ = "([0-9a-f]+)"/.exec(page);
    expect(injected).toBeTruthy();
    const frame = await firstFrame(new AbortController().signal) as { page: string };
    expect(frame.page).toBe(injected![1]);
  });

  it('静态文件带 ETag:未改动回 304,ETag 不匹配照发全文', async () => {
    await start();
    const first = await fetch(url('/app.js'));
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const same = await fetch(url('/app.js'), { headers: { 'if-none-match': etag! } });
    expect(same.status).toBe(304);
    const other = await fetch(url('/app.js'), { headers: { 'if-none-match': '"stale"' } });
    expect(other.status).toBe(200);
    expect(await other.text()).toContain('EventSource');
  });

  it('通道表按包给出,页面据此把通道映到模型参数', async () => {
    await start();
    const params = await (await fetch(url('/pack/params.json'))).json() as Record<string, { suggests: string }>;
    expect(params.FaceAngleZ!.suggests).toContain('ParamAngleZ');
    expect(Object.keys(params).length).toBeGreaterThan(10);
  });

  it('规格化的通道表由 World 解析,页面直接用', async () => {
    await start();
    const channels = await (await fetch(url('/pack/channels.json'))).json() as
      Record<string, { param: string | null; range: number[] | null }>;
    expect(channels.FaceAngleZ!.param).toBe('ParamAngleZ');
    expect(channels.EyeLeftX!.param).toBeNull(); // 包自己说不接
    expect(channels.FaceAngleZ!.range).toEqual([-30, 30]);
  });

  it('部署的通道修正会出现在规格化表里', async () => {
    await start({ paramMap: 'CheekPuff=Paramguzui' });
    const channels = await (await fetch(url('/pack/channels.json'))).json() as Record<string, { param: string | null }>;
    expect(channels.CheekPuff!.param).toBe('Paramguzui');
  });

  it('路径越界与未知路径都不放行', async () => {
    await start();
    expect((await fetch(url('/lib/..%2F..%2Fsecret.txt'))).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(url('/nope'))).status).toBe(404);
  });

  it('模型目录里有多个 .model3.json 而没点名时报错,不猜', async () => {
    writeFileSync(join(modelDir, 'another.model3.json'), '{}', 'utf8');
    await expect(start()).rejects.toThrow(/多个 .model3.json/);
  });
});

describe('内部状态驱动', () => {
  it('推入情绪后,推流里的通道值随之改变(即便她一句话没说)', async () => {
    // 待机动作关掉:这一条量的是情绪基线本身,不要让呼吸晃进来。
    const live = await start({ idleAmount: 0 });
    const controller = new AbortController();
    const frame = await firstFrame(controller.signal) as { channels: Record<string, number> };
    controller.abort();
    expect(frame.channels.MouthSmile).toBe(0); // 中性基线

    const second = new AbortController();
    live.setInternalState({ valence: 0.9, arousal: 0.6, bond: 0.2, loneliness: 0.2, shyness: 0.1, empathy: 0 });
    const happy = await firstFrame(second.signal) as { channels: Record<string, number> };
    second.abort();
    expect(happy.channels.MouthSmile).toBeGreaterThan(0.5);
  });

  it('挂载前推入的状态在起服务时补算,不丢', async () => {
    const pre = new Live2DWorld({ cfg: config(), packageDir: root });
    pre.setInternalState({ valence: 0.9, arousal: 0.6, bond: 0.2, loneliness: 0.2, shyness: 0.1, empathy: 0 });
    world = pre;
    await pre.start(host);
    port = Number(new URL(pre.url()).port);
    const controller = new AbortController();
    const frame = await firstFrame(controller.signal) as { channels: Record<string, number> };
    controller.abort();
    expect(frame.channels.MouthSmile).toBeGreaterThan(0.5);
  });
});

/** 情绪各维度的出厂基线;心情判定与基线通道都拿它当中性。 */
const calm = { valence: 0.35, arousal: 0.55, bond: 0.1, loneliness: 0.2, shyness: 0.1, empathy: 0 };

describe('心情驱动的表情层', () => {

  it('心情进表就挂对应表情,并随推流送到页面', async () => {
    const live = await start();
    live.setInternalState({ ...calm, shyness: 0.6 }, '害羞');
    const controller = new AbortController();
    const frame = await firstFrame(controller.signal) as { expression: string | null };
    controller.abort();
    expect(frame.expression).toBe('blush');
  });

  it('心情不在表里就是 null,交给连续的基线', async () => {
    const live = await start();
    live.setInternalState({ ...calm, loneliness: 0.8 }, '寂寞');
    const controller = new AbortController();
    const frame = await firstFrame(controller.signal) as { expression: string | null };
    controller.abort();
    expect(frame.expression).toBeNull();
  });

  it('表情表可以核对:有哪些、怎么映、此刻挂的是哪个', async () => {
    const live = await start();
    live.setInternalState(calm, '元气');
    const table = await (await fetch(url('/pack/expressions.json'))).json() as {
      available: string[]; moodMap: Record<string, string>; current: string | null;
    };
    expect(table.available).toEqual(['blush', 'heart', 'lean', 'sing']);
    expect(table.moodMap['害羞']).toBe('blush');
    expect(table.current).toBe('sing');
  });

  it('模型没有那个表情时不挂', async () => {
    // 把模型替身换成一个只有 sing 的版本。
    writeFileSync(
      join(modelDir, 'miku.model3.json'),
      JSON.stringify({ version: 3, FileReferences: { Expressions: [{ Name: 'sing', File: 'sing.exp3.json' }] } }),
      'utf8',
    );
    const live = await start();
    live.setInternalState({ ...calm, shyness: 0.6 }, '害羞');
    const controller = new AbortController();
    const frame = await firstFrame(controller.signal) as { expression: string | null };
    controller.abort();
    expect(frame.expression).toBeNull();
    live.setInternalState(calm, '元气');
    expect(await (await fetch(url('/pack/expressions.json'))).json()).toMatchObject({ current: 'sing' });
  });
});

describe('outputTap', () => {
  it('正文里的词触发对应片段,并出现在推流里', async () => {
    const live = await start({ idleAmount: 0 });
    const tap = live.outputTap();
    tap.onEvent({ type: 'response.output_text.delta', delta: '我点点头' } as never);
    const controller = new AbortController();
    const frame = await firstFrame(controller.signal) as { channels: Record<string, number>; speaking: boolean };
    controller.abort();
    expect(frame.speaking).toBe(true);
    expect(frame.channels.FaceAngleY!).toBeLessThan(0); // nod 把头顶下去
    tap.onRoundEnd?.();
  });

  it('externalizes 只在真有页面看着、且这一轮确实说了字的时候为真', async () => {
    const live = await start();
    const tap = live.outputTap();
    const delta = { type: 'response.output_text.delta', delta: '你好' } as never;
    // 没人在看:不算外化,让新输入抢占去处理它更划算。
    expect(tap.externalizes?.(delta)).toBe(false);

    const controller = new AbortController();
    const pending = firstFrame(controller.signal);
    await pending; // 连上一个页面
    expect(live.clientCount()).toBe(1);
    expect(tap.externalizes?.(delta)).toBe(true);
    expect(tap.externalizes?.({ type: 'response.output_text.delta', delta: '' } as never)).toBe(false);
    expect(tap.externalizes?.({ type: 'response.created' } as never)).toBe(false);
    controller.abort();
  });

  it('被打断时清掉片段,不让动作卡在半路', async () => {
    const live = await start({ idleAmount: 0 });
    const tap = live.outputTap();
    tap.onEvent({ type: 'response.output_text.delta', delta: '微笑' } as never);
    expect(live.console().badges).toBeDefined();
    tap.onAbort?.('preempted');
    const controller = new AbortController();
    const frame = await firstFrame(controller.signal) as { channels: Record<string, number>; speaking: boolean };
    controller.abort();
    expect(frame.speaking).toBe(false);
    expect(frame.channels.MouthSmile).toBe(0);
  });

  it('说话时长按字数估:长句子比短句子说得久', async () => {
    const live = await start({ speechTailMs: 100, speechMsPerChar: 100 });
    const tap = live.outputTap();
    tap.onEvent({ type: 'response.output_text.delta', delta: '一' } as never);
    const short = await firstFrame(new AbortController().signal) as { speaking: boolean };
    expect(short.speaking).toBe(true);

    live.onTurnEnded();
    // 五个字 × 100ms = 500ms:过 200ms 还在说,再过 500ms 已经停了。
    tap.onEvent({ type: 'response.output_text.delta', delta: '一二三四五' } as never);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const mid = await firstFrame(new AbortController().signal) as { speaking: boolean };
    expect(mid.speaking).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await firstFrame(new AbortController().signal) as { speaking: boolean };
    expect(after.speaking).toBe(false);
  });
});

describe('台词即演出指令', () => {
  it('推流帧带上数值面板要的那几项:情绪六维、心情、正在做的片段', async () => {
    const live = await start();
    live.setInternalState({ ...calm, shyness: 0.62, valence: 0.5 }, '害羞');
    const controller = new AbortController();
    const frame = await firstFrame(controller.signal) as {
      emotion: Record<string, number>;
      mood: string;
      clips: string[];
      expression: string | null;
    };
    controller.abort();
    expect(frame.mood).toBe('害羞');
    expect(frame.emotion.shyness).toBeCloseTo(0.62, 6);
    expect(frame.emotion.valence).toBeCloseTo(0.5, 6);
    expect(frame.expression).toBe('blush');
    expect(Array.isArray(frame.clips)).toBe(true);
  });

  it('她什么都没说的时候身体也在动:待机动作', async () => {
    const live = await start();
    // 不加任何片段:两帧之间通道值仍应变化,否则画面是一张静止的图。
    const a = await firstFrame(new AbortController().signal) as { channels: Record<string, number> };
    await new Promise((resolve) => setTimeout(resolve, 220));
    const b = await firstFrame(new AbortController().signal) as { channels: Record<string, number> };
    expect(a.channels.FaceAngleZ).not.toBe(b.channels.FaceAngleZ);
  });

  it('关掉待机动作后纹丝不动', async () => {
    const live = await start({ idleAmount: 0 });
    const a = await firstFrame(new AbortController().signal) as { channels: Record<string, number> };
    await new Promise((resolve) => setTimeout(resolve, 220));
    const b = await firstFrame(new AbortController().signal) as { channels: Record<string, number> };
    expect(a.channels).toEqual(b.channels);
  });

  it('措辞命中的表情压过心情那张,过期后回到心情那张', async () => {
    const live = await start({ expressionHoldMs: 60 });
    live.setInternalState(calm, '元气'); // 心情那张是 sing
    expect(await (await fetch(url('/pack/expressions.json'))).json()).toMatchObject({ current: 'sing' });

    const tap = live.outputTap();
    tap.onEvent({ type: 'response.output_text.delta', delta: '人家会害羞的啦' } as never);
    const hit = await (await fetch(url('/pack/expressions.json'))).json() as { current: string };
    expect(hit.current).toBe('blush');

    await new Promise((resolve) => setTimeout(resolve, 90));
    const expired = await (await fetch(url('/pack/expressions.json'))).json() as { current: string };
    expect(expired.current).toBe('sing');
  });

  it('同一段话里同一条指令只触发一次:过期后不因再次命中而续期', async () => {
    const live = await start({ expressionHoldMs: 80 });
    const tap = live.outputTap();
    const read = async (): Promise<string | null> =>
      (await firstFrame(new AbortController().signal) as { expression: string | null }).expression;

    expect(await read()).toBeNull();

    tap.onEvent({ type: 'response.output_text.delta', delta: '我有点害' } as never);
    tap.onEvent({ type: 'response.output_text.delta', delta: '羞' } as never);
    expect(await read()).toBe('blush');

    // 指令已过期(80ms),回到没有表情的心情;同一句话里又说了一次「害羞」,不该重新触发。
    await new Promise((done) => setTimeout(done, 250));
    tap.onEvent({ type: 'response.output_text.delta', delta: '真的很害羞' } as never);
    expect(await read()).toBeNull();
  });

  it('表情挂上的那一刻播它的伴随片段,新表情的伴随顶掉旧的', async () => {
    const live = await start({ expressionHoldMs: 60_000 });
    live.setInternalState({ ...calm, shyness: 0.6 }, '害羞');
    const shy = await firstFrame(new AbortController().signal) as { expression: string | null; clips: string[] };
    expect(shy.expression).toBe('blush');
    expect(shy.clips).toContain('pout_puff');

    // 换心情就是换表情:新表情的伴随片段顶掉旧的(同类同形状),不与词表的片段抢位。
    live.setInternalState(calm, '开心');
    const happy = await firstFrame(new AbortController().signal) as { expression: string | null; clips: string[] };
    expect(happy.expression).toBe('heart');
    expect(happy.clips).toContain('excited_bounce');
    expect(happy.clips).not.toContain('pout_puff');
  });

  it('推流帧带表情参数:整组开关的清单,与当前表情要写的值', async () => {
    const live = await start();
    live.setInternalState({ ...calm, shyness: 0.6 }, '害羞');
    const frame = await firstFrame(new AbortController().signal) as {
      expression: string | null; expressionParams: string[]; expressionValues: Record<string, number>;
    };
    expect(frame.expression).toBe('blush');
    // 清单是四个表情一共会写到的参数;值只有当前这张的。
    expect(frame.expressionParams).toEqual(['Param130', 'Param132', 'Param133', 'Param134', 'Param135']);
    expect(frame.expressionValues).toEqual({ Param130: 1 });

    // 换到比心:唱歌一路的开关不在值里,由每帧的清零兜着——串台就是这么修的。
    live.setInternalState(calm, '开心');
    const happy = await firstFrame(new AbortController().signal) as typeof frame;
    expect(happy.expression).toBe('heart');
    expect(happy.expressionValues).toEqual({ Param133: 0, Param134: 0, Param135: 1 });
  });

  it('模型没有的表情名不进推流帧,措辞表只留这份模型认得的那几条', async () => {
    const live = await start();
    const payload = await (await fetch(url('/pack/expressions.json'))).json() as {
      available: string[];
      cues: Array<{ expression: string }>;
    };
    // 替身模型只有四个情绪表情;包里的葱、QQ人、圈圈不该留在指令表里。
    expect(payload.available).toEqual(['blush', 'heart', 'lean', 'sing']);
    expect([...new Set(payload.cues.map((cue) => cue.expression))].sort())
      .toEqual(['blush', 'heart', 'lean', 'sing']);
  });
});

describe('对话框', () => {
  it('没配控制台地址时这一块就是关的', async () => {
    const live = await start();
    expect(await (await fetch(url('/pack/chat.json'))).json()).toMatchObject({ enabled: false, agent: false });
  });

  it('配了控制台地址:页面的话转到终端通道,她的话回到页面', async () => {
    // 假控制台:一个真的 WebSocket 服务端,收到什么就记下来,并回一句。
    const consoleServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((done) => consoleServer.once('listening', () => done()));
    const consolePort = (consoleServer.address() as AddressInfo).port;
    const received: string[] = [];
    consoleServer.on('connection', (socket) => {
      socket.on('message', (data) => {
        const text = data.toString();
        received.push(text);
        if (text.includes('你好')) socket.send(JSON.stringify({ type: 'msg', from: '初音未来', text: '在的哦' }));
      });
    });
    let client: WebSocket | null = null;
    try {
      const live = await start({ consoleUrl: `http://127.0.0.1:${consolePort}` });
      expect(await (await fetch(url('/pack/chat.json'))).json()).toMatchObject({ enabled: true });

      client = new WebSocket(`ws://127.0.0.1:${port}/chat`);
      const frames: string[] = [];
      client.on('message', (data) => frames.push(data.toString()));
      await new Promise<void>((done) => client!.once('open', () => done()));
      client.send(JSON.stringify({ type: 'msg', text: '你好' }));
      for (let i = 0; i < 40 && frames.length === 0; i++) await new Promise((r) => setTimeout(r, 25));

      expect(received.some((message) => message.includes('你好'))).toBe(true);
      expect(frames.some((message) => message.includes('在的哦'))).toBe(true);
    } finally {
      client?.close();
      await new Promise<void>((done) => consoleServer.close(() => done()));
    }
  });

  it('控制台不在时给页面一句能读懂的话', async () => {
    const live = await start({ consoleUrl: 'http://127.0.0.1:1' });
    const client = new WebSocket(`ws://127.0.0.1:${port}/chat`);
    const frames: string[] = [];
    client.on('message', (data) => frames.push(data.toString()));
    await new Promise<void>((done) => client.once('open', () => done()));
    for (let i = 0; i < 40 && frames.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(frames.join(' ')).toContain('连不上控制台');
    client.close();
  });
});

describe('对话框的控制台代理', () => {
  /** 假控制台:真的 HTTP 服务端,把对话框四件套要的端点都摆出来,并记下收到的请求。 */
  async function fakeConsole(): Promise<{
    server: ReturnType<typeof createServer>;
    port: number;
    seen: Array<{ method: string; path: string; body: string }>;
  }> {
    const seen: Array<{ method: string; path: string; body: string }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        const path = req.url ?? '/';
        seen.push({ method: req.method ?? 'GET', path, body });
        if (path === '/api/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            displayName: '初音未来',
            loop: { estTokens: 120000, messageCount: 30, paused: false, context: { hardTokens: 130000 } },
            context: { maxTokens: 240000, softRatio: 0.85 },
          }));
          return;
        }
        if (path === '/api/console/manifest') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            providers: [
              { id: 'llm:chat', kind: 'llm' },
              { id: 'llm:ollama', kind: 'llm' },
              { id: 'world:sample', kind: 'world' },
            ],
          }));
          return;
        }
        const state = /^\/api\/console\/providers\/([^/]+)\/panels\/settings\/state$/.exec(path);
        if (state && req.method === 'GET') {
          const page = decodeURIComponent(state[1]!);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            active: 'deepseek',
            instances: page === 'llm:chat'
              ? [{ name: 'deepseek', entry: { kind: 'chat', spec: { model: 'miku-x', thinking: true } } }]
              : [{ name: 'ollama', entry: { kind: 'ollama', spec: { model: 'r1' } } }],
          }));
          return;
        }
        if (path.endsWith('/panels/settings/models') && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ models: [{ id: 'miku-x' }, { id: 'miku-y' }] }));
          return;
        }
        if (path.endsWith('/panels/settings/activate') && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
          return;
        }
        if (path === '/api/run/pause' || path === '/api/run/resume') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
          return;
        }
        if (path === '/api/config' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            groups: [
              { group: { id: 'live2d', title: 'Live2D 形象' }, values: { 'worlds.live2d.port': 18795 } },
              { group: { id: 'work', title: '工作接口' }, values: { 'worlds.work.permission': 'ask', 'worlds.work.dshUrl': 'http://127.0.0.1:43120' } },
            ],
          }));
          return;
        }
        if (path === '/api/config' && req.method === 'POST') {
          const parsed = JSON.parse(body) as { group?: string };
          if (parsed.group !== 'live2d' && parsed.group !== 'work') {
            res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `未知配置组: ${parsed.group}` }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end('not found');
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    return { server, port: (server.address() as AddressInfo).port, seen };
  }

  const closeServer = (server: ReturnType<typeof createServer>): Promise<void> =>
    new Promise<void>((done) => server.close(() => done()));

  it('端点清单:manifest 里 llm 页各取 state,合成一页能用的平表', async () => {
    const fake = await fakeConsole();
    try {
      await start({ consoleUrl: `http://127.0.0.1:${fake.port}` });
      const out = await (await fetch(url('/dialog/providers'))).json();
      expect(out).toEqual({
        active: 'deepseek',
        instances: [
          { name: 'deepseek', kind: 'chat', model: 'miku-x', page: 'llm:chat' },
          { name: 'ollama', kind: 'ollama', model: 'r1', page: 'llm:ollama' },
        ],
      });
    } finally {
      await closeServer(fake.server);
    }
  });

  it('实例内换模型:保住模型档的其余键,只改 model', async () => {
    const fake = await fakeConsole();
    try {
      await start({ consoleUrl: `http://127.0.0.1:${fake.port}` });
      const response = await fetch(url('/dialog/model'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'deepseek', model: 'miku-y' }),
      });
      expect(await response.json()).toMatchObject({ ok: true });
      const activate = fake.seen.find((entry) => entry.path.endsWith('/panels/settings/activate'));
      expect(activate).toBeTruthy();
      expect(JSON.parse(activate!.body).args[0]).toEqual({
        name: 'deepseek',
        spec: { model: 'miku-y', thinking: true },
      });
    } finally {
      await closeServer(fake.server);
    }
  });

  it('只换端点实例不带 spec;模型目录与配置组各转各的端点', async () => {
    const fake = await fakeConsole();
    try {
      await start({ consoleUrl: `http://127.0.0.1:${fake.port}` });
      await fetch(url('/dialog/model'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ollama' }),
      });
      const activate = fake.seen.find((entry) => entry.path.endsWith('/panels/settings/activate'));
      expect(JSON.parse(activate!.body).args[0]).toEqual({ name: 'ollama' });

      const models = await (await fetch(url('/dialog/models?name=deepseek'))).json();
      expect(models).toEqual({ models: [{ id: 'miku-x' }, { id: 'miku-y' }] });
      expect(fake.seen.some((entry) =>
        entry.method === 'POST' && entry.path.endsWith('/panels/settings/models')
        && entry.body.includes('"deepseek"'))).toBe(true);

      const write = await fetch(url('/dialog/config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group: 'work', values: { permission: 'trusted' } }),
      });
      expect(await write.json()).toEqual({ ok: true });
      expect(fake.seen.some((entry) =>
        entry.method === 'POST' && entry.path === '/api/config'
        && entry.body.includes('"permission":"trusted"'))).toBe(true);
    } finally {
      await closeServer(fake.server);
    }
  });

  it('配置组读:只回点名那一组的值;组不在或缺参给能读懂的话', async () => {
    const fake = await fakeConsole();
    try {
      await start({ consoleUrl: `http://127.0.0.1:${fake.port}` });
      const out = await (await fetch(url('/dialog/config?group=work'))).json();
      expect(out).toEqual({ values: { 'worlds.work.permission': 'ask', 'worlds.work.dshUrl': 'http://127.0.0.1:43120' } });
      const missing = await (await fetch(url('/dialog/config?group=nope'))).json() as { error?: unknown };
      expect(String(missing.error)).toContain('没有 nope 这个配置组');
      const noGroup = await (await fetch(url('/dialog/config'))).json() as { error?: unknown };
      expect(String(noGroup.error)).toContain('缺少 group');
      const badBody = await fetch(url('/dialog/config'), { method: 'POST', body: 'not json' });
      expect(badBody.status).toBe(400);
      const noValues = await fetch(url('/dialog/config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group: 'work', values: 'ask' }),
      });
      expect(noValues.status).toBe(400);
    } finally {
      await closeServer(fake.server);
    }
  });

  it('状态轮询:页面一连上,帧里带上对话框要的读数', async () => {
    const fake = await fakeConsole();
    try {
      await start({ consoleUrl: `http://127.0.0.1:${fake.port}` });
      const controller = new AbortController();
      const response = await fetch(url('/state'), { signal: controller.signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let status: Record<string, unknown> | null = null;
      const deadline = Date.now() + 5000;
      while (status === null && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          const match = /^data: (.*)$/m.exec(block);
          if (!match) continue;
          const payload = JSON.parse(match[1]!) as { status?: Record<string, unknown> | null };
          if (payload.status) { status = payload.status; break; }
        }
      }
      controller.abort();
      expect(status).toMatchObject({
        estTokens: 120000, messageCount: 30,
        maxTokens: 240000, softRatio: 0.85, hardTokens: 130000,
      });
      // 运行开关不再走这一帧:权限按钮读的是配置组,帧里没有 paused 这个键。
      expect(status && 'paused' in status).toBe(false);
    } finally {
      await closeServer(fake.server);
    }
  });

  it('没配控制台:代理端点回 409,帧里 status 是 null', async () => {
    await start();
    expect((await fetch(url('/dialog/providers'))).status).toBe(409);
    expect((await fetch(url('/dialog/models?name=x'))).status).toBe(409);
    expect((await fetch(url('/dialog/model'), { method: 'POST', body: '{}' })).status).toBe(409);
    expect((await fetch(url('/dialog/config?group=work'))).status).toBe(409);
    expect((await fetch(url('/dialog/config'), { method: 'POST', body: '{"group":"work","values":{}}' })).status).toBe(409);
    const controller = new AbortController();
    const frame = await firstFrame(controller.signal) as { status: unknown };
    controller.abort();
    expect(frame.status).toBeNull();
  });

  it('控制台不在:端点清单给一句能读懂的话,不炸', async () => {
    await start({ consoleUrl: 'http://127.0.0.1:1' });
    const out = await (await fetch(url('/dialog/providers'))).json() as { error?: unknown };
    expect(String(out.error)).toContain('取端点清单失败');
  });
});

describe('外部 Agent 接入', () => {
  it('没配 Agent 时明确回绝,不装作能接', async () => {
    await start();
    const response = await fetch(url('/agent/chat'), { method: 'POST', body: '{"message":"你好"}' });
    expect(response.status).toBe(409);
  });

  it('我的一句话送到 Agent,它吐的文本流回来当字幕并驱动她的身体', async () => {
    // 假 Agent:一个真的 HTTP 服务端,收到什么就记下来,然后吐两段 SSE。
    const seen: string[] = [];
    const agentServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        seen.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write('data: {"delta":"你好"}\n\n');
        res.write('data: {"delta":"呀"}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((done) => agentServer.listen(0, '127.0.0.1', () => done()));
    const agentPort = (agentServer.address() as AddressInfo).port;
    try {
      const live = await start({ agentUrl: `http://127.0.0.1:${agentPort}` });
      expect(await (await fetch(url('/pack/chat.json'))).json()).toMatchObject({ agent: true });

      const response = await fetch(url('/agent/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '你好呀' }),
      });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const streamed = await response.text();
      expect(streamed).toContain('"delta":"你好"');
      expect(streamed).toContain('"delta":"呀"');
      expect(seen.join(' ')).toContain('你好呀'); // 我的原话送到了 Agent

      // 她"说"了这两段:推流里开始有说话标志,并有对应的动作(起音)。
      const controller = new AbortController();
      const frame = await firstFrame(controller.signal) as { speaking: boolean; clips: string[] };
      controller.abort();
      expect(frame.speaking).toBe(true);
      expect(frame.clips.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((done) => agentServer.close(() => done()));
    }
  });

  it('Agent 不在时给页面一句能读懂的话', async () => {
    const live = await start({ agentUrl: 'http://127.0.0.1:1' });
    const response = await fetch(url('/agent/chat'), { method: 'POST', body: '{"message":"你好"}' });
    const streamed = await response.text();
    expect(streamed).toContain('连不上外部 Agent');
  });
});

describe('生命周期', () => {
  it('console 给出形象页链接与配置组', async () => {
    const live = await start();
    const decl = live.console();
    expect(decl.links?.[0]?.href).toBe(live.url());
    expect(decl.config?.some((group) => group.id === 'live2d')).toBe(true);
    expect(decl.promptDocs?.[0]?.role).toBe('envPrompt');
  });

  it('端口被占用时向上找', async () => {
    const first = await start();
    const taken = Number(new URL(first.url()).port);
    const second = new Live2DWorld({ cfg: config({ port: taken }), packageDir: root });
    world = second;
    await second.start(host);
    expect(Number(new URL(second.url()).port)).toBe(taken + 1);
  });

  it('stop() 之后端口释放,再起同一个端口能成功', async () => {
    const live = await start();
    const used = Number(new URL(live.url()).port);
    await live.stop();
    world = null;
    const again = await start({ port: used });
    expect(Number(new URL(again.url()).port)).toBe(used);
  });

  it('素材包目录不存在时启动就报错,带出路径', async () => {
    await expect(start({ packDir: join(root, '没有这个目录') })).rejects.toThrow(/素材包目录不存在/);
  });
});

describe('通道偏移与参数定值', () => {
  it('偏移加在合成之后:合成出的通道值加偏移再下发', async () => {
    const live = await start({ paramOffset: 'EyeOpenLeft=1, EyeOpenRight=1' });
    const controller = new AbortController();
    const frame = await firstFrame(controller.signal) as { channels: Record<string, number> };
    controller.abort();
    // 机制用例:合成出的 0 加偏移 1 下发。眨眼类的通道不要配偏移——渲染端对它们是
    // 加法写入,0 本来就是"不动眨眼";+1 会把眼睛钉死在睁开,眯眼与闭眼全被抵消。
    expect(frame.channels.EyeOpenLeft).toBe(1);
    expect(frame.channels.EyeOpenRight).toBe(1);
  });

  it('偏移会跟着情绪走,不是钉死的常数', async () => {
    const live = await start({ paramOffset: 'EyeOpenLeft=1' });
    // 寂寞 -> 基线把眼睛压低 0.12,加偏移后是 0.88。
    live.setInternalState({ valence: 0.35, arousal: 0.55, bond: 0.1, loneliness: 0.8, shyness: 0.1, empathy: 0 });
    const controller = new AbortController();
    const frame = await firstFrame(controller.signal) as { channels: Record<string, number> };
    controller.abort();
    expect(frame.channels.EyeOpenLeft).toBeLessThan(1);
    expect(frame.channels.EyeOpenLeft).toBeGreaterThan(0.5);
  });

  it('参数定值按参数名给渲染端,每帧照写', async () => {
    await start({ paramOverrides: 'Param137=1' });
    expect(await (await fetch(url('/pack/overrides.json'))).json()).toEqual({ Param137: 1 });
  });

  it('配置串写得不成样子时不猜:解析不出的项丢掉', async () => {
    await start({ paramOffset: 'EyeOpenLeft=abc, =1, EyeOpenRight=1' });
    const controller = new AbortController();
    const frame = await firstFrame(controller.signal) as { channels: Record<string, number> };
    controller.abort();
    expect(frame.channels.EyeOpenLeft).toBe(0);
    expect(frame.channels.EyeOpenRight).toBe(1);
  });
});

describe('摸头', () => {
  const pat = (active: boolean) =>
    fetch(url('/pat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    });

  it('按住时进舒服态:表情压成脸红、眼睛闭上;松手回原样', async () => {
    const live = await start();
    live.setInternalState(calm, '元气');
    const before = await firstFrame(new AbortController().signal) as
      { expression: string | null; channels: Record<string, number> };
    expect(before.expression).toBe('sing');

    expect((await pat(true)).status).toBe(204);
    const during = await firstFrame(new AbortController().signal) as typeof before;
    expect(during.expression).toBe('blush');
    // 通道 -1:部署的偏移 +1 把参数落到 0,眼睛闭上。
    expect(during.channels.EyeOpenLeft).toBe(-1);
    expect(during.channels.EyeOpenRight).toBe(-1);

    await pat(false);
    const after = await firstFrame(new AbortController().signal) as typeof before;
    expect(after.expression).toBe('sing');
    expect(after.channels.EyeOpenLeft).not.toBe(-1);
  });

  it('开始那一刻把「被摸了摸头」递进对话,连着摸按冷却合并成一次', async () => {
    await start();
    await pat(true);
    await pat(false);
    // 冷却期内再摸:事件不重复递。
    await pat(true);
    expect(pushedEvents).toHaveLength(1);
    expect(pushedEvents[0]!.event).toMatchObject({
      type: 'live2d.pat',
      source: 'live2d',
      origin: 'internal',
      text: '（摸了摸她的头）',
    });
    expect(pushedEvents[0]!.trigger).toBe('flush');
    await pat(false);
  });

  it('素材包点名的头部网格经 /pack/pat.json 给页面', async () => {
    await start();
    const pack = await (await fetch(url('/pack/pat.json'))).json() as { headMeshes?: unknown };
    expect(Array.isArray(pack.headMeshes)).toBe(true);
    expect((pack.headMeshes as string[]).every((id) => typeof id === 'string' && id !== '')).toBe(true);
    expect((pack.headMeshes as string[]).length).toBeGreaterThan(0);
  });

  it('坏请求体回 400,不炸服务', async () => {
    await start();
    const res = await fetch(url('/pat'), { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
    // 服务还活着:下一帧照常。
    const frame = await firstFrame(new AbortController().signal) as { clients: number };
    expect(frame.clients).toBeGreaterThanOrEqual(1);
  });
});
