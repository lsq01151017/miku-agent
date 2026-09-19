/**
 * 包入口:默认导出 `ProviderModule`,加载器按 `cortico.kind === 'provider'` 认它。
 *
 * 模块不记模型名与价目:那些在部署的端点条目里。
 *
 * 与 `openai-responses-compat` 的分工是路径而不是方言:`/chat/completions` 与 `/responses`
 * 是两套请求体,同一个端点通常只实现一套。只提供 Chat 的第三方兼容服务用这个模块。
 *
 * 上下文窗口不在这里探测:`GET /models` 只给 id,不给窗口。端点条目要显式填
 * `spec.contextWindow`;不填时 Core 不按窗口裁剪上下文。
 */
import type { ProviderModule } from 'cortico/providers/base.ts';
import { isContextOverflow } from 'cortico/providers/transport/errors.ts';
import { ChatProvider } from './native.ts';

const CHAT = {
  id: 'chat',
  title: 'OpenAI Chat Completions',
  defaultBaseUrl: 'https://api.openai.com/v1',
  baseUrlSuggestions: [
    'https://api.openai.com/v1',
    'https://openrouter.ai/api/v1',
    'https://api.deepseek.com/v1',
  ],
  reasoningTiers: [
    {
      id: 'model',
      label: '模型默认',
      thinking: true,
      note: '是否推理由模型本身决定;Chat 方言没有强度开关。',
    },
  ],
  effortSuggestions: ['none', 'low', 'medium', 'high'],
  serviceTiers: [],
  contextOverflow: isContextOverflow,
  create(name, entry, host) {
    const apiKey = entry.secret ? host.secret(entry.secret) : undefined;
    const options = (entry.options ?? {}) as { extraHeaders?: Record<string, string> };
    return {
      compatibilityKey: () => [name],
      client: new ChatProvider({
        baseUrl: entry.baseUrl,
        apiKey,
        extraHeaders: options.extraHeaders,
        log: host.log,
        media: { enabled: () => entry.multimodal === true, read: host.readBlob },
      }),
      /** `GET <baseUrl>/models`:这个端点提供哪些模型。 */
      async listModels() {
        const url = `${entry.baseUrl.replace(/\/+$/, '')}/models`;
        const response = await fetch(url, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        });
        if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
        const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
        return (body.data ?? [])
          .map((model) => model.id)
          .filter((id): id is string => typeof id === 'string')
          .map((id) => ({ id }));
      },
    };
  },
} satisfies ProviderModule;

export default CHAT;
export { CHAT };
