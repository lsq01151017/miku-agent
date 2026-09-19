/**
 * OpenAI Chat Completions 端点的客户端。
 *
 * 请求体是标准 Chat 形状;装配与解析直接用 `transport` 的默认实现——这类端点自己产出结构化
 * `tool_calls`,不需要文本工具协议兜底(那是 `cortico-provider-ollama` 为模板缺 `.Tools` 分支
 * 的模型补的)。
 *
 * 与 `openai-responses-compat` 的分工:那个走 `/responses`,这个走 `/chat/completions`。
 * 只提供 Chat 的端点(多数第三方兼容服务)只能用这一个。
 */
import type { Logger, ModelSpec, ToolSchema } from 'cortico/core/types.ts';
import type { TokenMeters } from 'cortico/core/generation.ts';
import type { Request, Response } from 'cortico/protocol/open-responses/index.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { OpenAIHttpClient } from 'cortico/providers/transport/chat.ts';
import { parseChatResponse } from 'cortico/providers/transport/response-assembly.ts';
import {
  mapTools,
  renderMessagesWithMedia,
  type CompatMediaOptions,
} from 'cortico/providers/transport/history.ts';
import type { NativeChatMessage } from 'cortico/providers/transport/native-types.ts';

type ParseResult = { response: Response; meters: TokenMeters; serviceTier: string | null };

export class ChatProvider extends OpenAIHttpClient {
  private readonly media?: CompatMediaOptions;
  private readonly apiKey?: string;
  private readonly extraHeaders?: Record<string, string>;

  constructor(opts: {
    baseUrl: string;
    apiKey?: string;
    extraHeaders?: Record<string, string>;
    log?: Logger;
    media?: CompatMediaOptions;
  }) {
    super(opts.baseUrl, opts.log ?? nullLogger());
    this.apiKey = opts.apiKey;
    this.extraHeaders = opts.extraHeaders;
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

  protected parseResponse(raw: unknown, request: Request): ParseResult {
    return parseChatResponse(raw, request);
  }

  protected headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...this.extraHeaders,
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }
}
