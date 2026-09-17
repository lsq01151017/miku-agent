/**
 * 初音未来。继承 `Cormini`:工作区即记忆、Git 记账、交接与心跳都沿用基类。
 *
 * 差异是这几处:自己那份前缀模板、情绪状态、心跳措辞、工具协议段、MEMORY 段与写纪律,
 * 以及暴露给控制台的状态快照。梦在后续步骤里按同一手法覆写 `declareSessions`。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CoreApi,
  ContextHandoffResult,
  EventEnvelope,
  PrefixSegment,
  SessionDecl,
  SystemPrefixContext,
  ToolDef,
} from 'cortico/core/types.ts';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { renderTemplate } from 'cortico/core/template.ts';
import { hasRole } from 'cortico/protocol/open-responses/context-helpers.ts';
import { Cormini, MAIN, type CorminiOptions, type ContextStagePolicy } from '../../cormini/persona/persona.ts';
import { normalizeWorkspacePath } from '../../cormini/persona/memory.ts';
import {
  analyzeAffect,
  applyDeltas,
  decayEmotion,
  emotionBlock,
  emotionSnapshot,
  initialEmotion,
  type EmotionState,
  type Mood,
  type Values,
} from './emotion.ts';
import { MemoTiers, type MemoCaps } from './memoTiers.ts';
import { Dream, DREAM } from './dream.ts';
import { forgetTool } from './forget.ts';
import { memoryVars } from './memoryBand.ts';
import { memoCapGuard, moveFileTool } from './memoryTools.ts';
import { asPersonaRole, checkAccess } from './permissions.ts';
import { renderToolProtocol } from './toolProtocol.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** 人格状态袋里的键。Core 只负责原子持久化,不解释内容。 */
const EMOTION_STATE_KEY = 'emotion';

/** 开工时就摆好的目录:分层是规矩,不该等她自己想起来建。 */
const WORKSPACE_DIRS = ['note', 'memo', 'memo/active', 'memo/archived', 'people'];

/** 阶段预算默认值;首次见面那段锚由部署的 `prompts/FIRST_TURN_*.md` 提供,缺文件就不送。 */
export const MIKU_CONTEXT_DEFAULTS: ContextStagePolicy = {
  maxTokens: 64000,
  softRatio: 0.85,
  keepRatio: 1 / 3,
  firstTurn: true,
};

export interface EmotionPolicy {
  enabled: boolean;
  maxStepPerTurn: number;
  decayScale: number;
}

/** 前缀里要不要带工具表。端点能投递结构化 `tools` 时不需要。 */
export interface ToolProtocolPolicy {
  enabled: boolean;
}

/** 梦的裁量。 */
export interface DreamPolicy {
  /** 梦这一场的轮数上限。 */
  maxRounds: number;
}

export interface MikuOptions extends CorminiOptions {
  /** 情绪裁量,每次现读;不给 = 默认值。 */
  emotion?: () => EmotionPolicy;
  /** 工具协议裁量,每次现读;不给 = 不带工具表。 */
  toolProtocol?: () => ToolProtocolPolicy;
  /** memo 各层容量,每次现读;不给 = 默认值。 */
  memo?: () => MemoCaps;
  /** 梦的裁量,每次现读;不给 = 默认值。 */
  dream?: () => DreamPolicy;
  /** 请求里是否保留历史思维链;梦算预算时要它,与 core 的同一份配置。 */
  keepPastThinking?: () => boolean;
  /** 时区名;梦写时间用。基类没有这个访问器,前缀装配时才拿得到,所以由部署注入。 */
  timezone?: () => string;
  /**
   * 情绪变化时通知外面。形象层靠它拿到内部状态——那是「身体由内部状态驱动」那条线。
   * 连续值走通道基线,离散心情走表情层,所以两个都给。没人接时只是一个空转的回调。
   */
  onEmotion?: (values: Values, mood: Mood) => void;
}

/** 梦留下的浮现只留最近几条:它是反射,不是流水账。 */
const EMERGENCE_KEEP = 3;

/** 人格状态袋里的浮现键。与情绪状态同住一个袋子,Core 只负责原子持久化。 */
const EMERGENCE_STATE_KEY = 'emergences';

export class Miku extends Cormini {
  private readonly emotionPolicy: () => EmotionPolicy;
  private readonly toolProtocolPolicy: () => ToolProtocolPolicy;
  private readonly memoCaps: () => MemoCaps;
  private readonly dreamPolicy: () => DreamPolicy;
  private readonly keepPastThinking: () => boolean;
  private readonly tz: () => string;
  private readonly onEmotion: (values: Values, mood: Mood) => void;
  private dreamer: Dream | null = null;
  private state: EmotionState = initialEmotion();

