/**
 * `directives.ts`:措辞 → 表情指令表的读取与匹配。
 * 表是数据,匹配是纯函数;这里只验这两件事,不碰模型与网络。
 */
import { describe, expect, it } from 'vitest';
import {
  cueExpression,
  missingCueExpressions,
  parseCues,
} from '../src/directives.ts';

describe('parseCues', () => {
  it('形状不对的条目丢掉,字长的排前面', () => {
    const cues = parseCues({
      cues: [
        { expression: 'blush', words: ['呜', '不好意思'] },
        { expression: '', words: ['空的'] },
        { expression: 'heart', words: [] },
        { words: ['没有表情名'] },
        { expression: 'sing', words: ['唱歌', 42, ''] },
      ],
    });
    expect(cues.map((cue) => cue.expression)).toEqual(['blush', 'sing']);
    expect(cues[0]!.words).toEqual(['不好意思', '呜']);
    expect(cues[1]!.words).toEqual(['唱歌']);
  });

  it('没有 cues 字段、或根本不是对象时给空表', () => {
    expect(parseCues(null)).toEqual([]);
    expect(parseCues({})).toEqual([]);
    expect(parseCues({ cues: 'blush' })).toEqual([]);
  });
});

describe('cueExpression', () => {
  const cues = parseCues({
    cues: [
      { expression: 'blush', words: ['害羞', '呜'] },
      { expression: 'heart', words: ['喜欢你'] },
    ],
  });

  it('命中就给表情名,没命中给 null', () => {
    expect(cueExpression(cues, '我有点害羞啦')).toBe('blush');
    expect(cueExpression(cues, '今天几号')).toBe(null);
    expect(cueExpression(cues, '')).toBe(null);
  });

  it('表的顺序就是优先级', () => {
    expect(cueExpression(cues, '害羞地喜欢你')).toBe('blush');
  });

  it('长词先匹配:同一条指令里长词不会被短词抢走', () => {
    const long = parseCues({ cues: [{ expression: 'sing', words: ['唱一小段', '唱'] }] });
    expect(cueExpression(long, '我给你唱一小段')).toBe('sing');
  });
});

describe('missingCueExpressions', () => {
  it('表里提到、模型没有的表情名列出来', () => {
    const cues = parseCues({
      cues: [{ expression: 'blush', words: ['害羞'] }, { expression: 'nope', words: ['没有的'] }],
    });
    expect(missingCueExpressions(cues, new Set(['blush']))).toEqual(['nope']);
    expect(missingCueExpressions(cues, new Set(['blush', 'nope']))).toEqual([]);
  });
});
