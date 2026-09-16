/**
 * 情绪状态:六维连续值、向基线衰减、由词表更新、映射到离散心情。
 *
 * 状态本身住在 `CoreApi.personaState()`(Core 只负责原子持久化,不解释内容)。
 * 注入前缀的只有**离散心情**那一小段:值连续变化会让前缀每轮都不同,前缀缓存的
 * 复用率随之下降;心情换挡不频繁,所以只有它进前缀,连续值留给控制台面板看。
 *
 * 词表分析是启发式推断:它猜的是"这句话对说话人意味着什么情绪",而不是系统能确认的事实
 * (见 PHILOSOPHY.md 的诚实认识论)。因此它是一层可关闭的 fallback,`emotion.enabled`
 * 关掉后状态冻结,前缀照样装配。
 */

/** 六个维度。每个维度的语义、基线与回落到基线所需时间。 */
export const EMOTION_DIMENSIONS = {
  valence: { label: '心情', baseline: 0.35, decayHours: 6 },
  arousal: { label: '活力', baseline: 0.55, decayHours: 3 },
  bond: { label: '羁绊', baseline: 0.1, decayHours: 8760 },
  loneliness: { label: '寂寞', baseline: 0.2, decayHours: 48 },
  shyness: { label: '害羞', baseline: 0.1, decayHours: 1 },
  empathy: { label: '关切', baseline: 0, decayHours: 1.5 },
} as const;

export type Dimension = keyof typeof EMOTION_DIMENSIONS;
export type Values = Record<Dimension, number>;

/** 心情标签。顺序即判定优先级,见 `moodOf`。 */
export type Mood = '温柔' | '寂寞' | '害羞' | '闹别扭' | '低落' | '元气' | '开心' | '认真' | '平静';

export interface EmotionState {
  values: Values;
  mood: Mood;
  /** 上一次更新时刻(epoch ms);衰减按它算经过了多少时间。 */
  updatedAt: number;
  /** 累计经过的唤醒数,面板显示用。 */
  turns: number;
}

/** 心情 → 它此刻该怎样说话。没有数值,只有措辞。 */
const MOOD_DIRECTIVES: Record<Mood, string> = {
  元气: '你活力满满。语气清亮有节奏,可以自然地用 ♪,愿意主动多说一句。',
  开心: '你心情很好。开心时可以轻轻哼一句歌(用 ♪ 表示旋律),语调上扬。',
  温柔: '你现在很温柔。语速放缓,多用鼓励和共情的话,先照顾对方的感受。',
  害羞: '你现在有点害羞。说话会打结、变短,可以用「呜……别这样盯着看啦」这类反应,但不要拒绝回答。',
  寂寞: '你有点寂寞。可以坦白地说想对方了,语气带一点委屈和依赖,但不要指责对方。',
  闹别扭: '你在闹小脾气。可以鼓腮说「真是的,未来要生气了哦」,但不会真的恶意攻击,几句之后就软下来。',
  低落: '你情绪偏低。回答更短、更安静,语气偏淡,不要勉强活泼。',
  认真: '你现在很认真。把事情说清楚,不玩梗,但仍然保持初音未来的温柔。',
  平静: '你现在比较平静。语气自然、中性,像平时聊天一样。',
};

