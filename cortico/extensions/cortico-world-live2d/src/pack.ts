/**
 * vtuber-pack 的读取与校验。三个文件是一份**素材包**,不是代码:
 *
 *   params.json     抽象通道:名字、单位、量程、建议接的模型参数、缺了会丢什么
 *   clips.json      片段,三种形状——pulse(关键帧)、sustain(保持值 + 待机噪声)、gaze(视线目标)
 *   vocab.json      中文词 → 片段,带生命周期与强度;aliases 把说法归到同一个词
 *   expressions.json 措辞 → 模型自带表情名的指令表(可选:没有这份文件就是没有这一层)
 *   pat.json        摸头识别区锚定的头部网格(可选:没有这份文件,页面上的摸头不触发)
 *
 * 通道名是抽象层:包说 `FaceAngleZ`,模型接的是 `ParamAngleZ`。换模型只换映射,不动片段。
 *
 * 数据里会有缺口(例:vocab 提到的 fx_* 片段并不在 clips 里)。读取不因缺口失败,
 * 缺口由 `missingClipIds` 列出来——静默跳过会让"为什么这个特效不出现"变成谜。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCues, parseStaging, type ExpressionCue, type ExpressionStaging } from './directives.ts';

export interface ChannelSpec {
  unit: string;
  range: readonly [number, number];
  suggests: string;
  losesIfMissing: string;
}

/** 关键帧片段:[[毫秒, 值], …],线性插值。 */
export interface PulseClip {
  id: string;
  durationMs: number;
  speechOnsetMs: number;
  tracks: Readonly<Record<string, ReadonlyArray<readonly [number, number]>>>;
}

/** 保持片段:一个值一直压着,可按正弦叠加待机噪声。 */
export interface SustainClip {
  id: string;
  hold: Readonly<Record<string, {
    v: number;
    noiseAmp?: number;
    noiseHz?: number;
    /** 包里出现的噪声种类标记(如 `drift`)。目前一律按正弦处理,不再区分。 */
    noiseKind?: string;
  }>>;
}

/** 视线片段:眼睛与头各自的目标。 */
export interface GazeClip {
  id: string;
  eyeX: number;
  eyeY: number;
  headX: number;
  headY: number;
  scanRadiusDeg?: number;
}

export interface ClipGroups {
  pulse: Readonly<Record<string, PulseClip>>;
  sustain: Readonly<Record<string, SustainClip>>;
  gaze: Readonly<Record<string, GazeClip>>;
}

/** 词汇表里的生命周期:一次性,还是压着不放。 */
export type VocabLifecycle = 'pulse' | 'state';

export interface VocabEntry {
  word: string;
  /** 词汇表的分类(gesture/pose/emotion/gaze/fx),决定同类的 state 互相替换。 */
  channel: string;
  clipId: string;
  lifecycle: VocabLifecycle;
  intensity?: number;
}

export interface Pack {
  params: Readonly<Record<string, ChannelSpec>>;
  clips: ClipGroups;
  vocab: { entries: readonly VocabEntry[]; aliases: Readonly<Record<string, string>> };
  /** 措辞 → 表情的指令表;包不带这份文件时是空表,这一层整层不启用。 */
  cues: readonly ExpressionCue[];
  /** 表情 → 伴随片段;表情挂上的那一刻播一次。 */
  staging: ExpressionStaging;
  /** 摸头识别区锚定的头部网格(ArtMesh id);空 = 页面上的摸头不触发。 */
  headMeshes: readonly string[];
  /** vocab 提到、clips 里没有的片段名。 */
  missingClipIds: readonly string[];
  /** 伴随表提到、clips 里没有的片段名。 */
  missingStagingClipIds: readonly string[];
  /** 伴随表的通道值里、`params.json` 没有抽象的通道名。 */
  unknownStagingChannels: readonly string[];
}

/** 片段在素材包里的形状。行为按它分,不按 vocab 的 `lifecycle`:形状才是数据的事实。 */
export type ClipKind = 'pulse' | 'sustain' | 'gaze';

/** 片段属于哪种形状;找不到返回 null。 */
export function clipKindOf(pack: Pack, clipId: string): ClipKind | null {
  if (pack.clips.pulse[clipId]) return 'pulse';
  if (pack.clips.sustain[clipId]) return 'sustain';
  if (pack.clips.gaze[clipId]) return 'gaze';
  return null;
}

/** 词的规范名:aliases 里指到别人的词归到被指的那个。 */
export function canonicalWord(pack: Pack, word: string): string {
  return pack.vocab.aliases[word] ?? word;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** 可选文件:读不到就是"这份包没有这一层",不是错误。 */
function readJsonIfPresent(path: string): unknown {
  try {
    return readJson<unknown>(path);
  } catch {
    return null;
  }
}

export function loadPack(dir: string): Pack {
  const params = readJson<Record<string, ChannelSpec>>(join(dir, 'params.json'));
  const clips = readJson<ClipGroups>(join(dir, 'clips.json'));
  const raw = readJson<{ entries: VocabEntry[]; aliases?: Record<string, string> }>(join(dir, 'vocab.json'));
  const vocab = { entries: raw.entries ?? [], aliases: raw.aliases ?? {} };
  const expressionsRaw = readJsonIfPresent(join(dir, 'expressions.json'));
  const cues = parseCues(expressionsRaw);
  const staging = parseStaging(expressionsRaw);
  const patRaw = readJsonIfPresent(join(dir, 'pat.json')) as { headMeshes?: unknown } | null;
  const headMeshes = Array.isArray(patRaw?.headMeshes)
    ? patRaw.headMeshes.filter((id): id is string => typeof id === 'string' && id !== '')
    : [];

  const known = new Set([
    ...Object.keys(clips.pulse ?? {}),
    ...Object.keys(clips.sustain ?? {}),
    ...Object.keys(clips.gaze ?? {}),
  ]);
  const missingClipIds = [...new Set(vocab.entries.map((e) => e.clipId).filter((id) => !known.has(id)))].sort();
  const missingStagingClipIds = [...new Set(
    Object.values(staging).map((entry) => entry.clipId).filter((id): id is string => id !== undefined && !known.has(id)),
  )].sort();
  // 伴随通道值里包没抽象的通道:写下去也没有落点,报出来。
  const knownChannels = new Set(Object.keys(params));
  const unknownStagingChannels = [...new Set(
    Object.values(staging).flatMap((entry) => Object.keys(entry.channels ?? {})).filter((name) => !knownChannels.has(name)),
  )].sort();

  return {
    params,
    clips: { pulse: clips.pulse ?? {}, sustain: clips.sustain ?? {}, gaze: clips.gaze ?? {} },
    vocab,
    cues,
    staging,
    headMeshes,
    missingClipIds,
    missingStagingClipIds,
    unknownStagingChannels,
  };
}

/** 通道量程;包没声明的通道返回 null(不裁剪)。 */
export function channelRange(pack: Pack, channel: string): readonly [number, number] | null {
  return pack.params[channel]?.range ?? null;
}
