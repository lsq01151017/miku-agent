/**
 * 通道解析:包的建议 vs 本模型的真实参数名。
 *
 * 用真实素材包与真实模型参数表跑——这份模型 141 个参数里有 `Paramguzui` 这种拼音命名,
 * 包里建议的 `ParamCheekPuff` 并不存在。这类不匹配必须能被看见(报出来),而不是静默失效。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveChannels, parseParamMap, unmappedChannels, verifyAgainstModel } from '../src/channels.ts';
import { loadPack } from '../src/pack.ts';

const PACK_DIR = join(import.meta.dirname, '..', '..', '..', 'bots', 'miku', 'vtuber-pack');
const MODEL_DIR = 'D:\\二面\\my-agent\\live2d\\models\\miku';

const pack = loadPack(PACK_DIR);

/** 这份模型真实拥有的参数名;模型文件不在时跳过那条断言(它属于部署资产)。 */
function modelParams(): Set<string> | null {
  try {
    const cdi = JSON.parse(readFileSync(join(MODEL_DIR, 'miku.cdi3.json'), 'utf8')) as {
      Parameters?: Array<{ Id: string }>;
    };
    return new Set((cdi.Parameters ?? []).map((p) => p.Id));
  } catch {
    return null;
  }
}

describe('resolveChannels', () => {
  it('从 suggests 开头取参数名', () => {
    const channels = resolveChannels(pack);
    expect(channels.FaceAngleZ?.param).toBe('ParamAngleZ');
    expect(channels.MouthOpen?.param).toBe('ParamMouthOpenY');
    expect(channels.MouthSmile?.param).toBe('ParamMouthForm');
    expect(channels.EyeOpenLeft?.param).toBe('ParamEyeLOpen');
    expect(channels.BrowRightY?.param).toBe('ParamBrowRY');
  });

  it('包里说明"与右眼共用一个参数,可不接"的通道没有落点', () => {
    const channels = resolveChannels(pack);
    expect(channels.EyeLeftX?.param).toBeNull();
    expect(channels.EyeLeftY?.param).toBeNull();
  });

  it('量程与"缺了会丢什么"原样带出来', () => {
    const channels = resolveChannels(pack);
    expect(channels.FaceAngleZ?.range).toEqual([-30, 30]);
    expect(channels.MouthOpen?.losesIfMissing).toContain('口型');
  });

  it('部署的修正优先,空串表示明确不接', () => {
    const channels = resolveChannels(pack, { CheekPuff: 'Paramguzui', FaceAngleZ: '' });
    expect(channels.CheekPuff?.param).toBe('Paramguzui');
    expect(channels.FaceAngleZ?.param).toBeNull();
  });

  it('修正表里多出来的通道也带上,量程为空', () => {
    const channels = resolveChannels(pack, { BodyAngleZ: 'ParamBodyAngleZ' });
    expect(channels.BodyAngleZ?.param).toBe('ParamBodyAngleZ');
    expect(channels.BodyAngleZ?.range).toBeNull();
  });
});

describe('与真实模型对照', () => {
  it('解析出的参数名基本都在这份模型的参数表里', () => {
    const params = modelParams();
    if (!params) return; // 模型不在(它不进版本库)
    const channels = resolveChannels(pack);
    const missing = Object.entries(channels)
      .filter(([, value]) => value.param !== null && !params.has(value.param))
      .map(([channel, value]) => `${channel} → ${value.param}`);
    // 唯一对不上的是腮:包里建议 ParamCheekPuff,这份模型是拼音命名。
    expect(missing).toEqual(['CheekPuff → ParamCheekPuff']);
  });

  it('对不上的那条通道会被报出来,并带上会丢什么', () => {
    const params = modelParams();
    if (!params) return;
    const channels = resolveChannels(pack);
    const notInModel = verifyAgainstModel(channels, params);
    expect(notInModel.map((entry) => entry.channel)).toEqual(['CheekPuff']);
    expect(notInModel[0]!.param).toBe('ParamCheekPuff');
    expect(notInModel[0]!.losesIfMissing).toContain('脸颊');
    // 改成这款模型的拼音参数后就不再报。
    expect(verifyAgainstModel(resolveChannels(pack, { CheekPuff: 'Paramguzui' }), params)).toEqual([]);
  });

  it('包自己说不接的通道在"没有落点"名单里,不在"模型没有"名单里', () => {
    const channels = resolveChannels(pack);
    expect(unmappedChannels(channels).map((entry) => entry.channel).sort()).toEqual(['EyeLeftX', 'EyeLeftY']);
  });
});

describe('paramMap 的解析', () => {
  it('`通道=参数名`,逗号或换行分隔;没有等号按明确不接算;空白去掉', () => {
    expect(parseParamMap('CheekPuff = Paramguzui, FaceAngleZ=\nBodyAngleZ'))
      .toEqual({ CheekPuff: 'Paramguzui', FaceAngleZ: '', BodyAngleZ: '' });
    expect(parseParamMap('')).toEqual({});
  });
});