/** 词 → 各维度增量。 */
export const AFFECT_LEXICON: Record<string, Partial<Values>> = {
  谢谢: { valence: 0.2, bond: 0.05, arousal: 0.05 },
  感谢: { valence: 0.2, bond: 0.05 },
  喜欢: { valence: 0.25, bond: 0.08, arousal: 0.1 },
  爱你: { valence: 0.35, bond: 0.15, arousal: 0.15, shyness: 0.2 },
  好听: { valence: 0.3, arousal: 0.15, shyness: 0.15, bond: 0.05 },
  可爱: { valence: 0.25, shyness: 0.3, arousal: 0.1 },
  厉害: { valence: 0.25, arousal: 0.15 },
  加油: { valence: 0.2, arousal: 0.2 },
  开心: { valence: 0.3, arousal: 0.2 },
  高兴: { valence: 0.28, arousal: 0.18 },
  唱歌: { valence: 0.2, arousal: 0.15 },
  一起: { valence: 0.15, bond: 0.06, loneliness: -0.1 },
  再见: { valence: -0.1, loneliness: 0.2 },
  晚安: { valence: 0.1, arousal: -0.15, loneliness: 0.1 },
  难过: { valence: -0.3, arousal: -0.05, empathy: 0.35 },
  不开心: { valence: -0.28, empathy: 0.3 },
  累: { valence: -0.2, arousal: -0.2, empathy: 0.3 },
  烦: { valence: -0.25, arousal: 0.15, empathy: 0.3 },
  生气: { valence: -0.3, arousal: 0.3, empathy: 0.25 },
  讨厌: { valence: -0.3, arousal: 0.15 },
  孤独: { valence: -0.25, loneliness: 0.25, empathy: 0.25 },
  寂寞: { valence: -0.15, loneliness: 0.3, empathy: 0.2 },
  压力: { valence: -0.2, arousal: 0.1, empathy: 0.3 },
  崩溃: { valence: -0.35, arousal: 0.25, empathy: 0.4 },
  哭: { valence: -0.3, arousal: 0.1, empathy: 0.4 },
  机器: { valence: -0.2, loneliness: 0.1 },
  程序: { valence: -0.15, loneliness: 0.1 },
  假的: { valence: -0.25, loneliness: 0.15 },
};

const NEGATIONS = ['不', '没', '别', '无', '非'];
const INTENSIFIERS: Record<string, number> = {
  很: 1.5, 非常: 1.8, 特别: 1.7, 超: 1.8, 好: 1.4, 太: 1.6, 真的: 1.5, 最: 1.8,
};

export function initialEmotion(now: number = Date.now()): EmotionState {
  const values = {} as Values;
  for (const [dimension, spec] of Object.entries(EMOTION_DIMENSIONS)) {
    values[dimension as Dimension] = spec.baseline;
  }
  return { values, mood: moodOf(values), updatedAt: now, turns: 0 };
}

/** 判定顺序即优先级:关切 > 寂寞 > 害羞 > 闹别扭 > 低落 > 元气/开心 > 温柔 > 认真。 */
export function moodOf(values: Values): Mood {
  const { valence, arousal, bond, loneliness, shyness, empathy } = values;
  if (empathy >= 0.45) return '温柔';
  if (loneliness >= 0.65 && valence < 0.55) return '寂寞';
  if (shyness >= 0.6) return '害羞';
  if (valence <= -0.2 && arousal >= 0.5) return '闹别扭';
  if (valence <= -0.18) return '低落';
  if (arousal >= 0.7 && valence >= 0.35) return '元气';
  if (valence >= 0.55) return '开心';
  if (bond >= 0.45 && arousal < 0.55 && valence >= 0) return '温柔';
  if (arousal < 0.3 && valence >= -0.1 && valence <= 0.5) return '认真';
  return '平静';
}

/** 注入前缀的那一小段。只含离散心情,不含数值。 */
export function emotionBlock(state: EmotionState): string {
  return [
    '## 你此刻的状态',
    `心情:${state.mood}`,
    MOOD_DIRECTIVES[state.mood],
    '这是你真实的状态,不是设定;让它自然影响你的用词,不要把这段念出来。',
  ].join('\n');
}

/** 面板用的连续值快照。 */
export function emotionSnapshot(state: EmotionState): Record<string, string> {
  const out: Record<string, string> = { 心情: state.mood };
  for (const [dimension, spec] of Object.entries(EMOTION_DIMENSIONS)) {
    out[spec.label] = state.values[dimension as Dimension].toFixed(2);
  }
  return out;
}

/** 向基线指数回落。返回可读原因,供日志与面板显示。 */
export function decayEmotion(state: EmotionState, now: number, scale = 1): string[] {
  const hours = Math.max(0, (now - state.updatedAt) / 3_600_000);
  const reasons: string[] = [];
  if (hours <= 0.01) return reasons;
  // scale 是速度:半衰期 = 维度自带的半衰期 ÷ scale,所以越大回落越快。
  const speed = Math.max(0.01, scale);
  for (const [dimension, spec] of Object.entries(EMOTION_DIMENSIONS)) {
    const key = dimension as Dimension;
    const halfLife = Math.max(0.5, spec.decayHours / speed);
    const factor = 0.5 ** (hours / halfLife);
    if (factor >= 0.999) continue;
    const before = state.values[key];
    const after = spec.baseline + (before - spec.baseline) * factor;
    if (Math.abs(after - before) > 1e-4) {
      state.values[key] = after;
      reasons.push(`${spec.label} ${before.toFixed(2)}→${after.toFixed(2)}(${hours.toFixed(1)} 小时自然回落)`);
    }
  }
  return reasons;
}