  constructor(opts: MikuOptions) {
    super(opts);
    this.emotionPolicy = opts.emotion ?? ((): EmotionPolicy => ({ enabled: true, maxStepPerTurn: 0.3, decayScale: 1 }));
    this.toolProtocolPolicy = opts.toolProtocol ?? ((): ToolProtocolPolicy => ({ enabled: false }));
    this.memoCaps = opts.memo ?? ((): MemoCaps => ({ residentCap: 7, activeCap: 21 }));
    this.dreamPolicy = opts.dream ?? ((): DreamPolicy => ({ maxRounds: 8 }));
    this.keepPastThinking = opts.keepPastThinking ?? ((): boolean => false);
    this.tz = opts.timezone ?? ((): string => 'UTC');
    this.onEmotion = opts.onEmotion ?? ((): void => {});
    this.memory.ensureDirs(WORKSPACE_DIRS);
  }

  /** 每次现读容量:控制台上改完即生效,所以视图也每次重建(构造不碰盘)。 */
  private memo(): MemoTiers {
    return new MemoTiers(this.memory, this.memoCaps());
  }

  /** 状态住在人格状态袋:进程重启后接着上一次的心情。梦接上 core 之后才建。 */
  override attach(core: CoreApi): void {
    super.attach(core);
    const stored = core.personaState()[EMOTION_STATE_KEY] as EmotionState | undefined;
    if (stored && typeof stored === 'object' && typeof stored.mood === 'string' && stored.values) {
      this.state = stored;
    }
    // 先把当前状态推一次:形象层可能在这次挂载之前就已经起来了。
    this.onEmotion(this.state.values, this.state.mood);
    this.dreamer = new Dream({
      core,
      context: () => ({ maxTokens: this.context().maxTokens, keepPastThinking: this.keepPastThinking() }),
      timezone: () => this.tz(),
      dreamTools: () => this.dreamTools(),
      handoffFile: () => this.lastHandoffFile,
      log: core.log.child('dream'),
      onEmergence: (text) => this.recordEmergence(text),
    });
  }

  /** 已接线的梦;控制台的强制入梦与状态仪表用它。 */
  get dream(): Dream {
    if (!this.dreamer) throw new Error('Persona 尚未 attach 到 core');
    return this.dreamer;
  }

  /** 控制台状态用的安全读取:没接线时说空闲,不抛。 */
  dreamStatus(): { dreaming: boolean } {
    return this.dreamer?.getStatus() ?? { dreaming: false };
  }

  /** 前缀模板跟着这个包走,不跟着 cormini。 */
  protected override templateFile(name: string): string {
    return join(HERE, name);
  }

  protected override prefixVars(ctx: SystemPrefixContext): Record<string, string> {
    return {
      ...super.prefixVars(ctx),
      'persona.emotion': emotionBlock(this.state),
      'persona.memory': this.memoryBand(ctx),
    };
  }

  protected override segmentTitles(): Record<string, string> {
    return { ...super.segmentTitles(), 'persona.emotion': 'EMOTION', 'persona.memory': 'MEMORY' };
  }

  /** MEMORY 段:模板在 `MEMORY.md`,活数据由 `memoryVars` 算。现读,写完即生效。 */
  private memoryBand(ctx: { now: Date; timezone: string }): string {
    const vars = memoryVars(this.memory, this.memo(), ctx, this.emergences());
    return renderTemplate(readFileSync(join(HERE, 'MEMORY.md'), 'utf8'), vars).trim();
  }

  /** 控制台各占位符旁注用;与 `prefixVars` 同源,免得两处各写一份。 */
  override promptVarValues(ctx?: { now: Date; timezone: string }): Record<string, string> {
    const at = ctx ?? { now: new Date(), timezone: 'UTC' };
    return { ...super.promptVarValues(at), 'persona.memory': this.memoryBand(at) };
  }

  /** 文件工具之上加 `move_file`:memo 层间搬运是层满了之后唯一的出路。 */
  protected override tools(): ToolDef[] {
    return [
      ...super.tools(),
      moveFileTool({
        ws: this.memory,
        guard: (op, path, role) => this.writeGuard(op, path, role),
        capGuard: (to, from) => memoCapGuard(this.memory, this.memo(), to, from),
      }),
    ];
  }

  /**
   * 主 session 的尾巴工具加 `forget`。它是矩阵里唯一一处越权,来源是指令而不是角色:
   * 操作员明确要求忘记时当场生效,不等梦。
   */
  protected override mainTailTools(): ToolDef[] {
    return [
      ...super.mainTailTools(),
      forgetTool({
        ws: this.memory,
        reloadPrefix: () => {
          this.core?.reloadSystemPrefix();
        },
      }),
    ];
  }

  /** 写入先过权限矩阵,再过 memo 容量。拒绝理由原样回到她手上。 */
  protected override writeGuard(
    op: 'write' | 'append' | 'rename' | 'delete',
    path: string,
    role: string,
  ): string | null {
    const rel = normalizeWorkspacePath(path);
    const verdict = checkAccess(asPersonaRole(role), op, rel);
    if (!verdict.ok) return verdict.reason;
    if (op === 'write' || op === 'append') return memoCapGuard(this.memory, this.memo(), rel);
    return null;
  }

