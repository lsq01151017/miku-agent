# bots/miku

Owner: `index.ts`

初音未来。继承 `bots/cormini/` 的 Persona:工作区即记忆、Git 记账、交接、心跳与工具面都来自基类;
本包只加人格身份、情绪状态和心跳措辞。

| 文件 | 内容 |
|---|---|
| `index.ts` | `BotDefinition`:id、渠道声明、默认值、`build()` |
| `persona/persona.ts` | `Miku extends Cormini`:前缀模板、情绪更新、心跳措辞 |
| `persona/emotion.ts` | 六维情绪:词表更新、向基线回落、映射到离散心情 |
| `persona/config.ts` | 配置组:上下文阶段、情绪 |
| `persona/PREFIX.md` | 前缀装配模板(基类那份加上 EMOTION 段) |
| `persona/CONSTITUTION.seed.md` | 出厂宪法:身份、性格、说话方式、边界 |
| `persona/ORIENTATION.md` | 存在方式自述 |

## 情绪

状态住在 `CoreApi.personaState()`,进程重启后接着上一次的心情。六个连续值只在控制台的状态快照里看;
进系统前缀的只有**离散心情**那一小段 —— 连续值每轮都变会让前缀的复用率下降,而心情换挡不频繁。

`persona/emotion.ts` 的词表分析是启发式推断:它猜的是「这句话对说话人意味着什么情绪」,
而不是系统能确认的事实(见 [PHILOSOPHY.md](../../PHILOSOPHY.md) 的诚实认识论)。
因此它是一层可关闭的 fallback,`emotion.enabled` 关掉后状态冻结在当前值,前缀照样装配。

## 部署

`deployment.json` 写 `{"bot": "miku"}`。端点表在 `<部署根>/providers/`,本机端点的地址、
模型与 `spec.contextWindow` 都在那里 —— Ollama 不报告运行时生效的窗口,不填它 Core 不按窗口裁剪。
