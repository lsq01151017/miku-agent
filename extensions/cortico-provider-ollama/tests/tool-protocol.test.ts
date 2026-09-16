/**
 * 文本工具协议:扫描器本身,以及它在两条传输路径上的落地(非流式 `parse`、流式 `assembly`)。
 * 不发网络请求:fetch 被替换成固定响应。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaChatProvider } from '../src/native.ts';
import {
  ToolProtocolScanner,
  parseToolCall,
  type ToolProtocolStep,
} from '../src/tool-protocol.ts';

/** 相邻文本段可以落在不同的 push 里;契约是拼接后的序列。 */
function flatten(steps: ToolProtocolStep[]): ToolProtocolStep[] {
  const out: ToolProtocolStep[] = [];
  for (const step of steps) {
    const last = out[out.length - 1];
    if (step.kind === 'text' && last?.kind === 'text') last.text += step.text;
    else out.push({ ...step });
  }
  return out;
}

function scan(chunks: string[]): ToolProtocolStep[] {
  const scanner = new ToolProtocolScanner();
  const steps: ToolProtocolStep[] = [];
  for (const chunk of chunks) steps.push(...scanner.push(chunk));
  steps.push(...scanner.flush());
  return flatten(steps);
}

const sse = (values: unknown[]): Response =>
  new Response(values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');

afterEach(() => { vi.unstubAllGlobals(); });

describe('ToolProtocolScanner', () => {
  it('发言里出现别的围栏时原样保留', () => {
    expect(scan(['看这个 ```bash\nls\n``` 命令']))
      .toEqual([{ kind: 'text', text: '看这个 ```bash\nls\n``` 命令' }]);
  });

  it('把拆散在多个增量里的调用认出来', () => {
    expect(scan(['```cor', 'tico\n{"name":"terminal_send",', '"arguments":{"text":"嗨"}}\n``', '`']))
      .toEqual([{ kind: 'call', name: 'terminal_send', arguments: '{"text":"嗨"}' }]);
  });

  it('发言在前、调用在后,顺序不变', () => {
    expect(scan(['好的!\n```cortico\n{"name":"act","arguments":{"v":1}}\n```']))
      .toEqual([
        { kind: 'text', text: '好的!\n' },
        { kind: 'call', name: 'act', arguments: '{"v":1}' },
      ]);
  });

  it('块正文不是合法调用时整块当文本回吐', () => {
    const raw = '```cortico\n不是 JSON\n```';
    expect(scan([raw])).toEqual([{ kind: 'text', text: raw }]);
  });

  it('开头标记没闭合时按正文放出', () => {
    expect(scan(['在那之前 ```cortico 之后']))
      .toEqual([{ kind: 'text', text: '在那之前 ```cortico 之后' }]);
  });

  it('端点已给出结构化调用时,围栏退回文本且已扣留的正文要放出来', () => {
    const scanner = new ToolProtocolScanner();
    const steps = flatten([...scanner.push('```cort'), ...scanner.disable(), ...scanner.push('```')]);
    expect(steps).toEqual([{ kind: 'text', text: '```cort```' }]);
  });

  it('同一段正文按不同位置切分得到同一串文本', () => {
    const raw = '嗨!\n```cortico\n{"name":"t","arguments":{"x":"y"}}\n```\n再见';
    const expected = [
      { kind: 'text', text: '嗨!\n' },
      { kind: 'call', name: 't', arguments: '{"x":"y"}' },
      { kind: 'text', text: '\n再见' },
    ];
    expect(scan([raw])).toEqual(expected);
    expect(scan([...raw])).toEqual(expected);
  });
});

describe('parseToolCall', () => {
  it('只接受带非空 name 与对象或字符串 arguments 的对象', () => {
    expect(parseToolCall('')).toBeNull();
    expect(parseToolCall('[]')).toBeNull();
    expect(parseToolCall('{"arguments":{}}')).toBeNull();
    expect(parseToolCall('{"name":"  "}')).toBeNull();
    expect(parseToolCall('{"name":"t"}')).toBeNull();
    expect(parseToolCall('{"name":" t ","arguments":{}}')).toEqual({ name: 't', arguments: '{}' });
    expect(parseToolCall('{"name":"t","arguments":"{\\"a\\":1}"}')).toEqual({ name: 't', arguments: '{"a":1}' });
  });
});

describe('OllamaChatProvider 的协议落地', () => {
  const provider = (): OllamaChatProvider => new OllamaChatProvider({ baseUrl: 'https://fixture.test/v1' });

  it('非流式:块正文变成一次工具调用,且不留下正文', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      choices: [{
        message: { role: 'assistant', content: '```cortico\n{"name":"terminal_send","arguments":{"text":"嗨"}}\n```' },
        finish_reason: 'stop',
      }],
    })));

    const result = await provider().respond({ model: 'test', input: 'hi' });
    expect(result.response.output.map((item) => item.type)).toEqual(['function_call']);
    expect(result.response.output[0]).toMatchObject({
      name: 'terminal_send', arguments: '{"text":"嗨"}', status: 'completed',
    });
  });

  it('非流式:块前面的发言保留成正文项', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      choices: [{
        message: { role: 'assistant', content: '好的!\n```cortico\n{"name":"act","arguments":{}}\n```' },
        finish_reason: 'stop',
      }],
    })));

    const result = await provider().respond({ model: 'test', input: 'hi' });
    expect(result.response.output.map((item) => item.type)).toEqual(['message', 'function_call']);
    expect(result.response.output[0]).toMatchObject({ content: [{ type: 'output_text', text: '好的!\n' }] });
  });

  it('非流式:端点自己给了 tool_calls 时不走协议', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: '```cortico\n{"name":"fromText","arguments":{}}\n```',
          tool_calls: [{ id: 'native', type: 'function', function: { name: 'fromWire', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    })));

    const result = await provider().respond({ model: 'test', input: 'hi' });
    expect(result.response.output.filter((item) => item.type === 'function_call').map((item) => item.name))
      .toEqual(['fromWire']);
    expect(result.response.output.filter((item) => item.type === 'message'))
      .toMatchObject([{ content: [{ type: 'output_text', text: '```cortico\n{"name":"fromText","arguments":{}}\n```' }] }]);
  });

  it('流式:拆散的块仍然变成函数调用,且围栏不进输出事件', async () => {
    const events: string[] = [];
    vi.stubGlobal('fetch', async () => sse([
      { id: 'r1', model: 'test', choices: [{ index: 0, delta: { content: '好' } }] },
      { id: 'r1', model: 'test', choices: [{ index: 0, delta: { content: '的\n```cort' } }] },
      { id: 'r1', model: 'test', choices: [{ index: 0, delta: { content: 'ico\n{"name":"act","arguments":{"v":1}}\n``' } }] },
      { id: 'r1', model: 'test', choices: [{ index: 0, delta: { content: '`' }, finish_reason: 'stop' }] },
    ]));

    const result = await provider().respond(
      { model: 'test', input: 'hi' },
      { onEvent: (event) => events.push(event.type === 'response.output_text.delta' ? `text:${event.delta}` : event.type) },
    );

    expect(result.response.output.map((item) => item.type)).toEqual(['message', 'function_call']);
    expect(result.response.output[0]).toMatchObject({ content: [{ type: 'output_text', text: '好的\n' }] });
    expect(result.response.output[1]).toMatchObject({ name: 'act', arguments: '{"v":1}', status: 'completed' });
    expect(events.filter((name) => name.startsWith('text:'))).toEqual(['text:好', 'text:的\n']);
  });

  it('流式:普通发言逐段下发,不做缓冲', async () => {
    const events: string[] = [];
    vi.stubGlobal('fetch', async () => sse([
      { id: 'r2', model: 'test', choices: [{ index: 0, delta: { content: '你' } }] },
      { id: 'r2', model: 'test', choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }] },
    ]));

    const result = await provider().respond(
      { model: 'test', input: 'hi' },
      { onEvent: (event) => { if (event.type === 'response.output_text.delta') events.push(event.delta); } },
    );

    expect(events).toEqual(['你', '好']);
    expect(result.response.output.map((item) => item.type)).toEqual(['message']);
  });
});