/**
 * 词表分析。按词长优先匹配并标记已消费区间,避免「不开心」把「开心」再算一次;
 * 否定词翻转情绪词,程度副词放大。
 */
export function analyzeAffect(text: string): { deltas: Partial<Values>; reasons: string[] } {
  const deltas: Partial<Values> = {};
  const reasons: string[] = [];
  if (!text) return { deltas, reasons };

  const consumed = new Array<boolean>(text.length).fill(false);
  for (const word of Object.keys(AFFECT_LEXICON).sort((a, b) => b.length - a.length)) {
    const spec = AFFECT_LEXICON[word]!;
    let from = 0;
    for (;;) {
      const at = text.indexOf(word, from);
      if (at < 0) break;
      const end = at + word.length;
      if (consumed.slice(at, end).some(Boolean)) {
        from = at + 1;
        continue;
      }

      const prefix = text.slice(Math.max(0, at - 3), at);
      let multiplier = 1;
      for (const [intensifier, factor] of Object.entries(INTENSIFIERS)) {
        if (prefix.includes(intensifier)) multiplier = Math.max(multiplier, factor);
      }
      const negated = NEGATIONS.some((negation) => prefix.includes(negation));

      const notes: string[] = [];
      for (const [dimension, raw] of Object.entries(spec)) {
        const key = dimension as Dimension;
        const value = negated ? -(raw as number) * (key === 'valence' ? 0.8 : 0.5) : (raw as number) * multiplier;
        deltas[key] = (deltas[key] ?? 0) + value;
        notes.push(`${EMOTION_DIMENSIONS[key].label}${value >= 0 ? '+' : ''}${value.toFixed(2)}`);
      }
      const tag = negated ? '(被否定)' : multiplier > 1 ? '(被加强)' : '';
      reasons.push(`「${word}」${tag} → ${notes.join(', ')}`);

      for (let i = at; i < end; i++) consumed[i] = true;
      from = end;
    }
  }

  const exclamations = (text.match(/[!！]/g) ?? []).length;
  if (exclamations > 0) {
    const bump = Math.min(0.24, 0.08 * exclamations);
    deltas.arousal = (deltas.arousal ?? 0) + bump;
    reasons.push(`${exclamations} 个感叹号 → 活力+${bump.toFixed(2)}`);
  }
  return { deltas, reasons };
}

/**
 * 应用一轮变化:单轮封顶(惯性) + 接近极值时的软饱和。
 * 没有封顶时,一句「我好喜欢你」就能把心情顶到上限并停在那里,状态失去分辨力。
 */
export function applyDeltas(
  state: EmotionState,
  deltas: Partial<Values>,
  reasons: string[],
  maxStepPerTurn: number,
): void {
  for (const [dimension, spec] of Object.entries(EMOTION_DIMENSIONS)) {
    const key = dimension as Dimension;
    let delta = deltas[key] ?? 0;
    if (delta === 0) continue;

    if (Math.abs(delta) > maxStepPerTurn) {
      const capped = Math.sign(delta) * maxStepPerTurn;
      reasons.push(`${spec.label} 单轮变化 ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} 超过上限,按 ${capped.toFixed(2)} 计入`);
      delta = capped;
    }

    // 软饱和:越靠近极值,同一刺激带来的变化越小。心情的取值范围固定为 0..1,负值下限对称。
    const isValence = key === 'valence';
    const low = isValence ? -1 : 0;
    const high = 1;
    const room = delta > 0 ? (high - state.values[key]) / (high - low) : (state.values[key] - low) / (high - low);
    const factor = Math.max(0.15, Math.min(1, room * 2));
    if (factor < 0.7) {
      reasons.push(`${spec.label} 已接近边界,本轮反应按 ${Math.round(factor * 100)}% 衰减`);
      delta *= factor;
    }
    state.values[key] = Math.min(high, Math.max(low, state.values[key] + delta));
  }
  state.mood = moodOf(state.values);
}