  /**
   * 工具表接在最后一段之后。段的数量与顺序本来写在 `PREFIX.md` 里,这里例外:这一段有没有
   * 取决于部署,写在模板里会让关掉它的部署留下一个空段。
   */
  override async systemSegments(ctx: SystemPrefixContext): Promise<PrefixSegment[]> {
    const segments = await super.systemSegments(ctx);
    if (!this.toolProtocolPolicy().enabled) return segments;
    const text = renderToolProtocol(this.mainTools());
    return text ? [...segments, { title: 'TOOLS', text }] : segments;
  }

  /**
   * main session 此刻装上的全部工具。取自 `declareSessions()` 而不是自己再拼一份:
   * 两处各写一份清单迟早会不一致,而前缀里写错工具名等于教模型调一个不存在的工具。
   */
  private mainTools(): ToolDef[] {
    return this.declareSessions().find((session) => session.id === MAIN)?.tools() ?? [];
  }

  /**
   * 外部事件投递时更新状态。先按经过时间回落,再按这一批的措辞判断。
   * 只看 `origin === 'external'`:那是别人说的话;内部通知不参与情绪判断。
   */
  override onDelivery(ctx: { events: EventEnvelope[] }): void {
    super.onDelivery(ctx);
    const policy = this.emotionPolicy();
    if (!policy.enabled) return;

    const spoken = ctx.events.filter((event) => event.origin === 'external' && event.text);
    if (spoken.length === 0) return;

    const reasons = decayEmotion(this.state, Date.now(), policy.decayScale);
    const { deltas, reasons: affectReasons } = analyzeAffect(spoken.map((event) => event.text).join('\n'));
    applyDeltas(this.state, deltas, reasons, policy.maxStepPerTurn);
    this.state.turns += 1;
    this.state.updatedAt = Date.now();
    this.persist();
    this.onEmotion(this.state.values, this.state.mood);

    const all = [...reasons, ...affectReasons];
    if (all.length > 0) {
      this.core?.log.debug(`[miku] 心情 ${this.state.mood}`, { reasons: all });
    }
  }

  /** 心跳那一行:怕寂寞的性格在这里出声,其余沿用基类措辞。 */
  protected override tickText(quietSeconds: number): string {
    const base = super.tickText(quietSeconds);
    if (this.state.mood !== '寂寞') return base;
    return `${base}\n[你] 好一会儿没人说话了。你想说点什么,但不必现在说。`;
  }

  /** 控制台状态快照:离散心情 + 六个连续值。 */
  emotionState(): Record<string, string> {
    return emotionSnapshot(this.state);
  }

  /**
   * 主 session 沿用基类;梦是第二个声明。它不接收事件、不持久化,
   * 轮数上限来自配置——梦做的是整理,不是对话。
   */
  override declareSessions(): SessionDecl[] {
    const maxRounds = (): number => Math.max(2, this.dreamPolicy().maxRounds);
    return [
      ...super.declareSessions(),
      {
        id: DREAM,
        label: '梦(交接后整理)',
        rounds: () => ({ soft: Math.max(1, maxRounds() - 1), hard: maxRounds() }),
        persistent: false,
        receivesEvents: false,
        tools: () => this.dreamTools(),
      },
    ];
  }

  /** 梦的工具面:全部文件工具(它要重写记忆)加只读的 World 工具(翻历史取证)。 */
  private dreamTools(): ToolDef[] {
    return [...this.tools(), ...this.ioTools('read')];
  }

  /**
   * 交接前的那一幕另排进并行的梦。排在 `super.onHandoff` **之后**:
   * 它先写下交接笔记并记下文件名,梦才读得到那一份。
   */
  override async onHandoff(
    snapshot: ContextRecord[],
    ctx: { hardTokens: number | null },
  ): Promise<ContextHandoffResult> {
    const result = await super.onHandoff(snapshot, ctx);
    if (snapshot.some((m) => !hasRole(m, 'system'))) void this.dreamer?.schedule(snapshot);
    return result;
  }

  /** MEMORY 3·反射:最近几场梦留下的话,只留最近几条。 */
  emergences(): string[] {
    const raw = this.core?.personaState()[EMERGENCE_STATE_KEY];
    return Array.isArray(raw) ? raw.filter((text): text is string => typeof text === 'string') : [];
  }

  /** 梦的浮现落进人格状态袋,并作为内部事件送到醒来那一侧。 */
  private recordEmergence(text: string): void {
    const core = this.core;
    if (!core) return;
    const tagged = `[surfaced from dream] ${text}`;
    core.personaState()[EMERGENCE_STATE_KEY] = [...this.emergences(), tagged].slice(-EMERGENCE_KEEP);
    core.savePersonaState();
    core.injectInternal(tagged, 'emergence');
  }

  private persist(): void {
    const core = this.core;
    if (!core) return;
    core.personaState()[EMOTION_STATE_KEY] = this.state;
    core.savePersonaState();
  }
}
