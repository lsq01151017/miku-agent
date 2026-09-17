/**
 * `live2d` World:她的形象。
 *
 * 驱动有三路,合成在 `Performance` 里:
 *   - **内部状态**(题目的硬要求):Persona 通过 `setInternalState()` 把六个情绪维度推进来,
 *     这里算成通道基线。WorldHost 没有人物状态通道,所以这条线走实例上的一个可选方法;
 *     扩展没被这样用时它只是空转,不影响挂载。
 *   - **她说的话**:`outputTap` 收到正文增量,扫词表触发片段。
 *   - **她的措辞**:同一段正文再扫一遍 `expressions.json`,命中的模型自带表情压过心情那张
 *     (见 `directives.ts`)——台词本身就是演出指令。
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
import {
  parseModelChannelMap,
  parseNumberMap,
  parseParamMap,
  repairFromModel,
  resolveChannels,
  unmappedChannels,
  verifyAgainstModel,
  type ResolvedChannels,
} from './channels.ts';
import { loadPack, type Pack } from './pack.ts';
import { cueExpression, missingCueExpressions, type ExpressionCue } from './directives.ts';
import { expressionForMood, missingExpressions, MOOD_EXPRESSIONS } from './expressions.ts';
import { Performance } from './performance.ts';
import { LIVE2D_CONFIG_GROUP, type Live2DConfigSection } from './config.ts';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
/** 环境提示词随包走,不在工作区里。 */
const ENV_PROMPT_FILE = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));
/** 推流间隔。60ms 比 60fps 略慢:画面里的平滑在浏览器侧做,这里不必更密。 */
const PUSH_INTERVAL_MS = 60;
const KEEPALIVE_MS = 15_000;
/** 端口被占用时向上试几个。 */
const PORT_ATTEMPTS = 5;
/** 措辞匹配只看最近这么多字:一句话很长时,前面的词不该一直压着后面的。 */
const SPOKEN_WINDOW_CHARS = 160;

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
  /** 挂载前收到的心情标签;表情层用它。 */
  private pendingMood: string | null = null;
  /** 此刻的心情与它对应的表情;心情由 Persona 给,表情由 `expressions.ts` 的表定。 */
  private mood: string | null = null;
  private moodExpression: string | null = null;
  /** 台词命中的表情:她的措辞就是演出指令,压过心情,到期回到心情那张。 */
  private directive: { expression: string; atMs: number } | null = null;
  /** 这一轮她已经说出口的正文:措辞匹配按整段看,词被切在两个增量里也认得出来。 */
  private spokenText = '';
  /** 这一轮已经用过的指令,同一条不重复触发。 */
  private firedCues = new Set<string>();
  /** 推给页面的表情名与它的序号:名字没变也要能重放同一张表情,所以带序号。 */
  private expression: string | null = null;
  private expressionToken = 0;
  /** 这份模型自带的表情名;读不到就是空集,表情层整层不启用。 */
  private modelExpressions: Set<string> = new Set();
  /** 说到什么时候为止:按字数估的时长,不是音频同步。 */
  private speakingUntilMs = 0;
  /** 包里的措辞 → 表情指令表。 */
  private cues: readonly ExpressionCue[] = [];
  private lastFrame = '';
  /** 起服务时定下来的模型入口文件名;配置问题在这一刻暴露,不留到有人打开页面。 */
  private modelFile = '';
  /** 通道 → 本模型参数;起服务时解析定下,页面直接用。 */
  private channels: ResolvedChannels = {};
  /** 通道值的偏移与不归通道管的参数定值;起服务时解析。 */
  private paramOffset: Record<string, number> = {};
  private paramOverrides: Record<string, number> = {};

  constructor(opts: Live2DWorldOptions) {
    this.cfg = opts.cfg;
    this.packageDir = opts.packageDir;
    // 随包的资源先确认在。包装漏了它们时,在这里以"构造失败"报出来,
    // 而不是等前缀装配去读环境提示词时把主循环带崩。
    const assets: ReadonlyArray<readonly [string, string]> = [
      ['播放器页面', join(WEB_DIR, 'index.html')],
      ['页面脚本', join(WEB_DIR, 'app.js')],
      ['环境提示词', ENV_PROMPT_FILE],
    ];
    for (const [what, file] of assets) {
      if (!existsSync(file)) {
        throw new Error(`${what}不在扩展包里(${file});package.json 的 files 要包含 web/ 与 ENV_PROMPT.md`);
      }
    }
  }

  /**
   * 内部状态入口。Persona 在情绪变化后调用;这是"身体由内部状态驱动"那条线。
   *
   * 连续值走通道基线,离散心情走表情层——两者写的是不相交的参数组,互不覆盖。
   * 挂载前调用也安全:先记住,起服务时补算。
   */
  setInternalState(values: EmotionValues, mood: string | null = null): void {
    this.pendingEmotion = values;
    this.pendingMood = mood;
    this.performance?.setBaseline(baselineChannels(values));
    this.mood = mood;
    this.moodExpression = expressionForMood(mood, this.modelExpressions);
  }

  /**
   * 她说了一句话(正文增量)。三件事:
   *   1. 把"她在说话"延长到这句话估的时长——口型跟着这个标志动;
   *   2. 把正文按整段攒起来,词被切在两个增量里也认得出来;
   *   3. 扫措辞指令表,命中的表情挂上去(同一轮同一条只触发一次)。
   */
  private said(text: string, nowMs: number): void {
    if (nowMs > this.speakingUntilMs) {
      // 上一段已经说完了:这是新的一段,指令与正文都从头算。
      this.spokenText = '';
      this.firedCues.clear();
    }
    const chars = [...text].length;
    const spanMs = Math.max(this.cfg.speechTailMs, chars * this.cfg.speechMsPerChar);
    this.speakingUntilMs = Math.max(this.speakingUntilMs, nowMs) + spanMs;
    this.performance?.speak(text, nowMs);

    this.spokenText = (this.spokenText + text).slice(-SPOKEN_WINDOW_CHARS);
    if (this.cfg.expressionHoldMs <= 0) return;
    const cue = cueExpression(this.cues, this.spokenText);
    if (cue === null || this.firedCues.has(cue)) return;
    this.firedCues.add(cue);
    this.directive = { expression: cue, atMs: nowMs };
  }

  /** 此刻该挂哪张表情:台词指令压过心情,指令过期就回到心情那张。 */
  private resolvedExpression(nowMs: number): string | null {
    if (this.directive && nowMs - this.directive.atMs < this.cfg.expressionHoldMs) {
      return this.directive.expression;
    }
    return this.moodExpression;
  }

  /**
   * 把此刻的表情名与它的序号同步一次。名字没变也要能重放同一张表情(她第二次说「害羞」),
   * 所以除名字之外还带一个只增不减的序号,渲染端按序号决定要不要重放。
   */
  private syncExpression(nowMs: number): string | null {
    const expression = this.resolvedExpression(nowMs);
    if (expression !== this.expression) {
      this.expression = expression;
      this.expressionToken += 1;
    }
    return expression;
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
        path: ENV_PROMPT_FILE,
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
        // 增量直接过词表:一句话里的手势在说到那个词的时候出现,不必等整句。
        this.said(delta, Date.now());
      },
      /**
       * 有页面在看,这段输出才算"已经外化",此后不许抢占这一轮——否则动作会说到一半被掐掉。
       * 没人在看就没有外部输出,让新输入抢占去处理它更划算。
       */
      externalizes: (event) =>
        event.type === 'response.output_text.delta' && (event.delta ?? '') !== '' && this.clients.size > 0,
      // 一轮结束不立刻闭嘴:她常常分几轮说话,尾巴由 `speechTailMs` 收,免得每轮之间抽一下。
      onRoundEnd: () => {},
      onAbort: () => {
        this.speakingUntilMs = 0;
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

    // 表情层:用这份模型自带的表情名,表里没有的就不挂。要在定了模型入口之后才读得到。
    this.modelExpressions = this.modelExpressionNames();
    const absent = missingExpressions(this.modelExpressions);
    if (absent.length > 0) {
      host.log.warn('心情表里提到的表情这份模型没有,那几个心情只走通道基线', { missing: absent });
    }
    this.cues = this.pack.cues;
    if (this.cues.length === 0) {
      host.log.info('素材包没有 expressions.json,台词不切表情,只走心情那层');
    } else if (this.modelExpressions.size > 0) {
      const missingCues = missingCueExpressions(this.cues, this.modelExpressions);
      if (missingCues.length > 0) {
        host.log.warn('措辞表里提到的表情这份模型没有,说到那些词不会有表情', { missing: missingCues });
      }
      // 模型上没有的表情名不进推流帧:渲染端照名字挂,挂不上的名字只会白白多一次失败。
      this.cues = this.cues.filter((cue) => this.modelExpressions.has(cue.expression));
    }
    this.mood = this.pendingMood;
    this.moodExpression = expressionForMood(this.mood, this.modelExpressions);

    // 分辨率顺序:部署覆盖 > 包的建议 > 模型自带的映射(只在建议落空时用) > 不接。
    const modelParams = this.modelParamIds();
    this.paramOffset = parseNumberMap(this.cfg.paramOffset);
    this.paramOverrides = parseNumberMap(this.cfg.paramOverrides);
    this.channels = resolveChannels(this.pack, parseParamMap(this.cfg.paramMap));
    if (modelParams !== null) {
      const repaired = repairFromModel(this.channels, modelParams, this.modelChannelMap());
      this.channels = repaired.channels;
      if (repaired.repairs.length > 0) {
        host.log.info('包里建议的参数名在这份模型上不存在,已按模型自带的映射改过来', {
          repairs: repaired.repairs,
        });
      }
    } else {
      host.log.warn('读不到模型的参数表(FileReferences 里没有 DisplayInfo),通道与参数的对照没法核对');
    }

    const unmapped = unmappedChannels(this.channels);
    if (unmapped.length > 0) {
      // 报出来而不是静默跳过:包里 `losesIfMissing` 说的就是这一刻丢了什么。
      host.log.warn('有通道没有落点(包自己说不接),这几路表演会丢', { channels: unmapped });
    }
    if (modelParams !== null) {
      // 修完还落空的,是模型上真没有、作者也没配的通道。
      const notInModel = verifyAgainstModel(this.channels, modelParams);
      if (notInModel.length > 0) {
        host.log.warn('这几路通道在这份模型上确实没有参数,表演会丢;要接就在 worlds.live2d.paramMap 里点名', {
          channels: notInModel,
        });
      }
    }

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
    this.speakingUntilMs = 0;
    this.spokenText = '';
    this.firedCues.clear();
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
      if (url.pathname === '/pack/channels.json') {
        return this.sendJson(res, this.channels);
      }
      if (url.pathname === '/pack/overrides.json') {
        return this.sendJson(res, this.paramOverrides);
      }
      if (url.pathname === '/pack/expressions.json') {
        const current = this.syncExpression(Date.now());
        return this.sendJson(res, {
          available: [...this.modelExpressions].sort(),
          moodMap: MOOD_EXPRESSIONS,
          cues: this.cues,
          current,
          expressionToken: this.expressionToken,
          mood: this.mood,
        });
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
    const nowMs = Date.now();
    const raw = this.performance?.channelsAt(nowMs) ?? {};
    // 包的约定与模型参数的约定不一致时,在合成之后、裁剪之前补上偏移(例:眼睛的"0=平常睁眼"
    // 对不上参数的"1=睁眼")。
    const channels: Record<string, number> = { ...raw };
    for (const [channel, offset] of Object.entries(this.paramOffset)) {
      channels[channel] = (channels[channel] ?? 0) + offset;
    }
    // 表情名没变也要能重放(同一张表情说两次),所以另给一个序号:变了才重新淡入。
    const expression = this.syncExpression(nowMs);
    return JSON.stringify({
      channels,
      // 表情与通道写的是不相交的参数组,渲染端两样都照做。
      expression,
      expressionToken: this.expressionToken,
      speaking: nowMs < this.speakingUntilMs,
      clients: this.clients.size,
    });
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
    // 说话与否也在帧里,所以"她闭嘴了"本身就是一次变化,不必另外造帧。
    if (!changed) return;
    const chunk = `data: ${payload}\n\n`;
    for (const client of this.clients) {
      try { client.write(chunk); } catch { this.clients.delete(client); }
    }
  }

  // ── 路径与启动 ──────────────────────────────────────────────────────────────

  /**
   * 这份模型真实拥有的参数名,来自 model3 的 `DisplayInfo`(cdi3)。
   * 读不到就返回 null——那是"没法核对",不是"没有参数"。
   */
  private modelParamIds(): Set<string> | null {
    try {
      const dir = this.resolveDir(this.cfg.modelDir, '模型');
      const model3 = JSON.parse(readFileSync(join(dir, this.modelFile), 'utf8')) as {
        FileReferences?: { DisplayInfo?: string };
      };
      const display = model3.FileReferences?.DisplayInfo;
      if (!display) return null;
      const cdi = JSON.parse(readFileSync(join(dir, display), 'utf8')) as {
        Parameters?: Array<{ Id?: string }>;
      };
      return new Set((cdi.Parameters ?? []).map((p) => p.Id).filter((id): id is string => typeof id === 'string'));
    } catch (error) {
      this.host?.log.warn('读模型参数表失败', { err: String(error) });
      return null;
    }
  }

  /**
   * 这份模型自带的表情名,来自 model3 的 `FileReferences.Expressions`。
   * 读不到就返回空集——表情层整层不启用,通道与片段照常。
   */
  private modelExpressionNames(): Set<string> {
    try {
      const dir = this.resolveDir(this.cfg.modelDir, '模型');
      const model3 = JSON.parse(readFileSync(join(dir, this.modelFile), 'utf8')) as {
        FileReferences?: { Expressions?: Array<{ Name?: string }> };
      };
      return new Set(
        (model3.FileReferences?.Expressions ?? [])
          .map((entry) => entry.Name)
          .filter((name): name is string => typeof name === 'string'),
      );
    } catch (error) {
      this.host?.log.warn('读模型表情表失败,表情层不启用', { err: String(error) });
      return new Set();
    }
  }

  /**
   * 模型目录里那份 VTube Studio 配置(作者自己写的通道→参数对照)。
   * 找不到就是空表——只用它补建议落空的通道,没有它照常跑。
   */
  private modelChannelMap(): Record<string, string> {
    try {
      const dir = this.resolveDir(this.cfg.modelDir, '模型');
      const file = readdirSync(dir).find((name) => name.toLowerCase().endsWith('.vtube.json'));
      if (!file) return {};
      return parseModelChannelMap(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    } catch (error) {
      this.host?.log.warn('读模型自带的通道映射失败,只用包的建议', { err: String(error) });
      return {};
    }
  }

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

  private modelFileName(): string {    if (this.cfg.modelFile) return this.cfg.modelFile;
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
