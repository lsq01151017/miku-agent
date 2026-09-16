/**
 * 模块契约与思维链改名。不发网络请求:端点的行为不属于单元测试。
 */
import { describe, expect, it } from 'vitest';
import manifest from '../package.json';
import ollama from '../src/index.ts';
import { normalizeReasoning } from '../src/native.ts';
import { nullLogger } from 'cortico/core/util.ts';
import type { ProviderHost } from 'cortico/providers/base.ts';

function fakeHost(): ProviderHost {
  return {
    stateDir: '',
    secret: () => '',
    readBlob: () => null,
    keepThinking: () => false,
    log: nullLogger(),
  };
}

describe('ProviderModule 契约', () => {
  it('清单声明 provider,且模块 id 与包名末段一致', () => {
    expect(manifest.cortico.kind).toBe('provider');
    expect(manifest.name).toBe(`cortico-provider-${ollama.id}`);
  });

  it('推理档非空,因而 effort 只接受表内值', () => {
    expect(ollama.reasoningTiers.length).toBeGreaterThan(0);
  });

  it('这种方言没有服务档', () => {
    expect(ollama.serviceTiers).toEqual([]);
  });

  it('create() 给出客户端,模型列表取 baseUrl 下的 /models', async () => {
    const requested: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      requested.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), { status: 200 });
    }) as typeof fetch;

    try {
      const instance = ollama.create(
        'local',
        { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1/' },
        fakeHost(),
      );
      expect(instance.client).toBeDefined();
      expect(await instance.listModels?.()).toEqual([{ id: 'a' }, { id: 'b' }]);
      expect(requested).toEqual(['http://127.0.0.1:11434/v1/models']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('normalizeReasoning', () => {
  it('流式:把 delta 里的 reasoning 改名为 reasoning_content', () => {
    expect(normalizeReasoning({ choices: [{ delta: { reasoning: '想一想', content: '好' } }] }))
      .toEqual({ choices: [{ delta: { reasoning_content: '想一想', content: '好' } }] });
  });

  it('非流式:改 message 里的同名字段', () => {
    expect(normalizeReasoning({ choices: [{ message: { role: 'assistant', reasoning: '想一想' } }] }))
      .toEqual({ choices: [{ message: { role: 'assistant', reasoning_content: '想一想' } }] });
  });

  it('已有 reasoning_content 时原样返回同一个对象', () => {
    const payload = { choices: [{ delta: { reasoning_content: 'x' } }] };
    expect(normalizeReasoning(payload)).toBe(payload);
  });

  it('没有 choices 的载荷原样返回', () => {
    expect(normalizeReasoning({ usage: {} })).toEqual({ usage: {} });
    expect(normalizeReasoning(null)).toBeNull();
  });
});
