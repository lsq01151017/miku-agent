/**
 * `live2d` World:她的形象。
 *
 * 驱动有两路,合成在 `Performance` 里:
 *   - **内部状态**(题目的硬要求):Persona 通过 `setInternalState()` 把六个情绪维度推进来,
 *     这里算成通道基线。WorldHost 没有人物状态通道,所以这条线走实例上的一个可选方法;
 *     扩展没被这样用时它只是空转,不影响挂载。
 *   - **她说的话**:`outputTap` 收到正文增量,扫词表触发片段。
 *
 * 渲染端复用已验证可加载的那套库(pixi + Cubism Core + cubism4)与模型,只换驱动协议:
 * 本 World 自己起一个小 HTTP 服务,`/state` 用 SSE 推通道值,页面把它写到模型参数上。
 * 不碰控制台前端,是因为改控制台要重建 Web 产物,而重建必须在没有 bot 活着的时候做。
 *
 * 口型是按说话时长跑的振荡,不是音频同步:没有语音合成就没有音素时间轴。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OutputTap, ToolDef, World, WorldConsoleDecl, WorldHost } from 'cortico/core/types.ts';
import type { WorldContext } from 'cortico/world.ts';
import { baselineChannels, EMOTION_BASELINE, type EmotionValues } from './baseline.ts';
import { loadPack, type Pack } from './pack.ts';
import { Performance } from './performance.ts';
import { LIVE2D_CONFIG_GROUP, type Live2DConfigSection } from './config.ts';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
/** 推流间隔。60ms 比 60fps 略慢:画面里的平滑在浏览器侧做,这里不必更密。 */
const PUSH_INTERVAL_MS = 60;
const KEEPALIVE_MS = 15_000;
/** 端口被占用时向上试几个。 */
const PORT_ATTEMPTS = 5;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** 播放器页面读它才知道加载哪个模型。 */
const MODEL_FILE_GLOBAL = '__DSH_MODEL_FILE__';

export interface Live2DWorldOptions {
  cfg: Live2DConfigSection;
  packageDir: string;
}

export class Live2DWorld implements World {
  readonly id = 'live2d';

  private readonly cfg: Live2DConfigSection;
  private readonly packageDir: string;
  private host: WorldHost | null = null;
  private pack: Pack | null = null;
  private performance: Performance | null = null;
  private server: Server | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private readonly clients = new Set<ServerResponse>();
  private boundPort = 0;
  /** 挂载前收到的内部状态:先记着,起服务时补上。 */
  private pendingEmotion: EmotionValues | null = null;
  private speaking = false;
  private lastFrame = '';
  /** 起服务时定下来的模型入口文件名;配置问题在这一刻暴露,不留到有人打开页面。 */
  private modelFile = '';

  constructor(opts: Live2DWorldOptions) {
    this.cfg = opts.cfg;
    this.packageDir = opts.packageDir;
  }

  /**
   * 内部状态入口。Persona 在情绪变化后调用;这是"身体由内部状态驱动"那条线。
   * 挂载前调用也安全——先记住,起服务时补算。
   */
  setInternalState(values: EmotionValues): void {
    this.pendingEmotion = values;
    this.performance?.setBaseline(baselineChannels(values));
  }

  /** 渲染页的地址;服务没起来时给的是配置端口上的预期地址。 */
  url(): string {
    return `http://127.0.0.1:${this.boundPort || this.cfg.port}/`;
  }

