/**
 * 初音未来。继承 `Cormini`:工作区即记忆、Git 记账、交接与心跳都沿用基类。
 *
 * 差异只有四处:自己那份前缀模板、情绪状态、心跳措辞、以及暴露给控制台的状态快照。
 * 权限矩阵与梦在后续步骤里按同一手法覆写 `writeGuard` 与 `declareSessions`。
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoreApi, EventEnvelope, SystemPrefixContext } from 'cortico/core/types.ts';
import { Cormini, type CorminiOptions, type ContextStagePolicy } from '../../cormini/persona/persona.ts';
import {
  analyzeAffect,
  applyDeltas,
  decayEmotion,
  emotionBlock,
  emotionSnapshot,
  initialEmotion,
  type EmotionState,
} from './emotion.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** 人格状态袋里的键。Core 只负责原子持久化,不解释内容。 */
const EMOTION_STATE_KEY = 'emotion';

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

export interface MikuOptions extends CorminiOptions {
  /** 情绪裁量,每次现读;不给 = 默认值。 */
  emotion?: () => EmotionPolicy;
}

export class Miku extends Cormini {
  private readonly emotionPolicy: () => EmotionPolicy;
  private state: EmotionState = initialEmotion();

  constructor(opts: MikuOptions) {
    super(opts);
    this.emotionPolicy = opts.emotion ?? ((): EmotionPolicy => ({ enabled: true, maxStepPerTurn: 0.3, decayScale: 1 }));
  }

  /** 状态住在人格状态袋:进程重启后接着上一次的心情。 */
  override attach(core: CoreApi): void {
    super.attach(core);
    const stored = core.personaState()[EMOTION_STATE_KEY] as EmotionState | undefined;
    if (stored && typeof stored === 'object' && typeof stored.mood === 'string' && stored.values) {
      this.state = stored;
    }
  }

  /** 前缀模板跟着这个包走,不跟着 cormini。 */
  protected override templateFile(name: string): string {
    return join(HERE, name);
  }

  protected override prefixVars(ctx: SystemPrefixContext): Record<string, string> {
    return { ...super.prefixVars(ctx), 'persona.emotion': emotionBlock(this.state) };
  }

  protected override segmentTitles(): Record<string, string> {
    return { ...super.segmentTitles(), 'persona.emotion': 'EMOTION' };
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

  private persist(): void {
    const core = this.core;
    if (!core) return;
    core.personaState()[EMOTION_STATE_KEY] = this.state;
    core.savePersonaState();
  }
}
