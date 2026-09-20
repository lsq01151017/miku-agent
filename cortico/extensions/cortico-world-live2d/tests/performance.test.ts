/**
 * 表现引擎:内部状态(基线)、词表与片段(表演)、说话时间线(口型)在通道上合成一路值。
 * 通道是抽象层,模型参数名由包里的 `suggests` 决定,换模型只换映射。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMOTION_BASELINE, baselineChannels } from '../src/baseline.ts';
import { cueExpression } from '../src/directives.ts';
import { loadPack } from '../src/pack.ts';
import { Performance } from '../src/performance.ts';

/** 真实素材包:bots/miku/vtuber-pack。 */
const PACK_DIR = join(import.meta.dirname, '..', '..', '..', 'bots', 'miku', 'vtuber-pack');

describe('素材包读取', () => {
  it('读出三个文件,并把 vocab 提到但没有片段的名字列出来', () => {
    const pack = loadPack(PACK_DIR);
    expect(Object.keys(pack.params).length).toBeGreaterThan(10);
    expect(Object.keys(pack.clips.pulse).length).toBeGreaterThan(10);
    expect(Object.keys(pack.clips.sustain).length).toBeGreaterThan(5);
    expect(Object.keys(pack.clips.gaze).length).toBeGreaterThan(2);
    expect(pack.vocab.entries.length).toBeGreaterThan(20);
    // 真实包有缺口:特效词没有对应片段。静默跳过会让"特效为什么不出"变成谜。
    expect(pack.missingClipIds.length).toBeGreaterThan(0);
    expect(pack.missingClipIds.every((id) => id.startsWith('fx_'))).toBe(true);
  });

  it('片段形状与生命周期一致:pulse 归 pulse,sustain 与 gaze 都是 state', () => {
    const pack = loadPack(PACK_DIR);
    const pulse = pack.vocab.entries.find((e) => e.clipId === 'nod')!;
    expect(pulse.lifecycle).toBe('pulse');
    expect(pack.vocab.entries.find((e) => e.clipId === 'smile')!.lifecycle).toBe('state');
    expect(pack.vocab.entries.find((e) => e.clipId === 'camera')!.lifecycle).toBe('state');
  });

  it('伴随表齐全:片段都在 clips 里,通道值都在 params 里,且带五官通道值', () => {
    const pack = loadPack(PACK_DIR);
    expect(pack.missingStagingClipIds).toEqual([]);
    expect(pack.unknownStagingChannels).toEqual([]);
    // 表情只写开关参数、不改五官,伴随通道值才是"看得出来"的那一半。
    // 指令表里的每个表情都该有:脸红的贴图只有 0.58 不透明度,没有通道值几乎看不见。
    for (const cue of pack.cues) {
      expect(pack.staging[cue.expression]?.channels, cue.expression).toBeDefined();
    }
  });

  it('口头禅不偷表情:句尾的♪是语气不是唱歌,说葱挂葱', () => {
    const pack = loadPack(PACK_DIR);
    // 她的句尾习惯是♪。它曾在 sing 的词表里、又排在 leek 之前,
    // 把「葱」「温柔」这些指令几乎全部偷成了唱歌。
    expect(cueExpression(pack.cues, '今天也要精神满满地过呀♪')).toBeNull();
    expect(cueExpression(pack.cues, '葱——！早上就吃这个吗？配着晨光咬下去，咔嚓。')).toBe('leek');
    expect(cueExpression(pack.cues, '温柔地陪着你')).toBe('lean');
    expect(cueExpression(pack.cues, '那我给你唱一小段吧')).toBe('sing');
  });
});

