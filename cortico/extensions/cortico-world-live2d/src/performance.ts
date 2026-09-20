/**
 * 表现引擎:把**内部状态**、**词表命中的片段**和**说话时间线**合成一路通道值。
 *
 * 三层叠起来,按这个顺序:
 *   1. 基线 — 情绪驱动,一直在;这是身体"当下是什么样"
 *   2. 片段 — 词表命中触发。pulse 走完自己结束,sustain/gaze 压着同类直到被替换或淡出
 *   3. 合成 — 相加后按 `params.json` 的量程裁剪
 *
 * 噪声与扫视都是时间的纯函数(正弦),不是随机数:同一时刻同一输入算出同一组值,
 * 对照与测试才有可能。
 */
import {
  canonicalWord,
  channelRange,
  clipKindOf,
  type ClipKind,
  type Pack,
  type VocabEntry,
} from './pack.ts';

export type ChannelValues = Record<string, number>;

export interface ActiveClip {
  clipId: string;
  /** 词汇表的分类(gesture/pose/emotion/gaze/fx);同类的 state 互相替换。 */
  category: string;
  kind: ClipKind;
  startedAtMs: number;
  intensity: number;
}

export interface PerformanceOptions {
  /** state 片段保持多久后开始淡出。 */
  stateHoldMs: number;
  /** 淡出时长。 */
  stateFadeMs: number;
  /** 待机扫视的周期。 */
  scanPeriodMs: number;
  /** 待机动作的幅度倍率;0 就是完全静止。 */
  idleAmount: number;
  /** 隔多久没有新字就算"上一句说完了",下一句重新起音。 */
  speechGapMs: number;
}

export const PERFORMANCE_DEFAULTS: PerformanceOptions = {
  stateHoldMs: 25_000,
  stateFadeMs: 8_000,
  scanPeriodMs: 4_000,
  idleAmount: 1,
  speechGapMs: 900,
};

const TAU = Math.PI * 2;
const round = (value: number): number => Math.round(value * 1000) / 1000;
/** 说话时头部重音片段的命名前缀;包里那几个是给"说到某个字时点一下头"用的。 */
const ACCENT_PREFIX = 'accent_';
/** 说满这么多字给一个头部重音。 */
const ACCENT_EVERY_CHARS = 14;

/** 线性插值;第一帧之前取第一帧,最后一帧之后取最后一帧。 */
function trackValue(track: ReadonlyArray<readonly [number, number]>, atMs: number): number {
  if (track.length === 0) return 0;
  const first = track[0]!;
  if (atMs <= first[0]) return first[1];
  for (let i = 1; i < track.length; i++) {
    const [t, v] = track[i]!;
    if (atMs <= t) {
      const [pt, pv] = track[i - 1]!;
      const span = t - pt;
      return span <= 0 ? v : pv + ((v - pv) * (atMs - pt)) / span;
    }
  }
  return track[track.length - 1]![1];
}

export class Performance {
  private baseline: ChannelValues = {};
  private active: ActiveClip[] = [];
  private readonly opts: PerformanceOptions;
  /** 说话时的头部重音:包里 `accent_` 开头的脉冲片段,按序轮换,不让每句都同一个动作。 */
  private readonly accents: readonly string[];
  private accentIndex = 0;
  private charsSinceAccent = 0;
  /** 从"还没说过话"开始:第一句永远算新的一句。 */
  private lastSpokeAtMs = Number.NEGATIVE_INFINITY;
  /** 表情的伴随通道值;跟着表情的寿命走,由 `setStaging` 替换。 */
  private staging: ChannelValues = {};

  constructor(private readonly pack: Pack, opts: Partial<PerformanceOptions> = {}) {
    this.opts = { ...PERFORMANCE_DEFAULTS, ...opts };
    this.accents = Object.keys(this.pack.clips.pulse).filter((id) => id.startsWith(ACCENT_PREFIX)).sort();
  }

  /** 内部状态算出的基线;整个身体的地板。 */
  setBaseline(values: ChannelValues): void {
    this.baseline = { ...values };
  }

  getBaseline(): ChannelValues {
    return { ...this.baseline };
  }

  /**
   * 表情的伴随通道值:表情挂着期间一直叠在基线上,换表情或表情结束就换掉。
   *
   * 表情本身只写开关参数、不改五官,所以"看得出来"要靠这一层。它与片段不同:片段有
   * 自己的时长与形状,这一层跟着表情的寿命走,由 `syncExpression` 在换挡时替换。
   */
  setStaging(channels: ChannelValues | null): void {
    this.staging = channels === null ? {} : { ...channels };
  }