  clientCount(): number {
    return this.clients.size;
  }

  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return [];
  }

  console(): WorldConsoleDecl {
    const up = this.server !== null;
    return {
      label: 'Live2D',
      lamps: [{
        label: '形象',
        state: up ? 'online' : 'offline',
        hint: up ? `${this.clients.size} 个页面连着` : '渲染服务没起来',
      }],
      badges: [
        { label: '端口', value: up ? String(this.boundPort) : String(this.cfg.port), tone: up ? 'on' : 'off' },
        { label: '页面', value: this.clients.size, tone: this.clients.size > 0 ? 'on' : 'off' },
      ],
      // 形象页是独立的渲染面,不是控制台的一页:它要全屏、要一直开着。
      links: [{ label: '打开形象页', href: this.url() }],
      config: [LIVE2D_CONFIG_GROUP],
      promptDocs: [{
        key: 'worlds.live2d.envPrompt',
        title: '形象',
        description: '告诉她身体怎么被驱动,免得她用文字描述自己的表情。',
        path: fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url)),
        role: 'envPrompt',
        vars: [],
      }],
    };
  }

  outputTap(): OutputTap {
    return {
      onEvent: (event) => {
        if (event.type !== 'response.output_text.delta') return;
        const delta = event.delta ?? '';
        if (!delta) return;
        this.speaking = true;
        // 增量直接过词表:一句话里的手势在说到那个词的时候出现,不必等整句。
        this.performance?.speak(delta, Date.now());
      },
      /**
       * 有页面在看,这段输出才算"已经外化",此后不许抢占这一轮——否则动作会说到一半被掐掉。
       * 没人在看就没有外部输出,让新输入抢占去处理它更划算。
       */
      externalizes: (event) =>
        event.type === 'response.output_text.delta' && (event.delta ?? '') !== '' && this.clients.size > 0,
      onRoundEnd: () => { this.speaking = false; },
      onAbort: () => {
        this.speaking = false;
        this.performance?.clear();
      },
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.pack = loadPack(this.resolveDir(this.cfg.packDir, '素材包'));
    this.performance = new Performance(this.pack, {
      stateHoldMs: this.cfg.stateHoldMs,
      stateFadeMs: this.cfg.stateFadeMs,
    });
    // 先摆成中性:形象不该在她推来第一份状态之前是一张空表,渲染端拿不到通道就没法复位。
    this.performance.setBaseline(baselineChannels(this.pendingEmotion ?? EMOTION_BASELINE));

    if (this.pack.missingClipIds.length > 0) {
      host.log.warn('素材包有缺口:词表提到的片段不在 clips 里,这些词不会触发任何表演', {
        missing: this.pack.missingClipIds,
      });
    }

    // 起服务之前先把配置查完:路径不对、模型点不清,都在挂载时报出来,不留到有人打开页面。
    this.modelFile = this.modelFileName();

    this.server = createServer((req, res) => this.handle(req, res));
    this.boundPort = await this.listen(this.cfg.port);
    this.pushTimer = setInterval(() => this.pushFrame(), PUSH_INTERVAL_MS);
    host.log.info(`形象页已启动 ${this.url()}`);
  }

  async stop(): Promise<void> {
    if (this.pushTimer) clearInterval(this.pushTimer);
    this.pushTimer = null;
    for (const client of this.clients) {
      try { client.end(); } catch { /* 断开即可 */ }
    }
    this.clients.clear();
    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    this.performance = null;
    this.host = null;
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }

  onTurnEnded(): void {
    this.speaking = false;
  }

  onHandoffEnded(): void {
    this.performance?.clear();
  }

  shutdownVerification(): readonly { key: string; label: string; status: 'verified-ended'; detail: string; manualAction: string }[] {
    return [{
      key: 'live2d-server',
      label: 'Live2D 渲染服务',
      status: 'verified-ended',
      detail: this.server === null ? '端口已释放' : '仍在监听',
      manualAction: '无需操作',
    }];
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET') {
      res.writeHead(405).end('only GET');
      return;
    }
    try {
      if (url.pathname === '/') return this.sendPage(res);
      if (url.pathname === '/app.js') return this.sendFile(res, join(WEB_DIR, 'app.js'));
      if (url.pathname === '/pack/params.json') {
        return this.sendJson(res, this.pack?.params ?? {});
      }
      if (url.pathname === '/state') return this.openStream(res);
      if (url.pathname.startsWith('/lib/')) {
        return this.sendFile(res, this.underRoot(this.resolveDir(this.cfg.webDir, '播放器库'), url.pathname.slice('/lib/'.length)));
      }
      if (url.pathname.startsWith('/model/')) {
        return this.sendFile(res, this.underRoot(this.resolveDir(this.cfg.modelDir, '模型'), url.pathname.slice('/model/'.length)));
      }
      res.writeHead(404).end('not found');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.host?.log.warn('请求处理失败', { path: url.pathname, err: detail });
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(detail);
    }
  }

  /** 页面只注入一个模型文件名;其余都在 `/app.js` 里。 */
  private sendPage(res: ServerResponse): void {
    const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8')
      .replace('</head>', `<script>window.${MODEL_FILE_GLOBAL} = ${JSON.stringify(this.modelFile)};</script>\n</head>`);
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html']! }).end(html);
  }

  private sendJson(res: ServerResponse, value: unknown): void {
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.json']!, 'Cache-Control': 'no-store' })
      .end(JSON.stringify(value));
  }

  private sendFile(res: ServerResponse, path: string): void {
    if (!existsSync(path) || !statSync(path).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    }).end(readFileSync(path));
  }

  private openStream(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    // 一接上就先给一帧,免得页面空着等下一次变化。
    res.write(`data: ${this.frame()}\n\n`);
    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* 下一帧会清掉 */ }
    }, KEEPALIVE_MS);
    res.on('close', () => {
      clearInterval(keepalive);
      this.clients.delete(res);
    });
  }

  // ── 推流 ────────────────────────────────────────────────────────────────────

  private frame(): string {
    const channels = this.performance?.channelsAt(Date.now()) ?? {};
    return JSON.stringify({ channels, speaking: this.speaking, clients: this.clients.size });
  }

  /**
   * 只在有页面连着、且内容变了的时候发。相同帧不发:通道值一秒变十几次,
   * 全发出去只是让浏览器白忙。
   */
  private pushFrame(): void {
    if (this.clients.size === 0) return;
    const payload = this.frame();
    const changed = payload !== this.lastFrame;
    this.lastFrame = payload;
    if (!changed && !this.speaking) return;
    const chunk = `data: ${payload}\n\n`;
    for (const client of this.clients) {
      try { client.write(chunk); } catch { this.clients.delete(client); }
    }
  }

  // ── 路径与启动 ──────────────────────────────────────────────────────────────

  /** 相对路径按 bot 代码包解析:素材包随人格包走,不随部署。 */
  private resolveDir(value: string, what: string): string {
    const dir = isAbsolute(value) ? value : join(this.packageDir, value);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`${what}目录不存在: ${dir}`);
    }
    return resolve(dir);
  }

  /** 静态路由的根约束:拼出来的路径必须还在根里面。 */
  private underRoot(root: string, relative: string): string {
    const path = resolve(join(root, normalize(decodeURIComponent(relative))));
    if (path !== root && !path.startsWith(root + sep)) throw new Error('路径越界');
    return path;
  }

  private modelFileName(): string {
    if (this.cfg.modelFile) return this.cfg.modelFile;
    const dir = this.resolveDir(this.cfg.modelDir, '模型');
    const found = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.model3.json')).sort();
    if (found.length === 1) return found[0]!;
    throw new Error(found.length === 0
      ? `模型目录里没有 .model3.json: ${dir}`
      : `模型目录里有多个 .model3.json,请在 worlds.live2d.modelFile 点名: ${found.join(', ')}`);
  }

  private async listen(port: number): Promise<number> {
    for (let offset = 0; offset < PORT_ATTEMPTS; offset++) {
      const attempt = port + offset;
      try {
        await new Promise<void>((done, fail) => {
          const onError = (error: Error): void => fail(error);
          this.server!.once('error', onError);
          this.server!.listen(attempt, '127.0.0.1', () => {
            this.server!.off('error', onError);
            done();
          });
        });
        return attempt;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE') throw error;
      }
    }
    throw new Error(`端口 ${port} 起连续 ${PORT_ATTEMPTS} 个都被占用`);
  }
}
