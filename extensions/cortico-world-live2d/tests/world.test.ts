/**
 * Live2D World:真实端口、真实 HTTP 与 SSE,只有 WebSocket 之外的浏览器端是假的。
 * 模型与播放器库用临时目录里的替身文件——这里验的是路由、推流与驱动,不是 Cubism 渲染。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

const host = { log: nullLogger() } as unknown as WorldHost;

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
  return world;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'live2d-'));
  webDir = join(root, 'player');
  modelDir = join(root, 'model');
  mkdirSync(join(webDir, 'js'), { recursive: true });
  mkdirSync(modelDir, { recursive: true });
  for (const name of ['pixi.min.js', 'live2dcubismcore.min.js', 'cubism4.min.js']) {
    writeFileSync(join(webDir, 'js', name), `/* ${name} */`, 'utf8');
  }
  // 模型替身带上四个情绪表情,让表情层在测试里也是活的。
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
  writeFileSync(join(root, 'secret.txt'), '不该被读到', 'utf8');
  port = 20800 + Math.floor(Math.random() * 200);
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
    const live = await start();
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
    const controller = new AbortController();
    const frame = await firstFrame(controller.signal) as { channels: Record<string, number> };
    controller.abort();
    expect(frame.channels.MouthSmile).toBeGreaterThan(0.5);
  });
});

describe('心情驱动的表情层', () => {
  const calm = { valence: 0.35, arousal: 0.55, bond: 0.1, loneliness: 0.2, shyness: 0.1, empathy: 0 };

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
    const live = await start();
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
    const live = await start();
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
  it('偏移加在合成之后:中性基线 0 加上 1 才是模型的"睁眼"', async () => {
    const live = await start({ paramOffset: 'EyeOpenLeft=1, EyeOpenRight=1' });
    const controller = new AbortController();
    const frame = await firstFrame(controller.signal) as { channels: Record<string, number> };
    controller.abort();
    // 包的约定是"0=平常睁眼",模型的参数是"1=睁眼":不加偏移就会写成全闭。
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
    await start({ paramOverrides: 'Param137=0' });
    expect(await (await fetch(url('/pack/overrides.json'))).json()).toEqual({ Param137: 0 });
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
