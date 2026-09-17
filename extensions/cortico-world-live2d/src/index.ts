/**
 * 包入口。默认导出是 `WorldDefinition`(加载器按 `cortico.kind === 'world'` 认它);
 * 命名导出是素材包与表现引擎,World 之外也能单独用。
 */
import type { WorldDefinition } from 'cortico/world.ts';
import { LIVE2D_CONFIG_GROUP, LIVE2D_DEFAULTS, type Live2DConfigSection } from './config.ts';
import { Live2DWorld } from './world.ts';

export const LIVE2D: WorldDefinition<Live2DConfigSection> = {
  id: 'live2d',
  label: 'Live2D',
  defaults: () => ({ ...LIVE2D_DEFAULTS }),
  create: (ctx) =>
    new Live2DWorld({
      cfg: ctx.cfg,
      packageDir: ctx.packageDir,
    }),
};

export { LIVE2D_CONFIG_GROUP, LIVE2D_DEFAULTS } from './config.ts';
export type { Live2DConfigSection } from './config.ts';
export { Live2DWorld } from './world.ts';
export type { Live2DWorldOptions } from './world.ts';

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
export { expressionForMood, missingExpressions, MOOD_EXPRESSIONS } from './expressions.ts';

export default LIVE2D;
