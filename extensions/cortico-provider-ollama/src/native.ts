/**
 * Ollama 兼容端点的 Chat 客户端。
 *
 * 请求体是 OpenAI Chat Completions 形状。Ollama 忽略它不认识的键,所以 `num_ctx`、`keep_alive`
 * 这类原生参数不从这里发;采样参数只在端点条目给了值时出现。
 *
 * 流里的思维链字段名与 transport 读的不同:Ollama 用 `reasoning`,Chat 方言用 `reasoning_content`。
 * `normalizeReasoning` 在装配与解析之前改名。
 */
import type { Logger, ModelSpec, ToolSchema } from 'cortico/core/types.ts';
import type { Request, StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { OpenAIHttpClient } from 'cortico/providers/transport/chat.ts';
import {
  ChatResponseAssembly,
  parseChatResponse,
  type ResponseAssembly,
} from 'cortico/providers/transport/response-assembly.ts';
import {
  mapTools,
  renderMessagesWithMedia,
  type CompatMediaOptions,
} from 'cortico/providers/transport/history.ts';
import type { NativeChatMessage } from 'cortico/providers/transport/native-types.ts';

type ReasoningCarrier = { reasoning?: unknown; reasoning_content?: unknown };
type ChatChoice = { delta?: ReasoningCarrier; message?: ReasoningCarrier };
type ChatPayload = { choices?: ChatChoice[] };

/**
 * 把 `reasoning` 改名成 `reasoning_content`。
 *
 * 流式在 `choices[].delta`,非流式在 `choices[].message`;已有 `reasoning_content` 的载荷原样返回。
 */
export function normalizeReasoning(payload: unknown): unknown {
  const chunk = payload as ChatPayload | null;
  const choices = chunk?.choices;
  if (!Array.isArray(choices)) return payload;

  let touched = false;
  const renamed = choices.map((choice) => {
    const carrier = choice.delta ?? choice.message;
    if (!carrier || typeof carrier.reasoning !== 'string' || carrier.reasoning_content !== undefined) {
      return choice;
    }
    const { reasoning, ...rest } = carrier;
    touched = true;
    return choice.delta
      ? { ...choice, delta: { ...rest, reasoning_content: reasoning } }
      : { ...choice, message: { ...rest, reasoning_content: reasoning } };
  });

  return touched ? { ...chunk, choices: renamed } : payload;
}

/** Chat 流的装配;唯一改动是在交给基类之前归一思维链字段。 */
class OllamaChatAssembly extends ChatResponseAssembly {
  override feed(payload: unknown, emit: (event: StreamEvent) => void): void {
    super.feed(normalizeReasoning(payload), emit);
  }
}

export class OllamaChatProvider extends OpenAIHttpClient {
  private readonly media?: CompatMediaOptions;

  constructor(opts: { baseUrl: string; log?: Logger; media?: CompatMediaOptions }) {
    super(opts.baseUrl, opts.log ?? nullLogger());
    this.media = opts.media;
  }

  /** 请求体:模型、消息、工具;采样参数只在端点条目给了时出现。 */
  protected buildBody(
    spec: ModelSpec,
    messages: NativeChatMessage[],
    tools?: ToolSchema[],
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: spec.model,
      messages: renderMessagesWithMedia(messages, this.media),
    };
    if (spec.temperature !== undefined) body.temperature = spec.temperature;
    if (spec.maxTokens !== undefined) body.max_tokens = spec.maxTokens;
    const mapped = mapTools(tools);
    if (mapped) body.tools = mapped;
    return body;
  }

  protected override responseAssembly(request: Request): ResponseAssembly {
    return new OllamaChatAssembly(request);
  }

  protected override parseResponse(raw: unknown, request: Request): ReturnType<typeof parseChatResponse> {
    return parseChatResponse(normalizeReasoning(raw), request);
  }

  /** 本机端点不带凭据。 */
  protected headers(): Record<string, string> {
    return { 'Content-Type': 'application/json' };
  }
}
