/**
 * 包入口。素材包 → 通道值的那一段在这里对外可用,不依赖 World 的运行时:
 * 表现引擎可以被单测、被别的渲染端、被控制台预览直接使用。
 */
export { canonicalWord, channelRange, clipKindOf, loadPack } from './pack.ts';
export type {
  ChannelSpec,
  ClipGroups,
  ClipKind,
  GazeClip,
  Pack,
  PulseClip,
  SustainClip,
  VocabEntry,
  VocabLifecycle,
} from './pack.ts';
export { PERFORMANCE_DEFAULTS, Performance } from './performance.ts';
export type { ActiveClip, ChannelValues, PerformanceOptions } from './performance.ts';
export { baselineChannels, DEFAULT_BASELINE_WEIGHTS, EMOTION_BASELINE } from './baseline.ts';
export type { BaselineWeights, EmotionValues } from './baseline.ts';
