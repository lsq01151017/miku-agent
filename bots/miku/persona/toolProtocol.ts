/**
 * 文本工具协议的提示词一侧:模型收不到请求体的 `tools` 时,从这里知道有哪些工具、怎么写调用。
 *
 * 协议在端点侧解析(见扩展 `cortico-provider-ollama` 的 `tool-protocol.ts`);这里只把工具表与
 * 写法写进前缀。端点能投递结构化 `tools` 时保持关闭:那份声明由框架发出,重述既占前缀预算,
 * 又可能与实际声明不一致。
 *
 * 这里不说"正文会送到哪里":那是各输出通道自己的事,归 World 的环境提示词。
 */
import type { ToolSchema } from 'cortico/core/types.ts';

/** 与端点侧扫描器认的开头标记一致。 */
const FENCE = '```cortico';

interface ParameterShape {
  properties?: Record<string, { type?: unknown }>;
  required?: unknown;
}

/** 参数写 `名字:类型`,可选参数带 `?`;没有参数就是空括号。 */
function signature(tool: ToolSchema): string {
  const parameters = (tool.parameters ?? {}) as ParameterShape;
  const properties = parameters.properties ?? {};
  const required = new Set(Array.isArray(parameters.required) ? parameters.required.map(String) : []);
  const parts = Object.entries(properties).map(([name, shape]) => {
    const type = typeof shape?.type === 'string' ? shape.type : 'any';
    return `${name}${required.has(name) ? '' : '?'}:${type}`;
  });
  return `${tool.name}(${parts.join(', ')})`;
}

/** 描述只取第一行:前缀预算是有限的,后面的实现细节模型用不到。 */
function firstLine(description: string): string {
  return description.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
}

/** 工具表与调用写法;没有工具时返回空串,调用方据此省略整段。 */
export function renderToolProtocol(tools: readonly ToolSchema[]): string {
  const unique = new Map(tools.map((tool) => [tool.name, tool]));
  if (unique.size === 0) return '';
  return [
    '[工具] 这个端点不接收框架发出的工具声明。要做事就调用工具,调用时按下面的写法。',
    '',
    '可用工具:',
    ...[...unique.values()].map((tool) => `- ${signature(tool)}: ${firstLine(tool.description)}`),
    '',
    '调用写法:一个代码块,块里是一段 JSON。块外不要重复写同一件事。',
    '',
    FENCE,
    '{"name": "工具名", "arguments": {"参数名": "值"}}',
    '```',
  ].join('\n');
}
