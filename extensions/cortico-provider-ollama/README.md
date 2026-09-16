# cortico-provider-ollama

Owner: `src/index.ts`

Ollama 的 OpenAI 兼容端点。HTTP / SSE、重试退避、计量、流装配、终态判定全在框架的
`providers/transport/`;这个包回答四个问题:请求体长什么样、请求头带什么、思维链字段叫什么、
模型把工具调用写成正文时怎么办。

Ollama 把思维链放在 `reasoning`,Chat 方言的名字是 `reasoning_content`;`src/native.ts` 的
`normalizeReasoning` 在装配与解析之前改名,其余交给 `OpenAIHttpClient`。

| 文件 | 内容 |
|---|---|
| `src/index.ts` | `ProviderModule`:id、title、推理档、`create()` 与 `listModels()` |
| `src/native.ts` | 继承 `OpenAIHttpClient` 的客户端、`normalizeReasoning()`、流装配子类 |
| `src/tool-protocol.ts` | 文本工具协议:围栏扫描与块解析 |
| `tests/` | 模块契约、思维链改名、协议在两条传输路径上的落地 |

## 端点条目

```json
{
  "kind": "ollama",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "spec": { "model": "<本机模型名>", "thinking": true, "contextWindow": 8192 }
}
```

`contextWindow` 必须显式填写:Ollama 不报告运行时生效的窗口。

## 两条已实测的端点事实

- 兼容端点接受 `num_ctx`、`think`、`keep_alive` 这类原生键但不生效,是否推理只由模型决定。
  需要原生参数时改用 `llamacpp` 端点,或直接对 `/api/chat` 发请求。
- 聊天模板里没有 `.Tools` 分支的模型收不到请求体的 `tools`:实测这类端点既不产出
  `tool_calls`,`finish_reason` 为 `stop`,模型也从不提工具名。它会用自己的写法把调用写进正文。

## 文本工具协议(具名回退)

Chat 模板缺 `.Tools` 时,模型无法产出结构化 `tool_calls`,只会把调用写成正文。这是当前模型的
限制,不是端点的约定:`src/tool-protocol.ts` 把一个围栏块翻成一次调用。

```
```cortico
{"name": "terminal_send", "arguments": {"text": "..."}}
```
```

- 正文里出现的块转成 `function_call`;块之外的部分照常作为正文下发,围栏本身不进输出事件。
- 端点一旦给出结构化 `tool_calls`,正文里的围栏退回普通文本,协议不再参与。
- 块正文不是合法调用(或开头标记未闭合)时整块按正文回吐,不吞内容。
- 同一段正文按不同位置切分得到同一串文本:普通发言只有围栏长度减一的延迟。

请求形状不因此改变,`tools` 照常发出。模型能读到时它就用原生调用,读不到时才走协议。

**这条协议要求提示词侧配合**:收不到 `tools` 的模型也不会自己知道工具名与参数,所以调用它时
必须由 Persona 把工具表与协议一起渲染进前缀。端点支持原生工具调用时不需要这一步。