describe('内部状态驱动的基线', () => {
  it('出厂基线本身是中性偏移:只有关切为 0、其余各维度都不推身体', () => {
    const neutral = baselineChannels(EMOTION_BASELINE);
    expect(neutral.MouthSmile).toBe(0);
    expect(neutral.FaceAngleZ).toBe(0);
    expect(neutral.FaceAngleY).toBe(0);
    expect(neutral.BrowLeftY).toBe(0);
    expect(neutral.MouthOpen).toBe(0); // 口型不由情绪驱动
  });

  it('心情变好 → 笑与眉上扬;变差 → 眉下垂', () => {
    const happy = baselineChannels({ ...EMOTION_BASELINE, valence: 0.8 });
    const low = baselineChannels({ ...EMOTION_BASELINE, valence: -0.1 });
    expect(happy.MouthSmile).toBeGreaterThan(0.5);
    expect(happy.BrowLeftY).toBeGreaterThan(0);
    expect(low.MouthSmile).toBeLessThan(0);
    expect(low.BrowLeftY).toBeLessThan(0);
  });

  it('害羞 → 歪头、鼓腮、避开视线;羁绊深 → 朝前并看回镜头', () => {
    const shy = baselineChannels({ ...EMOTION_BASELINE, shyness: 0.6 });
    expect(shy.FaceAngleZ).toBeGreaterThan(0);
    expect(shy.CheekPuff).toBeGreaterThan(0);
    expect(shy.EyeRightX).toBeGreaterThan(0);
    const close = baselineChannels({ ...EMOTION_BASELINE, bond: 0.9 });
    expect(close.FaceAngleX).toBeLessThan(0);
    expect(close.EyeRightX).toBeLessThan(0);
  });

  it('寂寞 → 低头垂眼', () => {
    const alone = baselineChannels({ ...EMOTION_BASELINE, loneliness: 0.8 });
    expect(alone.FaceAngleY).toBeLessThan(0);
    expect(alone.EyeOpenLeft).toBeLessThan(0);
  });

  it('同一状态算出同一组数字', () => {
    const values = { ...EMOTION_BASELINE, valence: 0.6, shyness: 0.3 };
    expect(baselineChannels(values)).toEqual(baselineChannels({ ...values }));
  });
});

