/**
 * 语音分段器(`src/voice.ts`):增量进、句界出。切法必须确定——同一串增量永远切出同一段。
 */
import { describe, expect, it } from 'vitest';
import { VoiceSegmenter } from '../src/voice.ts';

const cut = (deltas: readonly string[], opts = { minChars: 8, maxChars: 120 }): string[] => {
  const segmenter = new VoiceSegmenter(opts);
  return deltas.flatMap((delta) => segmenter.push(delta));
};

describe('语音分段器', () => {
  it('句界出现在增量中间也切得出来:词被拆在两个增量里不影响', () => {
    const out = cut(['今日はいい天気で', 'すね。外に', '出ましょう！']);
    expect(out).toEqual(['今日はいい天気ですね。', '外に出ましょう！']);
  });

  it('短句与后面的句子合并,不单独占一次合成', () => {
    const out = cut(['うん。', 'わかりました。']);
    // 「うん。」只有 3 字,攒到「わかりました。」一起切(整段 12 字)。
    expect(out).toEqual(['うん。わかりました。']);
  });

  it('一次增量里的多句取最后句界合成一段切出,没说完的留着', () => {
    const out = cut(['一句短话。这是第二句话。这是第三句话,还没说完']);
    expect(out).toEqual(['一句短话。这是第二句话。']);
  });

  it('攒到上限就切:从上限回溯找句界,一段一段吐到只剩无句界的尾巴', () => {
    const long = 'あ'.repeat(50) + '。' + 'い'.repeat(80) + '。' + 'う'.repeat(30);
    const out = cut([long], { minChars: 8, maxChars: 100 });
    expect(out).toEqual(['あ'.repeat(50) + '。', 'い'.repeat(80) + '。']);
  });

  it('上限内没有句界才硬切', () => {
    const out = cut(['あ'.repeat(150)], { minChars: 8, maxChars: 100 });
    expect(out).toEqual(['あ'.repeat(100)]);
  });

  it('flush 交出尾巴,交完再 flush 是 null', () => {
    const segmenter = new VoiceSegmenter({ minChars: 8, maxChars: 120 });
    segmenter.push('这是没说完的半句');
    expect(segmenter.flush()).toBe('这是没说完的半句');
    expect(segmenter.flush()).toBeNull();
  });

  it('clear 整个丢弃:打断后攒的半句不再吐出', () => {
    const segmenter = new VoiceSegmenter({ minChars: 8, maxChars: 120 });
    segmenter.push('被打断前攒下的半句');
    segmenter.clear();
    expect(segmenter.push('新的一句话说完。')).toEqual(['新的一句话说完。']);
    expect(segmenter.flush()).toBeNull();
  });

  it('同一串增量永远切出同一段(确定性)', () => {
    const deltas = ['你好呀。', '今天', '想听我唱歌吗?', '好想唱给你听……'];
    expect(cut(deltas)).toEqual(cut(deltas));
    expect(cut(deltas).length).toBe(2);
  });
});
