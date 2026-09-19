/**
 * 文本工具协议:围栏 ` ```cortico ` 里的一段 JSON 是一次工具调用。
 *
 * 这是**具名回退**。模板里没有 `.Tools` 分支的模型无法产出结构化 `tool_calls`——它只会把调用
 * 写成正文——而 Ollama 的兼容层不做这层翻译,所以在传输层补上。端点一旦给出结构化调用,正文里
 * 的围栏就退回普通文本。
 *
 * 正文只在两处离开扫描器:围栏之前已确定不是围栏的部分,以及流结束时仍未闭合的内容。因此普通
 * 发言照常流式下发,被扣下的只有真正的调用;扣留上限是围栏长度减一。
 */

export type ToolProtocolStep =
  | { kind: 'text'; text: string }
  | { kind: 'call'; name: string; arguments: string };

/** 协议只认这一个开头标记。 */
export const TOOL_PROTOCOL_FENCE = '```cortico';
const CLOSING_FENCE = '```';

/**
 * 缓冲区末尾可能只是开头标记的前半段,这些字符留到下一次输入再判断。
 * 返回要保留的长度;没有这种后缀时返回 0。
 */
function partialFenceTail(buffer: string): number {
  let keep = Math.min(TOOL_PROTOCOL_FENCE.length - 1, buffer.length);
  while (keep > 0 && !TOOL_PROTOCOL_FENCE.startsWith(buffer.slice(buffer.length - keep))) keep -= 1;
  return keep;
}

/**
 * 相邻的文本段合成一段,省掉无意义的分次下发。
 *
 * 这里不裁空白:同一段正文按不同 chunk 切分必须得到同一串文本,而"丢掉纯空白段"会让结果
 * 取决于切分位置。白噪由消费方忽略。
 */
function pushText(steps: ToolProtocolStep[], text: string): void {
  if (!text) return;
  const last = steps[steps.length - 1];
  if (last?.kind === 'text') last.text += text;
  else steps.push({ kind: 'text', text });
}

/**
 * 块正文转成一次调用;形状不对返回 null,由调用方按原样当文本发出。
 * `arguments` 接受对象或已经序列化好的字符串。
 */export function parseToolCall(body: string): { name: string; arguments: string } | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { name, arguments: args } = parsed as { name?: unknown; arguments?: unknown };
  if (typeof name !== 'string' || !name.trim()) return null;
  if (typeof args === 'string') return { name: name.trim(), arguments: args };
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return { name: name.trim(), arguments: JSON.stringify(args) };
}

/** 按增量喂正文,按出现顺序取出文本段与调用。 */
export class ToolProtocolScanner {
  private buffer = '';
  private inside = false;
  private disabled = false;

  /** 端点已给出结构化调用:此后围栏不再解析,已扣留的文本按原样放出。 */
  disable(): ToolProtocolStep[] {
    if (this.disabled) return [];
    this.disabled = true;
    const steps: ToolProtocolStep[] = [];
    this.release(steps);
    return steps;
  }

  push(chunk: string): ToolProtocolStep[] {
    if (chunk) this.buffer += chunk;
    return this.step(false);
  }

  /** 流结束。未闭合的开头标记按普通文本发出——那说明模型写的是正文。 */
  flush(): ToolProtocolStep[] {
    return this.step(true);
  }

  /** 把已扣留的缓冲整体当正文交出;在块内时要补回开头标记。 */
  private release(steps: ToolProtocolStep[]): void {
    const body = this.buffer;
    this.buffer = '';
    pushText(steps, this.inside ? TOOL_PROTOCOL_FENCE + body : body);
    this.inside = false;
  }

  private step(final: boolean): ToolProtocolStep[] {
    const steps: ToolProtocolStep[] = [];
    if (this.disabled) {
      this.release(steps);
      return steps;
    }
    for (;;) {
      if (this.inside) {
        const close = this.buffer.indexOf(CLOSING_FENCE);
        if (close === -1) {
          if (!final) break;
          this.release(steps);
          break;
        }
        const body = this.buffer.slice(0, close);
        this.buffer = this.buffer.slice(close + CLOSING_FENCE.length);
        this.inside = false;
        const call = parseToolCall(body);
        if (call) steps.push({ kind: 'call', name: call.name, arguments: call.arguments });
        else pushText(steps, TOOL_PROTOCOL_FENCE + body + CLOSING_FENCE);
        continue;
      }
      const at = this.buffer.indexOf(TOOL_PROTOCOL_FENCE);
      if (at === -1) {
        const keep = final ? 0 : partialFenceTail(this.buffer);
        const emit = this.buffer.slice(0, this.buffer.length - keep);
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        pushText(steps, emit);
        break;
      }
      pushText(steps, this.buffer.slice(0, at));
      this.buffer = this.buffer.slice(at + TOOL_PROTOCOL_FENCE.length);
      this.inside = true;
    }
    return steps;
  }
}
