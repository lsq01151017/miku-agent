# bots/miku

Owner: `index.ts`

初音未来。继承 `bots/cormini/` 的 Persona:工作区即记忆、Git 记账、交接、心跳与文件工具都来自基类;
本包加人格身份、情绪状态、心跳措辞、工具协议段,以及记忆的分层与写纪律。

| 文件 | 内容 |
|---|---|
| `index.ts` | `BotDefinition`:id、渠道声明、默认值、`build()` |
| `persona/persona.ts` | `Miku extends Cormini`:前缀模板、情绪更新、心跳措辞、工具协议段、写纪律 |
| `persona/emotion.ts` | 六维情绪:词表更新、向基线回落、映射到离散心情 |
| `persona/toolProtocol.ts` | 工具表与调用写法:模型收不到请求体 `tools` 时的唯一来源 |
| `persona/memoTiers.ts` | memo 三层(memo / active / archived)的视图与容量 |
| `persona/memoryTools.ts` | 容量守门与 `move_file` |
| `persona/memoryBand.ts` | MEMORY 段各占位符的活数据:地图、名册、memo 三层、时间 |
| `persona/permissions.ts` | 写权限矩阵:哪个角色在哪个区域能做什么 |
| `persona/roster.ts` | 从 `people/*.md` 抽名册 |
| `persona/MEMORY.md` | MEMORY 段的模板:引导语与空态措辞 |
| `persona/config.ts` | 配置组:上下文阶段、情绪、备忘容量、工具协议 |
| `persona/PREFIX.md` | 前缀装配模板(基类那份加上 EMOTION 与 MEMORY 段) |
| `persona/CONSTITUTION.seed.md` | 出厂宪法:身份、性格、说话方式、边界 |
| `persona/ORIENTATION.md` | 存在方式自述 |
| `worlds/terminal/ENV_PROMPT.md` | 终端通道的环境提示词覆盖 |

## 记忆

工作区就是记忆,分三层:

- `note/` 她的笔记,自由写;`people/` 人物档案,**只许追加**,改名与删除留给梦;
- `memo/` 时间性工作记忆。常驻层的全文每轮进前缀,`memo/active/` 只列文件名,
  `memo/archived/` 只报条数。两层各有容量上限(`memo.residentCap` / `memo.activeCap`),
  **满了不会自动下沉**:回执会说清现状与出路,她得自己用 `move_file` 挪一条下去。
- `CONSTITUTION.md` 清醒时只读,梦可以改它的内容但不能改名或删除。

容量与写的边界是机械规则,所以硬拦而不是劝告;拒绝理由是一句话,原样回到她手上。
矩阵按两条认知路径写全(`main` / `dream`),梦那一路的 session 由梦那一步声明。

### 忘记当场生效

`forget` 是矩阵里唯一一处越权,来源是**指令**而不是角色:清醒时不许删文件(整理归梦),
但操作员明确要求忘记时必须当场生效,等梦来清就等于没生效。它做两件事——删文件,
再请求重建系统前缀(`CoreApi.reloadSystemPrefix`),后者平时只在会话建立、交接与清空时发生,
因为重建会让之后的请求失去前缀缓存。

已经发出去的前缀收不回来:同一批里她仍看得到那一段。从下一批起不再出现。
工作区的 Git 历史里仍留着旧版本,真正的擦除不在这一步。

## 工具协议

Chat 模板缺 `.Tools` 的端点既不投递请求体的 `tools`,也不产出 `tool_calls`。`toolProtocol.enabled`
打开后,Persona 把工具表与调用写法写进前缀最后一段,端点侧把代码块翻成调用
(见 [../../extensions/cortico-provider-ollama](../../extensions/cortico-provider-ollama/README.md))。
默认关:能投递声明的端点不需要重述,重述还会与实际声明不一致。

打开它时工具表本身不够 —— 模型同样不知道「正文会送到哪里」,那句话归各输出通道的环境提示词。
`worlds/terminal/ENV_PROMPT.md` 因此整份替换了终端的模块模板:换掉它就要连 PIN 规则一起带过来。

## 情绪

状态住在 `CoreApi.personaState()`,进程重启后接着上一次的心情。六个连续值只在控制台的状态快照里看;
进系统前缀的只有**离散心情**那一小段 —— 连续值每轮都变会让前缀的复用率下降,而心情换挡不频繁。

`persona/emotion.ts` 的词表分析是启发式推断:它猜的是「这句话对说话人意味着什么情绪」,
而不是系统能确认的事实(见 [PHILOSOPHY.md](../../PHILOSOPHY.md) 的诚实认识论)。
因此它是一层可关闭的 fallback,`emotion.enabled` 关掉后状态冻结在当前值,前缀照样装配。

## 部署

`deployment.json` 写 `{"bot": "miku"}`。端点表在 `<部署根>/providers/`,本机端点的地址、
模型与 `spec.contextWindow` 都在那里 —— Ollama 不报告运行时生效的窗口,不填它 Core 不按窗口裁剪。
