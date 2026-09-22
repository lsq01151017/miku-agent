/**
 * 工作 World:真实 HTTP(临时目录里的桥头文件 + 系统挑端口的假 DSH),只有 DSH 那边的
 * 代理会话是假的——这里验的是回执映射、权限随行、头文件与超时,不验 DSH 本身。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nullLogger } from 'cortico/core/util.ts';
import type { ToolCallContext, ToolDef, ToolOutcome } from 'cortico/core/types.ts';
import { WORK } from '../src/definition.ts';
import { WORK_CONFIG_GROUP, WORK_DEFAULTS, WORK_PERMISSIONS, type WorkConfigSection } from '../src/config.ts';
import { WorkWorld } from '../src/world.ts';

let dataDir = '';
let world: WorkWorld | null = null;
/** 假 DSH:记录收到的请求,按用例给响应。 */
let server: Server | null = null;
let serverPort = 0;
const seen: Array<{ method: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
let respond: (req: { headers: Record<string, string>; body: Record<string, unknown> }) => {
  status: number;
  body: unknown;
} = () => ({ status: 200, body: { ok: true, reply: '做好了' } });

function config(over: Partial<WorkConfigSection> = {}): WorkConfigSection {
  return {
    ...WORK_DEFAULTS,
    enabled: true,
    dshUrl: `http://127.0.0.1:${serverPort}`,
    ...over,
  };
}

function make(over: Partial<WorkConfigSection> = {}): WorkWorld {
  world = new WorkWorld({ cfg: config(over), dataDir });
  return world;
}

const tool = (w: WorkWorld): ToolDef => w.tools()[0];

async function call(w: WorkWorld, args: Record<string, unknown>, signal?: AbortSignal): Promise<string | ToolOutcome> {
  const ctx = { role: 'test', log: nullLogger(), ...(signal ? { signal } : {}) } as ToolCallContext;
  return tool(w).handler(args, ctx);
}

function outcomeText(value: string | ToolOutcome): string {
  return typeof value === 'string' ? value : value.text;
}

function outcomeFailed(value: string | ToolOutcome): boolean {
  return typeof value === 'string' ? false : value.failed === true;
}

/** 起假 DSH;respond 每用例现换。 */
async function startFakeDsh(): Promise<void> {
  server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      seen.push({ method: req.method ?? '', headers, body });
      const out = respond({ headers, body });
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  serverPort = (server.address() as AddressInfo).port;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'work-'));
  seen.length = 0;
  await startFakeDsh();
});

