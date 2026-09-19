/**
 * 内部状态 → 身体基线。
 *
 * 这是本扩展里唯一不来自素材包的一层,也是题目那条硬要求:**身体由内部状态驱动**,
 * 而不是只由台词驱动。六个情绪维度各自相对自己的基线归一化到 [-1,1],再映射到通道量程。
 *
 * 归一化用各维度的出厂基线(见 `bots/miku/persona/emotion.ts`):"高于自己平常的样子"
 * 才是一个可解释的输入,绝对数值没有意义。
 *
 * 口型(MouthOpen)不在这里:它归说话的同步,不由情绪驱动。
 */

/** 六个维度的当前值。与 `bots/miku/persona/emotion.ts` 的 `Values` 同形。 */
export interface EmotionValues {
  valence: number;
  arousal: number;
  bond: number;
  loneliness: number;
  shyness: number;
  empathy: number;
}

/** 各维度的出厂基线;偏离它以这个为参照。 */
export const EMOTION_BASELINE: EmotionValues = {
  valence: 0.35,
  arousal: 0.55,
  bond: 0.1,
  loneliness: 0.2,
  shyness: 0.1,
  empathy: 0,
};

export interface BaselineWeights {
  smile: number;
  tilt: number;
  lookAway: number;
  lean: number;
  eyeOpen: number;
  brow: number;
  cheek: number;
}

export const DEFAULT_BASELINE_WEIGHTS: BaselineWeights = {
  smile: 0.7,
  tilt: 12,
  lookAway: 8,
  lean: 6,
  eyeOpen: 0.18,
  brow: 0.3,
  cheek: 0.25,
};

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));
/** 归一化并保留三位小数:同一状态算出同一组数字,便于对照与测试。 */
const unit = (value: number, from: number, span: number): number => clamp(Math.round(((value - from) / span) * 1000) / 1000, -1, 1);
/** `-0` 与 `0` 不是同一个值(例如 `Object.is`);中性偏移一律写成 `0`。 */
const round = (value: number): number => (value === 0 ? 0 : Math.round(value * 1000) / 1000);

/**
 * 此刻该把身体摆成什么样。返回的是"相对中性的偏移",与片段叠加后再按量程裁剪。
 */
export function baselineChannels(
  values: EmotionValues,
  weights: BaselineWeights = DEFAULT_BASELINE_WEIGHTS,
): Record<string, number> {
  const happy = unit(values.valence, EMOTION_BASELINE.valence, 0.45);
  const energy = unit(values.arousal, EMOTION_BASELINE.arousal, 0.4);
  const close = unit(values.bond, EMOTION_BASELINE.bond, 0.5);
  const alone = unit(values.loneliness, EMOTION_BASELINE.loneliness, 0.5);
  const shy = unit(values.shyness, EMOTION_BASELINE.shyness, 0.45);
  const care = clamp(values.empathy, 0, 1);

  return {
    MouthSmile: round(happy * weights.smile + care * 0.2),
    // 害羞歪头,心情好时轻轻摆正
    FaceAngleZ: round(shy * weights.tilt - happy * 3),
    // 寂寞与关切时略低头
    FaceAngleY: round(-alone * 10 - care * 2),
    // 害羞偏开身体,羁绊深时朝前
    FaceAngleX: round(shy * weights.lookAway - close * weights.lean),
    // 活力高时睁得大一点,寂寞时垂眼
    EyeOpenLeft: round(energy * weights.eyeOpen - alone * 0.12),
    EyeOpenRight: round(energy * weights.eyeOpen - alone * 0.12),
    // 害羞避开视线,羁绊深时看回镜头
    EyeRightX: round(shy * 0.35 - close * 0.8),
    EyeRightY: round(-alone * 0.2 + energy * 0.1),
    BrowLeftY: round(happy * weights.brow - alone * 0.35 + care * 0.2),
    BrowRightY: round(happy * weights.brow - alone * 0.35 + care * 0.2),
    CheekPuff: round(shy * weights.cheek),
    MouthOpen: 0,
  };
}