  activeClips(nowMs: number): ActiveClip[] {
    this.prune(nowMs);
    return this.active.map((clip) => ({ ...clip }));
  }

  /** 词汇表 + 别名,长的在前:一句里同时出现"点头"和"用力点头"时长的赢。 */
  private candidates(): Array<{ word: string; entry: VocabEntry }> {
    const byWord = new Map<string, VocabEntry>();
    for (const entry of this.pack.vocab.entries) byWord.set(entry.word, entry);
    const all: Array<{ word: string; entry: VocabEntry }> = [...byWord].map(([word, entry]) => ({ word, entry }));
    for (const [alias, canonical] of Object.entries(this.pack.vocab.aliases)) {
      const entry = byWord.get(canonicalWord(this.pack, canonical));
      if (entry) all.push({ word: alias, entry });
    }
    return all.sort((a, b) => b.word.length - a.word.length || a.word.localeCompare(b.word));
  }

  /**
   * 说了一句台词:扫词表并触发命中的片段。返回这次**词表命中**的片段 id(按触发顺序)。
   *
   * 说话本身也是表演:新的一句起音一个 `speech_onset`,之后每说满 `ACCENT_EVERY_CHARS` 个字
   * 点一下头,重音片段按序轮换——同一句话里不会连着两次一样,跨句也是。轮换而不是随机:
   * 同一时刻同一输入必须算出同一组值。这几个动作同样进 `activeClips()`,只是不算"词表命中",
   * 所以不出现在返回值里:调用方按返回值判断"她这句话说了哪个手势"。
   *
   * 词表提到、素材包里没有的片段直接不触发——缺口由 `loadPack` 的 `missingClipIds` 报出。
   */
  speak(text: string, nowMs: number): string[] {
    if (nowMs - this.lastSpokeAtMs > this.opts.speechGapMs) {
      // 上一句已经过去了:这是新的一句,起音 + 重音从头轮。
      this.charsSinceAccent = 0;
      if (this.pack.clips.pulse['speech_onset']) this.play('speech_onset', 'speech', nowMs);
    }
    this.lastSpokeAtMs = nowMs;

    const triggered: string[] = [];
    const taken: Array<[number, number]> = [];
    for (const { word, entry } of this.candidates()) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(word, from);
        if (at === -1) break;
        const end = at + word.length;
        from = end;
        if (taken.some(([start, stop]) => at < stop && end > start)) continue;
        taken.push([at, end]);
        if (this.trigger(entry, nowMs)) triggered.push(entry.clipId);
      }
    }

    this.charsSinceAccent += [...text].length;
    if (this.accents.length > 0 && this.charsSinceAccent >= ACCENT_EVERY_CHARS) {
      this.charsSinceAccent = 0;
      const accent = this.accents[this.accentIndex % this.accents.length]!;
      this.accentIndex += 1;
      this.play(accent, 'speech', nowMs);
    }
    return triggered;
  }

  private trigger(entry: VocabEntry, nowMs: number): boolean {
    const kind = clipKindOf(this.pack, entry.clipId);
    if (kind === null) return false;
    // 同类替换:新的 state 顶掉同分类的旧 state;新的脉冲顶掉同分类的旧脉冲,免得两个手势打架。
    this.active = this.active.filter((clip) => !(clip.category === entry.channel && clip.kind === kind));
    this.active.push({
      clipId: entry.clipId,
      category: entry.channel,
      kind,
      startedAtMs: nowMs,
      intensity: entry.intensity ?? 1,
    });
    return true;
  }

  /** 直接触发一个片段,不走词表(她主动表演时用)。 */
  play(clipId: string, category: string, nowMs: number, intensity = 1): boolean {
    const kind = clipKindOf(this.pack, clipId);
    if (kind === null) return false;
    this.trigger({
      word: clipId,
      channel: category,
      clipId,
      lifecycle: kind === 'pulse' ? 'pulse' : 'state',
      intensity,
    }, nowMs);
    return true;
  }

  /**
   * 待机动作:呼吸、微晃、视线游移。
   *
   * 全是**绝对时间的纯函数**(几个不同周期的正弦),不是随机数:同一时刻算出同一组值,
   * 所以对照与测试都成立。它一直在,让"她什么都没说"的时候也不是一张静止的图;
   * 有了它,台词片段与情绪基线才是叠在一个活人身上,而不是叠在雕像上。
   *
   * 视线游移是小幅的:渲染端把它叠在眼神跟随(指针)之上,扫满量程会把跟随盖掉——
   * 眼睛永远在整幅摆动,鼠标移到哪儿都像没在看。
   */
  private idleChannels(nowMs: number): ChannelValues {
    const amount = this.opts.idleAmount;
    if (amount <= 0) return {};
    const t = nowMs / 1000;
    const breath = Math.sin((TAU * t) / 4.2);            // 呼吸:约 4.2 秒一次
    const sway = Math.sin((TAU * t) / 7.3 + 0.7);        // 身体微晃:比呼吸慢
    const glanceX = Math.sin((TAU * t) / 5.1 + 1.9);     // 视线游移:比微晃快
    const glanceY = Math.sin((TAU * t) / 3.3 + 0.4);
    return {
      FaceAngleY: round(breath * 0.8 * amount),
      FaceAngleX: round(sway * 1.1 * amount),
      FaceAngleZ: round(sway * 1.6 * amount),
      EyeRightX: round(glanceX * 0.6 * amount),
      EyeRightY: round(glanceY * 0.3 * amount),
      MouthSmile: round(breath * 0.06 * amount),
    };
  }

  /** 此刻的通道值:基线 + 待机动作 + 活动片段 + 表情伴随,按量程裁剪。顺带清掉已经结束的片段。 */
  channelsAt(nowMs: number): ChannelValues {
    this.prune(nowMs);
    const out: ChannelValues = { ...this.baseline };
    for (const [channel, value] of Object.entries(this.idleChannels(nowMs))) {
      out[channel] = (out[channel] ?? 0) + value;
    }
    for (const [channel, value] of Object.entries(this.staging)) {
      out[channel] = (out[channel] ?? 0) + value;
    }
    for (const clip of this.active) {
      const elapsed = nowMs - clip.startedAtMs;
      const weight = this.weightOf(clip, elapsed);
      if (weight <= 0) continue;
      for (const [channel, value] of Object.entries(this.contributions(clip, elapsed))) {
        out[channel] = (out[channel] ?? 0) + value * clip.intensity * weight;
      }
    }
    for (const [channel, value] of Object.entries(out)) {
      const range = channelRange(this.pack, channel);
      if (range) out[channel] = round(Math.min(range[1], Math.max(range[0], value)));
      else out[channel] = round(value);
    }
    return out;
  }

  /** 片段此刻贡献的通道值(不含基线、不含强度)。 */
  private contributions(clip: ActiveClip, elapsed: number): ChannelValues {
    const out: ChannelValues = {};
    if (clip.kind === 'pulse') {
      const pulse = this.pack.clips.pulse[clip.clipId]!;
      for (const [channel, track] of Object.entries(pulse.tracks)) out[channel] = trackValue(track, elapsed);
      return out;
    }
    if (clip.kind === 'sustain') {
      const sustain = this.pack.clips.sustain[clip.clipId]!;
      for (const [channel, hold] of Object.entries(sustain.hold)) {
        const noise = hold.noiseAmp ? hold.noiseAmp * Math.sin((TAU * (hold.noiseHz ?? 0.2) * elapsed) / 1000) : 0;
        out[channel] = hold.v + noise;
      }
      return out;
    }
    const gaze = this.pack.clips.gaze[clip.clipId]!;
    const radius = gaze.scanRadiusDeg ?? 0;
    const scan = radius * Math.sin((TAU * elapsed) / this.opts.scanPeriodMs);
    const drift = radius * 0.6 * Math.sin((TAU * elapsed) / (this.opts.scanPeriodMs * 1.7) + 1);
    out.EyeRightX = gaze.eyeX;
    out.EyeRightY = gaze.eyeY;
    out.EyeLeftX = gaze.eyeX;
    out.EyeLeftY = gaze.eyeY;
    out.FaceAngleX = gaze.headX + scan;
    out.FaceAngleY = gaze.headY + drift;
    return out;
  }

  /** 一次性片段走完即 1→0;state 保持一段时间后线性淡出,避免一个表情永远挂着。 */
  private weightOf(clip: ActiveClip, elapsed: number): number {
    if (clip.kind === 'pulse') {
      return elapsed <= this.pack.clips.pulse[clip.clipId]!.durationMs ? 1 : 0;
    }
    if (elapsed <= this.opts.stateHoldMs) return 1;
    const fading = elapsed - this.opts.stateHoldMs;
    return fading >= this.opts.stateFadeMs ? 0 : 1 - fading / this.opts.stateFadeMs;
  }

  private prune(nowMs: number): void {
    this.active = this.active.filter((clip) => this.weightOf(clip, nowMs - clip.startedAtMs) > 0);
  }

  /** 清掉活动片段,回到基线与表情伴随(交接、停止、被打断时用)。 */
  clear(): void {
    this.active = [];
  }
}
