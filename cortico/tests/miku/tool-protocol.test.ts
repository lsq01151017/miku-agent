/**
 * 工具协议段:模型收不到请求体的 `tools` 时,这是它知道工具表与调用写法的唯一来源。
 * 端点侧的扫描器必须认得出这里给出的形状——两半分处两个包,这个不变量只能在这里守住。
 */
import { describe, expect, it } from 'vitest';
import { renderToolProtocol } from '../../bots/miku/persona/toolProtocol.ts';
import { ToolProtocolScanner } from '../../extensions/cortico-provider-ollama/src/tool-protocol.ts';
import type { ToolSchema } from 'cortico/core/types.ts';

const terminalSend: ToolSchema = {
  name: 'terminal_send',
  description: 'Send text to everyone connected to the terminal.\nSecond line is not the summary.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};

const readTool: ToolSchema = {
  name: 'ws_read',
  description: 'Read a file in the workspace. Whole file by default; give offset and limit to read a slice.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, maxLines: { type: 'number' } },
    required: ['path'],
  },
};

/** 前缀里那段示例代码块的正文。 */
function exampleBody(rendered: string): string {
  const start = rendered.indexOf('```cortico');
  const open = start + '```cortico'.length;
  return rendered.slice(open, rendered.indexOf('```', open)).trim();
}

describe('renderToolProtocol', () => {
  it('每个工具一行:参数带类型,可选参数带问号,描述只取第一句', () => {
    const rendered = renderToolProtocol([terminalSend, readTool]);
    expect(rendered).toContain('- terminal_send(text:string): Send text to everyone connected to the terminal.');
    expect(rendered).toContain('- ws_read(path:string, maxLines?:number): Read a file in the workspace.');
    expect(rendered).not.toContain('Second line is not the summary.');
    expect(rendered).not.toContain('give offset and limit');
  });

  it('描述只取第一句,省略号里的点不算断句', () => {
    const rendered = renderToolProtocol([
      { name: 'save_blob', description: 'Keep a binary you have seen (a log: handle from a [blob ...] line) in your workspace. Give the path to store it under.', parameters: { type: 'object', properties: {}, required: [] } },
    ]);
    expect(rendered).toContain('- save_blob(): Keep a binary you have seen (a log: handle from a [blob ...] line) in your workspace.');
    expect(rendered).not.toContain('Give the path');
  });

  it('没有工具时返回空串,调用方据此省略整段', () => {
    expect(renderToolProtocol([])).toBe('');
  });

  it('同名工具只留一行', () => {
    const lines = renderToolProtocol([terminalSend, { ...terminalSend, description: '别的描述。' }])
      .split('\n')
      .filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(1);
  });

  it('给出的示例是端点侧扫描器认的形状', () => {
    const body = exampleBody(renderToolProtocol([terminalSend]));
    expect(Object.keys(JSON.parse(body) as object)).toEqual(['name', 'arguments']);
    const call = JSON.stringify({ name: 'terminal_send', arguments: { text: '你好' } });
    const scanner = new ToolProtocolScanner();
    expect([...scanner.push('```cortico\n' + call + '\n```'), ...scanner.flush()])
      .toContainEqual({ kind: 'call', name: 'terminal_send', arguments: '{"text":"你好"}' });
  });
});
