# cortico-provider-ollama

Owner: `src/index.ts`

Ollama 的 OpenAI 兼容端点。HTTP / SSE、重试退避、计量、流装配、终态判定全在框架的
`providers/transport/`;这个包只回答三个问题:请求体长什么样、请求头带什么、思维链字段叫什么。

Ollama 把思维链放在 `reasoning`,Chat 方言的名字是 `reasoning_content`;`src/native.ts` 的
`normalizeReasoning` 在装配与解析之前改名,其余交给 `OpenAIHttpClient`。

| 文件 | 内容 |
|---|---|
| `src/index.ts` | `ProviderModule`:id、title、推理档、`create()` 与 `listModels()` |
| `src/native.ts` | 继承 `OpenAIHttpClient` 的客户端、`normalizeReasoning()`、流装配子类 |
| `tests/` | 模块契约与思维链改名 |

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
- 本端点是否产生 `tool_calls` 取决于模型。实测有只输出文本、`finish_reason` 为 `stop` 的模型;
  需要工具调用的会话应把端点指向支持它的模型,本模块不因模型能力而改变请求形状。
