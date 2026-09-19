/**
 * 措辞 → 演出指令。
 *
 * 她说的话本身就是舞台指示:写出「害羞」就该脸红,写出「唱歌」就该拿起话筒。这一层把
 * 正文里的词翻成**模型自带的表情名**,World 再把表情名放进推流帧,渲染端照名字挂表情。
 *
 * 表是数据(`expressions.json`),匹配是纯函数:同一句话永远给同一条指令,便于对照与测试。
 * 表里出现、这份模型却没有的表情名由 `missingCueExpressions` 报出来——静默失效会让
 * "为什么说「害羞」不脸红"变成谜。
 */

export interface ExpressionCue {
  /** 模型的表情名(见 model3 的 `Expressions`)。 */
  expression: string;
  /** 命中它的说法。一条指令里先长词后短词。 */
  words: readonly string[];
}

/** 把包里的原始 JSON 读成指令表;形状不对的条目丢掉,不猜。 */
export function parseCues(raw: unknown): ExpressionCue[] {
  const cues = (raw as { cues?: unknown } | null)?.cues;
  if (!Array.isArray(cues)) return [];
  const out: ExpressionCue[] = [];
  for (const entry of cues) {
    const expression = (entry as { expression?: unknown } | null)?.expression;
    const words = (entry as { words?: unknown } | null)?.words;
    if (typeof expression !== 'string' || expression === '') continue;
    if (!Array.isArray(words)) continue;
    const kept = words.filter((word): word is string => typeof word === 'string' && word !== '');
    if (kept.length === 0) continue;
    out.push({ expression, words: [...kept].sort((a, b) => b.length - a.length) });
  }
  return out;
}

/**
 * 这句话命中的表情;没有命中给 null。
 *
 * 按表的顺序取第一条命中的指令(表的顺序就是优先级),同一条指令里长词先匹配:
 * 写了「不开心」不该被「开心」抢走。
 */
export function cueExpression(cues: readonly ExpressionCue[], text: string): string | null {
  if (!text) return null;
  const haystack = text.toLowerCase();
  for (const cue of cues) {
    for (const word of cue.words) {
      if (haystack.includes(word.toLowerCase())) return cue.expression;
    }
  }
  return null;
}

/** 表里提到、这份模型没有的表情名;启动时报出来。 */
export function missingCueExpressions(
  cues: readonly ExpressionCue[],
  available: ReadonlySet<string>,
): string[] {
  return [...new Set(cues.map((cue) => cue.expression))].filter((name) => !available.has(name)).sort();
}

/**
 * 表情的伴随动作:一个片段,外加一组通道值。
 *
 * 表情只写开关参数(这份模型的脸红只写 `Param130`),它切换的是贴图/部件,不改五官——
 * 所以单挂表情时脸几乎不动。通道值让伴随动作同时驱动五官,表情才看得出来。
 * 片段名与通道名都要在包里真实存在,读取时核对,对不上就报。
 */
export interface ExpressionStagingEntry {
  /** 伴随片段名,可省。 */
  clipId?: string;
  /** 伴随通道值;键是 `params.json` 里的抽象通道。 */
  channels?: Readonly<Record<string, number>>;
}

export type ExpressionStaging = Readonly<Record<string, ExpressionStagingEntry>>;

/** 把包里的 `staging` 段读成表;形状不对的条目丢掉,不猜。 */
export function parseStaging(raw: unknown): ExpressionStaging {
  const staging = (raw as { staging?: unknown } | null)?.staging;
  if (!staging || typeof staging !== 'object' || Array.isArray(staging)) return {};
  const out: Record<string, ExpressionStagingEntry> = {};
  for (const [expression, value] of Object.entries(staging as Record<string, unknown>)) {
    if (expression === '') continue;
    // 旧写法:值直接是片段名。
    if (typeof value === 'string') {
      if (value !== '') out[expression] = { clipId: value };
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as { clipId?: unknown; channels?: unknown };
    const clipId = typeof entry.clipId === 'string' && entry.clipId !== '' ? entry.clipId : undefined;
    const channels: Record<string, number> = {};
    if (entry.channels && typeof entry.channels === 'object' && !Array.isArray(entry.channels)) {
      for (const [channel, amount] of Object.entries(entry.channels as Record<string, unknown>)) {
        if (channel === '' || typeof amount !== 'number' || !Number.isFinite(amount)) continue;
        channels[channel] = amount;
      }
    }
    const hasChannels = Object.keys(channels).length > 0;
    if (clipId === undefined && !hasChannels) continue;
    out[expression] = {
      ...(clipId === undefined ? {} : { clipId }),
      ...(hasChannels ? { channels } : {}),
    };
  }
  return out;
}
