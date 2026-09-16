/**
 * 抽象通道 → 本模型参数的解析。
 *
 * 包里的 `suggests` 只是**建议**:它按常见命名写的(`ParamAngleZ`),而真实模型常有自己的叫法。
 * 这份模型 141 个参数里有 `Paramguzui`(鼓嘴)这种拼音命名,包里建议的 `ParamCheekPuff`
 * 根本不存在——那一路表演会静默失效。所以解析要做三件事:
 *
 *   1. 从 `suggests` 开头取参数名(取不到就是"这条通道本就不接",例如包自己说"与右眼共用");
 *   2. 允许部署按模型逐通道覆盖(`paramMap`),覆盖优先;
 *   3. 把没有落点的通道**报出来**,带上 `losesIfMissing`,让操作者知道丢了什么。
 */
import type { Pack } from './pack.ts';

export interface ResolvedChannel {
  /** 本模型上要写的参数名;null = 这条通道没有落点。 */
  param: string | null;
  range: readonly [number, number] | null;
  /** 包对"缺了会丢什么"的说明,原样带出来。 */
  losesIfMissing: string;
}

export type ResolvedChannels = Record<string, ResolvedChannel>;

/** `suggests` 开头那段 Param* 才是参数名,其余是给人的说明。 */
function paramFromSuggests(suggests: string): string | null {
  const hit = /^(Param[A-Za-z0-9_]+)/.exec(String(suggests ?? ''));
  return hit ? hit[1]! : null;
}

/**
 * `overrides` 是部署对这份模型的修正:值是参数名,空串表示明确不接。
 * 覆盖表里出现的通道一律以它为最终答案,不再看 `suggests`。
 */
export function resolveChannels(pack: Pack, overrides: Readonly<Record<string, string>> = {}): ResolvedChannels {
  const out: ResolvedChannels = {};
  for (const [channel, spec] of Object.entries(pack.params)) {
    const override = overrides[channel];
    const param = override !== undefined ? (override === '' ? null : override) : paramFromSuggests(spec.suggests);
    out[channel] = { param, range: spec.range, losesIfMissing: spec.losesIfMissing };
  }
  // 覆盖表里多出来的通道也带上:模型有、包没抽象的通道,以后可能要用。
  for (const [channel, param] of Object.entries(overrides)) {
    if (out[channel]) continue;
    out[channel] = { param: param === '' ? null : param, range: null, losesIfMissing: '' };
  }
  return out;
}

/** 没有落点的通道,供启动时告警。 */
export function unmappedChannels(channels: ResolvedChannels): Array<{ channel: string; losesIfMissing: string }> {
  return Object.entries(channels)
    .filter(([, value]) => value.param === null)
    .map(([channel, value]) => ({ channel, losesIfMissing: value.losesIfMissing }));
}

/** `通道=参数名` 的配置串 → 覆盖表;逗号或换行分隔,没有等号的项按"明确不接"算。 */
export function parseParamMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of String(text ?? '').split(/[,\n;]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const at = entry.indexOf('=');
    if (at === -1) out[entry] = '';
    else out[entry.slice(0, at).trim()] = entry.slice(at + 1).trim();
  }
  return out;
}

/**
 * 拿这份模型真实的参数表核对:`suggests` 解析得出的名字,模型未必有。
 *
 * 这是 `suggests` 与现实的差距最要紧的一处——解析成功、参数名也合法,但模型上没有它,
 * 于是那一路表演静默失效。`losesIfMissing` 说的正是这一刻丢了什么。
 */
export function verifyAgainstModel(
  channels: ResolvedChannels,
  modelParams: ReadonlySet<string>,
): Array<{ channel: string; param: string; losesIfMissing: string }> {
  return Object.entries(channels)
    .filter(([, value]) => value.param !== null && !modelParams.has(value.param))
    .map(([channel, value]) => ({ channel, param: value.param!, losesIfMissing: value.losesIfMissing }));
}
