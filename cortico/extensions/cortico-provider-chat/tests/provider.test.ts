/**
 * 模块契约与鉴权头。不发网络请求:端点的行为不属于单元测试。
 */
import { describe, expect, it } from 'vitest';
import manifest from '../package.json';
import chat from '../src/index.ts';
import { ChatProvider } from '../src/native.ts';
import { nullLogger } from 'cortico/core/util.ts';
import type { ProviderHost } from 'cortico/providers/base.ts';

function fakeHost(secret = ''): ProviderHost {
  return {
    stateDir: '',
    secret: () => secret,
    readBlob: () => null,
    keepThinking: () => false,
    log: nullLogger(),
  };
}

/** 把受保护的成员取出来断言,不改它们的可见性。 */
type Headers = { headers(): Record<string, string> };
const headersOf = (client: unknown): Record<string, string> => (client as Headers).headers();

describe('ProviderModule 契约', () => {
  it('清单声明 provider,且模块 id 与包名末段一致', () => {
    expect(manifest.cortico.kind).toBe('provider');
    expect(manifest.name).toBe(`cortico-provider-${chat.id}`);
  });

  it('推理档非空,因而 effort 只接受表内值', () => {
    expect(chat.reasoningTiers.length).toBeGreaterThan(0);
  });

  it('这种方言没有服务档', () => {
    expect(chat.serviceTiers).toEqual([]);
  });

  it('create() 给出客户端,模型列表取 baseUrl 下的 /models 并带鉴权', async () => {
    const requested: Array<{ url: string; auth?: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      requested.push({ url: String(url), auth });
      return new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), { status: 200 });
    }) as typeof fetch;

    try {
      const instance = chat.create(
        'third-party',
        { kind: 'chat', baseUrl: 'https://example.test/v1/', secret: 'MY_KEY' },
        fakeHost('sk-test'),
      );
      expect(instance.client).toBeDefined();
      expect(await instance.listModels?.()).toEqual([{ id: 'a' }, { id: 'b' }]);
      expect(requested).toEqual([{ url: 'https://example.test/v1/models', auth: 'Bearer sk-test' }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('鉴权头', () => {
  it('有密钥时带 Bearer,没有时不带 Authorization', () => {
    const withKey = new ChatProvider({ baseUrl: 'https://example.test/v1', apiKey: 'sk-x' });
    expect(headersOf(withKey).Authorization).toBe('Bearer sk-x');

    const withoutKey = new ChatProvider({ baseUrl: 'https://example.test/v1' });
    expect(headersOf(withoutKey).Authorization).toBeUndefined();
    expect(headersOf(withoutKey)['Content-Type']).toBe('application/json');
  });

  it('端点条目给的额外头原样带上', () => {
    const client = new ChatProvider({
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-x',
      extraHeaders: { 'X-Trace': 'on' },
    });
    expect(headersOf(client)['X-Trace']).toBe('on');
  });
});
