/**
 * Ollama 兼容端点的 Chat 客户端。
 *
 * 请求体是 OpenAI Chat Completions 形状。Ollama 忽略它不认识的键,所以 `num_ctx`、`keep_alive`
 * 这类原生参数不从这里发;采样参数只在端点条目给了值时出现。
 *
 * 流里的思维链字段名与 transport 读的不同:Ollama 用 `reasoning`,Chat 方言用 `reasoning_content`。
 * `normalizeReasoning` 在装配与解析之前改名。
 *
 * 另外补一层文本工具协议:模板没有 `.Tools` 分支的模型不产出结构化 `tool_calls`,只把调用写成
 * 正文。见 `tool-protocol.ts`。
 */
import type { Logger, ModelSpec, ToolSchema } from 'cortico/core/types.ts';
import type { TokenMeters } from 'cortico/core/generation.ts';
import type { Request, Response, StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { ResponseProtocolError } from 'cortico/protocol/open-responses/stream.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { OpenAIHttpClient } from 'cortico/providers/transport/chat.ts';
import {
  ChatResponseAssembly,
  type ResponseAssembly,
} from 'cortico/providers/transport/response-assembly.ts';
import {
  mapTools,
  renderMessagesWithMedia,
  type CompatMediaOptions,
} from 'cortico/providers/transport/history.ts';
import type { NativeChatMessage } from 'cortico/providers/transport/native-types.ts';
import { ToolProtocolScanner, type ToolProtocolStep } from './tool-protocol.ts';

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

/** 装配与扫描器之间传递的最小切片;其余字段原样透传。 */
type AssemblyChunk = {
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    delta?: Record<string, unknown> | null;
  }>;
};
type AssemblyChoice = NonNullable<AssemblyChunk['choices']>[number];
type ParseResult = { response: Response; meters: TokenMeters; serviceTier: string | null };

/**
 * Chat 流的装配。除了归一思维链字段,还把正文增量交给扫描器:围栏里的调用转成 `tool_calls`,
 * 其余正文照常下发。
 */
class OllamaChatAssembly extends ChatResponseAssembly {
  private readonly scanner = new ToolProtocolScanner();
  private nativeCalls = false;
  private callIndex = 0;

  override feed(payload: unknown, emit: (event: StreamEvent) => void): void {
    const chunk = normalizeReasoning(payload) as AssemblyChunk;
    const choice: AssemblyChoice | undefined = chunk?.choices?.[0];
    const delta = choice?.delta ?? undefined;
    // 结构化调用一旦出现,正文里的围栏就只是正文。
    if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0 && !this.nativeCalls) {
      this.nativeCalls = true;
      this.drain(this.scanner.disable(), emit);
    }
    const content = typeof delta?.content === 'string' ? (delta.content as string) : '';
    if (!content || this.nativeCalls) {
      super.feed(chunk, emit);
      return;
    }
    // 正文先扣下,由扫描器决定它是发言还是调用。
    const rest: Record<string, unknown> = { ...delta };
    delete rest.content;
    super.feed({ ...chunk, choices: [{ ...choice, delta: rest }] }, emit);
    this.drain(this.scanner.push(content), emit);
  }

  override finish(emit: (event: StreamEvent) => void): Response {
    this.drain(this.scanner.flush(), emit);
    return super.finish(emit);
  }

  /** 扫描器给出的段按原顺序回填成正文增量或工具调用。 */
  private drain(steps: ToolProtocolStep[], emit: (event: StreamEvent) => void): void {
    for (const step of steps) {
      if (step.kind === 'text') {
        super.feed({ choices: [{ index: 0, delta: { content: step.text } }] }, emit);
        continue;
      }
      super.feed(
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: this.callIndex++,
                    id: `call_${crypto.randomUUID()}`,
                    function: { name: step.name, arguments: step.arguments },
                  },
                ],
              },
            },
          ],
        },
        emit,
      );
    }
  }
}

/**
 * 非流式解析。与 transport 的 `parseChatResponse` 同形,区别只在本模块的装配子类;
 * 复用它就得再走一次基类装配,扫描器拿不到正文。
 */
function parseOllamaResponse(raw: unknown, request: Request): ParseResult {
  const data = raw as {
    id?: string;
    model?: string;
    usage?: Record<string, unknown>;
    choices?: Array<{ index?: number; finish_reason?: string | null; message?: Record<string, unknown> }>;
  };
  const choice = data.choices?.[0];
  if (!choice?.message) throw new ResponseProtocolError('Native Chat response lacks choices[0].message');
  const calls = choice.message.tool_calls;
  const assembler = new OllamaChatAssembly(request);
  assembler.feed(
    {
      ...data,
      choices: [
        {
          index: 0,
          delta: {
            ...choice.message,
            ...(Array.isArray(calls) ? { tool_calls: calls.map((call, index) => ({ ...(call as object), index })) } : {}),
          },
          finish_reason: choice.finish_reason,
        },
      ],
    },
    () => {},
  );
  const response = assembler.finish(() => {});
  return { response, meters: assembler.meters(), serviceTier: assembler.serviceTier() };
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

  protected override parseResponse(raw: unknown, request: Request): ParseResult {
    return parseOllamaResponse(raw, request);
  }

  /** 本机端点不带凭据。 */
  protected headers(): Record<string, string> {
    return { 'Content-Type': 'application/json' };
  }
}