describe('表现引擎', () => {
  let pack: ReturnType<typeof loadPack>;
  beforeEach(() => { pack = loadPack(PACK_DIR); });
  afterEach(() => {});

  it('没有片段时就是基线(待机动作单独算)', () => {
    const performance = new Performance(pack, { idleAmount: 0 });
    performance.setBaseline({ MouthSmile: 0.4, FaceAngleZ: 1 });
    expect(performance.channelsAt(1000)).toMatchObject({ MouthSmile: 0.4, FaceAngleZ: 1 });
  });

  it('词表命中触发片段,并按轨道推进', () => {
    // 待机动作关掉,并且直接 play 片段:这一条量的是轨道本身,不含说话的头部动作。
    const performance = new Performance(pack, { idleAmount: 0 });
    expect(performance.speak('我点点头表示同意', 0)).toEqual(['nod']);
    performance.clear();
    performance.play('nod', 'gesture', 0);
    const at = (ms: number) => performance.channelsAt(ms).FaceAngleY!;
    expect(at(0)).toBe(0);
    expect(at(190)).toBeCloseTo(-26, 1);   // 关键帧
    expect(at(300)).toBeCloseTo(-24, 1);
    expect(at(1400)).toBeCloseTo(0, 1);    // 回到中性
    expect(performance.activeClips(1500)).toHaveLength(0); // 走完就没了
  });

  it('长的词优先:一句里同时出现"点头"和"用力点头"只触发一次', () => {
    const performance = new Performance(pack);
    const triggered = performance.speak('用力点头', 0);
    expect(triggered).toEqual(['nod']);
    // intensity 1.35 来自"用力点头"那条,证明赢的是长词
    const nod = performance.activeClips(0).find((c) => c.clipId === 'nod')!;
    expect(nod.intensity).toBeCloseTo(1.35, 5);
  });

  it('别名归到同一个词', () => {
    const performance = new Performance(pack);
    expect(performance.speak('凑近一点听', 0)).toEqual(['lean_in']);
  });

  it('同类 state 互相替换,不同类可以并存', () => {
    const performance = new Performance(pack);
    performance.speak('微笑', 0);
    // 说一句话自带一个起音动作;它属于 speech 一类,不参与下面几类的替换。
    expect(performance.activeClips(0).map((c) => c.clipId).sort()).toEqual(['smile', 'speech_onset']);
    performance.speak('歪头', 100);
    expect(performance.activeClips(100).map((c) => c.clipId).sort()).toEqual(['smile', 'speech_onset', 'tilt_hold']);
    performance.speak('生气', 200);
    expect(performance.activeClips(200).map((c) => c.clipId).sort()).toEqual(['angry', 'speech_onset', 'tilt_hold']);
  });

  it('视线片段写眼睛与头,并带确定性的扫视', () => {
    // 待机动作关掉:这一条只看片段本身写了什么。
    const performance = new Performance(pack, { idleAmount: 0 });
    expect(performance.speak('看向屏幕', 0)).toEqual(['screen']);
    const still = performance.channelsAt(0);
    expect(still.EyeRightX).toBeCloseTo(-0.5, 6); // screen 的目标值
    expect(still.FaceAngleX).toBeCloseTo(-12, 6); // 头也转过去
    const later = performance.channelsAt(1000);
    expect(later.FaceAngleX).not.toBeCloseTo(still.FaceAngleX!, 6); // 扫视让它动起来
  });

  it('state 保持一段时间后淡出,不会让一个表情永远挂着', () => {
    const performance = new Performance(pack, { stateHoldMs: 1000, stateFadeMs: 1000, idleAmount: 0 });
    // 真实用法:基线一直在,片段是在它之上加减。
    performance.setBaseline(baselineChannels(EMOTION_BASELINE));
    performance.speak('微笑', 0);
    expect(performance.channelsAt(500).MouthSmile).toBeGreaterThan(0.3);
    expect(performance.channelsAt(1500).MouthSmile).toBeGreaterThan(0);
    expect(performance.channelsAt(2500).MouthSmile).toBe(0); // 淡完只剩中性基线
  });

  it('基线改变会带着片段一起走', () => {
    const performance = new Performance(pack);
    performance.setBaseline(baselineChannels({ ...EMOTION_BASELINE, valence: 0.8 }));
    const happy = performance.channelsAt(0).MouthSmile!;
    performance.speak('微笑', 0);
    expect(performance.channelsAt(300).MouthSmile!).toBeGreaterThan(happy);
  });

  it('量程裁剪:叠加不会把通道推出包声明的范围', () => {
    const performance = new Performance(pack);
    performance.setBaseline({ FaceAngleZ: 28 });
    performance.speak('歪头', 0);
    expect(performance.channelsAt(200).FaceAngleZ).toBeLessThanOrEqual(30);
  });

  it('缺片段的词不触发任何东西', () => {
    const performance = new Performance(pack);
    expect(performance.speak('惊讶特效', 0)).toEqual([]);
    // 词表里没有可演的东西,但"她开口了"这件事本身还是有一个起音动作。
    expect(performance.activeClips(0).map((c) => c.clipId)).toEqual(['speech_onset']);
  });

  it('play() 直接触发,不走词表', () => {
    const performance = new Performance(pack);
    expect(performance.play('eyewide_typo', 'gesture', 0)).toBe(false);
    expect(performance.play('eyes_wide', 'gesture', 0)).toBe(true);
    expect(performance.activeClips(0).map((c) => c.clipId)).toEqual(['eyes_wide']);
  });

  it('clear() 之后只剩基线', () => {
    const performance = new Performance(pack, { idleAmount: 0 });
    performance.setBaseline({ MouthSmile: 0.2 });
    performance.speak('微笑', 0);
    performance.clear();
    expect(performance.channelsAt(0)).toMatchObject({ MouthSmile: 0.2 });
  });

  it('表情的伴随通道值叠在基线上,换表情就换掉,表情结束就清掉', () => {
    const performance = new Performance(pack, { idleAmount: 0 });
    performance.setBaseline({ MouthSmile: 0.2 });
    performance.setStaging({ MouthSmile: 0.45, EyeOpenLeft: -0.35 });
    expect(performance.channelsAt(0)).toMatchObject({ MouthSmile: 0.65, EyeOpenLeft: -0.35 });
    // 换挡是替换,不是累加。
    performance.setStaging({ MouthSmile: 0.7 });
    expect(performance.channelsAt(0).MouthSmile).toBe(0.9);
    performance.setStaging(null);
    expect(performance.channelsAt(0)).toMatchObject({ MouthSmile: 0.2 });
  });

  it('待机动作一直在:没有片段时通道也随时间变,同一时刻算出同一组值', () => {
    const performance = new Performance(pack);
    const a = performance.channelsAt(1000);
    const b = performance.channelsAt(2500);
    expect(a.FaceAngleZ).not.toBe(b.FaceAngleZ);
    expect(a.EyeRightX).not.toBe(b.EyeRightX);
    // 纯函数:换个实例、同一时刻,值一样。
    expect(new Performance(pack).channelsAt(1000)).toEqual(a);
  });

  it('待机幅度可以关掉:idleAmount=0 时她是不动的', () => {
    const performance = new Performance(pack, { idleAmount: 0 });
    expect(performance.channelsAt(1000)).toEqual(performance.channelsAt(2500));
    expect(performance.channelsAt(1000).FaceAngleZ ?? 0).toBe(0);
  });

  it('说话自带头部动作:每句起音一次,之后按序轮换重音', () => {
    const performance = new Performance(pack);
    performance.speak('你好', 0);
    expect(performance.activeClips(0).map((c) => c.clipId)).toEqual(['speech_onset']);

    // 说够 14 个字给一个重音;再说够 14 个字换下一个:不连着重复同一个。
    const line = '一二三四五六七八九十十一十二十三十四';
    performance.speak(line, 100);
    const first = performance.activeClips(100).map((c) => c.clipId).filter((id) => id.startsWith('accent_'));
    expect(first).toHaveLength(1);

    performance.speak(line, 200);
    const second = performance.activeClips(200).map((c) => c.clipId).filter((id) => id.startsWith('accent_'));
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
  });

  it('新的一句隔了足够久才重新起音', () => {
    const performance = new Performance(pack, { speechGapMs: 500 });
    performance.speak('你好', 0);
    expect(performance.activeClips(0).map((c) => c.clipId)).toEqual(['speech_onset']);
    // 500ms 之内继续说:还是那一个起音,没有新的。
    performance.speak('再说一句', 200);
    expect(performance.activeClips(200).map((c) => c.clipId)).toEqual(['speech_onset']);
    // 隔够了:下一句重新起音(旧的那一下已经被新的顶掉,数量仍是一个)。
    performance.speak('又一句', 900);
    expect(performance.activeClips(900).map((c) => c.clipId)).toEqual(['speech_onset']);
    expect(performance.activeClips(900)[0]!.startedAtMs).toBe(900);
  });
});