afterEach(async () => {
  if (world) await world.stop();
  world = null;
  await new Promise<void>((done) => server?.close(() => done()) ?? done());
  server = null;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('配置与定义', () => {
  it('默认值:关着、指向 43120、令牌与 DSH 侧一致、问态、十分钟上限', () => {
    expect(WORK_DEFAULTS).toEqual({
      enabled: false,
      dshUrl: 'http://127.0.0.1:43120',
      token: 'bridge-miku-work-7f3a',
      permission: 'ask',
      timeoutMs: 600_000,
    });
  });

  it('配置组:键是 cfg 点分路径,permission 是三态枚举,组 id 是 work', () => {
    expect(WORK_CONFIG_GROUP.id).toBe('work');
    expect(WORK_CONFIG_GROUP.owner).toBe('world:work');
    const permission = WORK_CONFIG_GROUP.schema.properties['worlds.work.permission'] as { enum?: string[] };
    expect(permission.enum).toEqual([...WORK_PERMISSIONS]);
    expect(Object.keys(WORK_CONFIG_GROUP.schema.properties).every((key) => key.startsWith('worlds.work.'))).toBe(true);
  });

  it('定义:每次默认值都是新对象,create 给出 World 实例', () => {
    expect(WORK.id).toBe('work');
    expect(WORK.defaults()).not.toBe(WORK.defaults());
    expect(WORK.defaults().enabled).toBe(false);
    const instance = WORK.create({
      cfg: { ...WORK_DEFAULTS },
      dataDir,
    } as Parameters<typeof WORK.create>[0]);
    expect(instance).toBeInstanceOf(WorkWorld);
  });
});

describe('work_run 回执', () => {
  it('ok:true 时回执就是那轮的答复', async () => {
    const out = await call(make(), { task: '建一个文件' });
    expect(outcomeText(out)).toBe('做好了');
    expect(outcomeFailed(out)).toBe(false);
  });

  it('带 note 的成功回执把注记缀在后面', async () => {
    respond = () => ({ status: 200, body: { ok: true, reply: '部分完成', note: 'token limit reached; result may be partial' } });
    const out = await call(make(), { task: 'x' });
    expect(outcomeText(out)).toContain('部分完成');
    expect(outcomeText(out)).toContain('token limit reached');
  });

  it('ok:false 是失败回执,带上原因与部分答复', async () => {
    respond = () => ({ status: 200, body: { ok: false, error: 'work turn aborted', reply: '做到一半' } });
    const out = await call(make(), { task: 'x' });
    expect(outcomeFailed(out)).toBe(true);
    expect(outcomeText(out)).toContain('work turn aborted');
    expect(outcomeText(out)).toContain('做到一半');
  });

  it('空 task 与超长 task 就地拒,不出网', async () => {
    const w = make();
    expect(outcomeFailed(await call(w, { task: '  ' }))).toBe(true);
    expect(outcomeFailed(await call(w, { task: 'x'.repeat(8001) }))).toBe(true);
    expect(seen.length).toBe(0);
  });

  it('权限为关时本地拒,不出网,回执教她找制作人', async () => {
    const out = await call(make({ permission: 'off' }), { task: '建一个文件' });
    expect(outcomeText(out)).toContain('关着');
    expect(outcomeText(out)).toContain('权限按钮');
    expect(seen.length).toBe(0);
  });

  it('401/403/404/5xx 各给一句能读懂的话', async () => {
    respond = () => ({ status: 401, body: { ok: false, error: 'token mismatch' } });
    expect(outcomeText(await call(make(), { task: 'x' }))).toContain('令牌');
    respond = () => ({ status: 403, body: {} });
    expect(outcomeText(await call(make(), { task: 'x' }))).toContain('桌面外壳');
    respond = () => ({ status: 404, body: {} });
    expect(outcomeText(await call(make(), { task: 'x' }))).toContain('没有这条路由');
    respond = () => ({ status: 500, body: {} });
    expect(outcomeText(await call(make(), { task: 'x' }))).toContain('HTTP 500');
  });

  it('连不上时说 DSH 没在跑', async () => {
    // 端口要真被拒过才作数:小端口(如 1)会被 undici 当 bad port 直接拒,走不到 ECONNREFUSED。
    const probe = createNetServer();
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((done) => probe.close(() => done()));
    const out = await call(make({ dshUrl: `http://127.0.0.1:${closedPort}` }), { task: 'x' });
    expect(outcomeFailed(out)).toBe(true);
    expect(outcomeText(out)).toContain('连不上');
  });

  it('超时按 TimeoutError 给话;被抢占按 AbortError 给话', async () => {
    respond = () => ({ status: 200, body: { ok: true, reply: 'never' } });
    // 假 DSH 不回包:挂起连接,等客户端超时。
    server!.removeAllListeners('request');
    server!.on('request', () => { /* 挂起 */ });
    const slow = await call(make({ timeoutMs: 150 }), { task: 'x' });
    expect(outcomeText(slow)).toContain('没完');
    // 抢占:已中止的 signal 直接 AbortError。
    const abort = AbortSignal.abort();
    const preempted = await call(make(), { task: 'x' }, abort);
    expect(outcomeText(preempted)).toContain('被打断');
  });
});

describe('请求随行', () => {
  it('task、令牌与权限态都进请求体;ask/trusted 各随各的', async () => {
    await call(make(), { task: '建一个文件夹' });
    expect(seen[0].body).toEqual({ task: '建一个文件夹', perm: 'ask', token: 'bridge-miku-work-7f3a' });
    await call(make({ permission: 'trusted' }), { task: '再来一个' });
    expect(seen.at(-1)!.body.perm).toBe('trusted');
  });

  it('桥头文件有头就带上,写 null 或没有文件就不带', async () => {
    writeFileSync(join(dataDir, 'dsh-bridge.json'), JSON.stringify({ header: 'x-dsh-desktop-renderer', value: 'tok-1' }), 'utf8');
    await call(make(), { task: 'x' });
    expect(seen[0].headers['x-dsh-desktop-renderer']).toBe('tok-1');
    writeFileSync(join(dataDir, 'dsh-bridge.json'), JSON.stringify({ header: null, value: null }), 'utf8');
    await call(make(), { task: 'x' });
    expect(seen.at(-1)!.headers['x-dsh-desktop-renderer']).toBeUndefined();
    rmSync(join(dataDir, 'dsh-bridge.json'), { force: true });
    await call(make(), { task: 'x' });
    expect(seen.at(-1)!.headers['x-dsh-desktop-renderer']).toBeUndefined();
  });

  it('工具声明:act 标签、屏障后置、task 必填', () => {
    const def = tool(make());
    expect(def.name).toBe('work_run');
    expect(def.tags).toEqual(['act']);
    expect(def.barrierAfter).toBe(true);
    expect((def.parameters as { required?: string[] }).required).toEqual(['task']);
  });
});

describe('控制台与环境提示词', () => {
  it('envPromptVars 带当前权限态,改配置即变', () => {
    expect(make().envPromptVars()).toEqual({ 'work.permission': 'ask' });
    expect(make({ permission: 'trusted' }).envPromptVars()).toEqual({ 'work.permission': 'trusted' });
  });

  it('console 声明:灯、配置组与提示词文档都在', () => {
    const decl = make().console();
    expect(decl.label).toBe('工作接口');
    expect(decl.lamps?.[0].state).toBe('online');
    expect(decl.config).toEqual([WORK_CONFIG_GROUP]);
    expect(decl.promptDocs?.[0].role).toBe('envPrompt');
    expect(decl.promptDocs?.[0].key).toBe('worlds.work.envPrompt');
    expect(make({ enabled: false }).console().lamps?.[0].state).toBe('offline');
  });

  it('start/stop 不抛', async () => {
    const w = make();
    await w.start({ log: nullLogger() } as never);
    await w.stop();
  });
});
