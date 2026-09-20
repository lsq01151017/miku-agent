/**
 * `bots/miku/persona/emotion.ts` 的纯函数:词表判断、惯性上限、回落、心情映射。
 * 不构造 Core,不发网络请求。
 */
import { describe, expect, it } from 'vitest';
import {
  analyzeAffect,
  applyDeltas,
  decayEmotion,
  emotionBlock,
  initialEmotion,
  missEffect,
  moodOf,
  patEffect,
} from '../../bots/miku/persona/emotion.ts';

describe('moodOf', () => {
  it('关切优先于害羞与其他判定', () => {
    expect(moodOf({ ...initialEmotion().values, empathy: 0.5, shyness: 0.9 })).toBe('温柔');
  });

  it('寂寞要压过愉快,但压不过很高的愉悦', () => {
    expect(moodOf({ ...initialEmotion().values, loneliness: 0.8, valence: 0.4 })).toBe('寂寞');
    expect(moodOf({ ...initialEmotion().values, loneliness: 0.8, valence: 0.9 })).not.toBe('寂寞');
  });

  it('低愉悦加高唤醒是闹别扭,只有低愉悦是低落', () => {
    expect(moodOf({ ...initialEmotion().values, valence: -0.3, arousal: 0.7 })).toBe('闹别扭');
    expect(moodOf({ ...initialEmotion().values, valence: -0.3, arousal: 0.2 })).toBe('低落');
  });
});

describe('analyzeAffect', () => {
  it('否定词翻转情绪词的方向', () => {
    const plain = analyzeAffect('我喜欢这个').deltas.valence ?? 0;
    const negated = analyzeAffect('我不喜欢这个').deltas.valence ?? 0;
    expect(plain).toBeGreaterThan(0);
    expect(negated).toBeLessThan(0);
  });

  it('长词先匹配:「不开心」不会把「开心」再算一次', () => {
    const { deltas, reasons } = analyzeAffect('不开心');
    expect(deltas.valence ?? 0).toBeLessThan(0);
    expect(reasons.join('')).toContain('不开心');
    expect(reasons.join('')).not.toContain('「开心」');
  });

  it('对方处境不好会抬高关切', () => {
    expect(analyzeAffect('我今天好累').deltas.empathy ?? 0).toBeGreaterThan(0);
  });

  it('没有情绪词时不给任何维度增量', () => {
    const { deltas } = analyzeAffect('今天几号');
    expect(Object.keys(deltas)).toEqual([]);
  });
});

describe('applyDeltas', () => {
  it('单轮变化受上限约束', () => {
    const state = initialEmotion();
    const before = state.values.valence;
    applyDeltas(state, { valence: 5 }, [], 0.3);
    expect(state.values.valence - before).toBeLessThanOrEqual(0.3 + 1e-9);
  });

  it('接近边界时反应衰减,并且不越过边界', () => {
    const state = initialEmotion();
    state.values.valence = 0.99;
    applyDeltas(state, { valence: 0.3 }, [], 1);
    expect(state.values.valence).toBeLessThanOrEqual(1);
  });

  it('应用后重算心情', () => {
    const state = initialEmotion();
    applyDeltas(state, { empathy: 1 }, [], 1);
    expect(state.mood).toBe('温柔');
  });
});

describe('decayEmotion', () => {
  it('长时间不动会回到基线附近', () => {
    const state = initialEmotion();
    state.values.valence = 1;
    state.updatedAt = Date.now() - 7 * 24 * 3_600_000;
    decayEmotion(state, Date.now());
    expect(Math.abs(state.values.valence - 0.35)).toBeLessThan(0.05);
  });

  it('刚刚更新过就不回落', () => {
    const state = initialEmotion();
    state.values.valence = 0.9;
    expect(decayEmotion(state, state.updatedAt + 10)).toEqual([]);
  });

  it('缩放系数让回落更快', () => {
    const slow = initialEmotion();
    const fast = initialEmotion();
    slow.values.bond = 1;
    fast.values.bond = 1;
    slow.updatedAt = fast.updatedAt = Date.now() - 24 * 3_600_000;
    decayEmotion(slow, Date.now(), 1);
    decayEmotion(fast, Date.now(), 10);
    expect(fast.values.bond).toBeLessThan(slow.values.bond);
  });
});

