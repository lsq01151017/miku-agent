/**
 * 心情 → 模型自带表情的这张表。
 * 表里没有的心情返回 null(交给连续的基线表达),模型没有的表情也不挂。
 */
import { describe, expect, it } from 'vitest';
import { expressionForMood, missingExpressions, MOOD_EXPRESSIONS } from '../src/expressions.ts';

/** 这份模型实际有的八个;测试里按需裁剪。 */
const ALL = new Set(['blush', 'lean', 'swirl', 'sing', 'heart', 'leek', 'chibi', 'watermark']);

describe('MOOD_EXPRESSIONS', () => {
  it('只挂情绪类的表情,标记与水印不在表里', () => {
    expect(Object.values(MOOD_EXPRESSIONS).sort()).toEqual(['blush', 'heart', 'lean', 'sing']);
    // 水印是作者的,程序不该动它;葱与 QQ 人是标记不是情绪。
    expect(Object.values(MOOD_EXPRESSIONS)).not.toContain('watermark');
    expect(Object.values(MOOD_EXPRESSIONS)).not.toContain('leek');
    expect(Object.values(MOOD_EXPRESSIONS)).not.toContain('chibi');
  });

  it('四个心情各挂一个表情', () => {
    expect(expressionForMood('害羞', ALL)).toBe('blush');
    expect(expressionForMood('温柔', ALL)).toBe('lean');
    expect(expressionForMood('元气', ALL)).toBe('sing');
    expect(expressionForMood('开心', ALL)).toBe('heart');
  });

  it('表里没有的心情交给基线,不硬塞表情', () => {
    for (const mood of ['寂寞', '低落', '认真', '平静', '闹别扭']) {
      expect(expressionForMood(mood, ALL)).toBeNull();
    }
    expect(expressionForMood(null, ALL)).toBeNull();
  });

  it('模型没有那个表情时不挂,不报错', () => {
    const partial = new Set(['sing']);
    expect(expressionForMood('害羞', partial)).toBeNull();
    expect(expressionForMood('元气', partial)).toBe('sing');
    expect(missingExpressions(partial)).toEqual(['blush', 'heart', 'lean']);
  });

  it('模型表情齐时没有缺失项', () => {
    expect(missingExpressions(ALL)).toEqual([]);
  });
});