describe('读一份坏包', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('缺三个文件里的任何一个都直接报错,不静默降级', () => {
    dir = mkdtempSync(join(tmpdir(), 'pack-'));
    writeFileSync(join(dir, 'params.json'), '{}', 'utf8');
    expect(() => loadPack(dir)).toThrow();
  });

  it('伴随表的缺口列出来:片段不在 clips 里、通道不在 params 里', () => {
    dir = mkdtempSync(join(tmpdir(), 'pack-'));
    writeFileSync(join(dir, 'params.json'), JSON.stringify({
      MouthSmile: { unit: '[-1,1]', range: [-1, 1], suggests: 'ParamMouthForm', losesIfMissing: '' },
    }), 'utf8');
    writeFileSync(join(dir, 'clips.json'), JSON.stringify({ pulse: {}, sustain: {}, gaze: {} }), 'utf8');
    writeFileSync(join(dir, 'vocab.json'), JSON.stringify({ entries: [], aliases: {} }), 'utf8');
    writeFileSync(join(dir, 'expressions.json'), JSON.stringify({
      staging: { blush: { clipId: '不存在的片段', channels: { 不存在的通道: 1 } } },
    }), 'utf8');
    const pack = loadPack(dir);
    expect(pack.missingStagingClipIds).toEqual(['不存在的片段']);
    expect(pack.unknownStagingChannels).toEqual(['不存在的通道']);
  });
});