describe('emotionBlock', () => {
  it('只给离散心情与措辞,不给数值', () => {
    const block = emotionBlock(initialEmotion());
    expect(block).toContain('心情');
    expect(block).not.toMatch(/\d+\.\d+/);
  });
});

describe('missEffect', () => {
  it('宽限内的缺席不算', () => {
    const state = initialEmotion();
    state.updatedAt = Date.now() - 5 * 3_600_000;
    expect(missEffect(state, Date.now())).toEqual([]);
  });

  it('寂寞随缺席向上累积,且有上限', () => {
    const state = initialEmotion();
    state.updatedAt = Date.now() - 48 * 3_600_000;
    const before = state.values.loneliness;
    const reasons = missEffect(state, Date.now());
    expect(state.values.loneliness).toBeGreaterThan(before);
    expect(reasons.join('')).toContain('想念累积');

    const long = initialEmotion();
    long.updatedAt = Date.now() - 30 * 24 * 3_600_000;
    missEffect(long, Date.now());
    // 基线 0.2 + 想念上限 0.5,只逼近不越过。
    expect(long.values.loneliness).toBeLessThanOrEqual(0.7 + 1e-9);
  });

  it('离开约四天后心情翻成寂寞', () => {
    const state = initialEmotion();
    state.updatedAt = Date.now() - 96 * 3_600_000;
    missEffect(state, Date.now());
    expect(state.mood).toBe('寂寞');
  });

  it('重逢的话会安抚寂寞', () => {
    expect(analyzeAffect('我回来啦,好想你').deltas.loneliness ?? 0).toBeLessThan(0);
  });
});

describe('patEffect', () => {
  it('一轮给心情/活力/羁绊增量,并记入当日预算', () => {
    const state = initialEmotion();
    const { deltas, reason } = patEffect(state, Date.now(), 0.25);
    expect(deltas.valence).toBeCloseTo(0.05, 5);
    expect(deltas.arousal).toBeCloseTo(0.03, 5);
    expect(deltas.bond).toBeCloseTo(0.06, 5);
    expect(reason).toContain('被摸了摸头');
    expect(state.patGain).toBeCloseTo(0.05, 5);
  });

  it('当日预算用尽就不再给数值,只报原因', () => {
    const state = initialEmotion();
    const now = Date.now();
    for (let i = 0; i < 5; i++) patEffect(state, now, 0.25);
    const { deltas, reason } = patEffect(state, now, 0.25);
    expect(Object.keys(deltas)).toEqual([]);
    expect(reason).toContain('上限');
  });

  it('余额不足按比例给,不越过预算', () => {
    const state = initialEmotion();
    const now = Date.now();
    patEffect(state, now, 0.12);
    patEffect(state, now, 0.12);
    // 预算 0.12,已得 0.10,只够再给 0.02:按 40% 计,恰好补齐。
    const third = patEffect(state, now, 0.12);
    expect(third.deltas.valence).toBeCloseTo(0.02, 5);
    expect(state.patGain).toBeCloseTo(0.12, 5);
    expect(Object.keys(patEffect(state, now, 0.12).deltas)).toEqual([]);
  });

  it('日期一翻,预算重新开始', () => {
    const state = initialEmotion();
    const now = Date.now();
    for (let i = 0; i < 5; i++) patEffect(state, now, 0.25);
    expect(Object.keys(patEffect(state, now, 0.25).deltas)).toEqual([]);
    const { deltas } = patEffect(state, now + 24 * 3_600_000, 0.25);
    expect(deltas.valence).toBeCloseTo(0.05, 5);
  });

  it('预算写 0 就是摸头只舒服、不给数值', () => {
    const state = initialEmotion();
    const { deltas } = patEffect(state, Date.now(), 0);
    expect(Object.keys(deltas)).toEqual([]);
  });
});
