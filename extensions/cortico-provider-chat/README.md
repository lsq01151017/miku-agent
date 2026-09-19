# cortico-provider-chat

Cortico 的 provider 扩展:任何 OpenAI 兼容的 **Chat Completions** 端点。

## 与 `openai-responses-compat` 的分工

两者都是"OpenAI 兼容",差别在路径与请求体,不是方言:

| | 路径 | 请求体 |
|---|---|---|
| `openai-responses-compat` | `/responses` | Responses |
| 本包 | `/chat/completions` | Chat Completions |

同一个端点通常只实现一套。多数第三方兼容服务只给 Chat,这时只能用本包。

## 端点条目

```json
{
  "kind": "chat",
  "baseUrl": "https://example.test/v1",
  "secret": "MY_API_KEY",
  "spec": { "model": "some-model", "maxTokens": 4096 }
}
```

`secret` 是环境变量名或端点 `.env` 里的键名,值由框架按名字取,不写进这个文件。

## 上下文窗口

`GET /models` 只给 id,不给窗口,所以本模块不探测它。要按窗口裁剪上下文就在 `spec.contextWindow`
里显式填;不填时 Core 不按窗口裁剪。

## 工具调用

端点自己产出结构化 `tool_calls`,直接用 transport 的默认装配。模板缺 `.Tools` 分支、只把调用
写成正文的模型需要文本工具协议兜底,那是 `cortico-provider-ollama` 的事,本包不做。
