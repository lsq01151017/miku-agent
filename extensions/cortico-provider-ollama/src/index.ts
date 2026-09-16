/**
 * 包入口:默认导出 `ProviderModule`,加载器按 `cortico.kind === 'provider'` 认它。
 *
 * 模块不记模型名与价目:那些在部署的端点条目里。
 *
 * 推理档只给一项:`Ollama` 的兼容层没有推理强度字段,`reasoningEffort` 不参与请求。
 *
 * 上下文窗口不在这里探测:Ollama 不报告运行时生效的窗口,`/api/show` 只给模型的架构上限
 * (`num_ctx` 是否出现在 Modelfile 的 parameters 里取决于该模型)。因此端点条目必须显式填
 * `spec.contextWindow`;不填时 Core 不按窗口裁剪上下文。
 */
import type { ProviderModule } from 'cortico/providers/base.ts';
import { isContextOverflow } from 'cortico/providers/transport/errors.ts';
import { OllamaChatProvider } from './native.ts';

const OLLAMA = {
  id: 'ollama',
  title: 'Ollama',
  defaultBaseUrl: 'http://127.0.0.1:11434/v1',
  baseUrlSuggestions: ['http://127.0.0.1:11434/v1'],
  reasoningTiers: [
    {
      id: 'model',
      label: '模型默认',
      thinking: true,
      note: '是否推理由模型本身决定;Ollama 不提供强度开关。',
    },
  ],
  serviceTiers: [],
  contextOverflow: isContextOverflow,
  create(name, entry, host) {
    return {
      compatibilityKey: () => [name],
      client: new OllamaChatProvider({
        baseUrl: entry.baseUrl,
        log: host.log,
        media: { enabled: () => entry.multimodal === true, read: host.readBlob },
      }),
      /** `GET <baseUrl>/models`:本机有哪些模型。 */
      async listModels() {
        const url = `${entry.baseUrl.replace(/\/+$/, '')}/models`;
        const response = await fetch(url);
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

export default OLLAMA;
export { OLLAMA };
