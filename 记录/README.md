# D:\二面 —— 初音未来 Agent(记录)

这个文件夹装的是过程记录：做了什么、怎么做的、为什么这么做。代码与运行入口不在这里——版本一在
`D:\二面\my-agent\`，版本二在 `D:\二面\cortico\`，一键启停是 `D:\二面\启动她.bat` / `停止她.bat`。

| 文件 | 内容 |
|---|---|
| `README.md` | 本文件：两套实现是什么、怎么跑、各自的取舍与已知未完成 |
| `修改记录.md` | 逐轮记录：要什么 → 改了什么 → 为什么 → 怎么验证 → 对应提交 |
| `验收证据与取舍.md` | 题目 Lv1–Lv4 的落点、实测证据、设计与移植取舍 |
| `deepseek_share_conversation.md` | 需求来源的原始对话导出(含题目原文) |
| `deepseek_share_user_msgs.md` | 上面那份导出里操作员说过的话，单独摘出来 |
| `deepseek_share_raw.json` | 同一份导出的原始 JSON |

下面的路径都相对 `D:\二面\`。同一个角色（初音未来）、同一个题目
（[Heart Heart Heart](https://join.geek-tech.club/problems2/heart-heart-heart)）在这里有两套各自能跑的实现在并排放着：

| 版本 | 路径 | 语言 / 底座 | 入口 |
|---|---|---|---|
| **版本一** | `my-agent/` | Python 单体（自建路由 + SQLite 记忆 + 自带形象服务） | `my-agent\start.bat`、`my-agent\start_live2d.bat` |
| **版本二** | `cortico/` | TypeScript，跑在 Cortico 框架上（五层 + 扩展包） | `启动她.bat`、`停止她.bat` |

两套互不覆盖：版本**不共享进程、不共享记忆目录、端口也不同**，可以同时开着。版本二复用版本一的
Live2D 播放器库与模型文件（`my-agent/live2d/web`、`my-agent/live2d/models/miku`）；播放器库只读，
模型目录只在第 24 轮动过一次：`miku.model3.json` 改指降到 2048² 的贴图（`miku.2048/`），
4096 原图保留作回退。

**版本三**不是第三套实现：从修改记录第 26 轮起，版本二这套 `cortico/` 实现的继续演进叫版本三。
代码、部署与入口不变；这一版的主线是给记忆与性格加上时间感（记忆会沉寂，久别会想念）。

```
D:\二面
├── my-agent/            版本一（Python）
│   ├── main.py          交互入口 / 命令行
│   ├── router.py        这一轮该"回答"还是该"行动"
│   ├── local_agent.py   本地 Ollama deepseek-r1:14b:人格、情绪、记忆注入、流式
│   ├── api_agent.py     云端 deepseek-flash:工具调用与真实行动
│   ├── memory.py        SQLite(memory.db) 的记忆生命周期
│   ├── state.json       情绪与运行状态
│   ├── logs/            JSONL 审计日志
│   └── live2d/          avatar_server.py + web/ + models/
├── cortico/             版本二（TypeScript / Cortico）
│   ├── src/core/        与语义无关的内核
│   ├── bots/miku/       初音未来的人格包 + vtuber-pack 素材包
│   ├── extensions/      cortico-world-live2d、cortico-provider-ollama、cortico-provider-chat
│   └── deployments/miku/ 这份部署的配置、记忆、运行数据（不进 git）
├── 启动她.bat / 停止她.bat   版本二的一键启停
├── 记录/                 过程记录（本文件夹）：说明、逐轮修改记录、验收证据、需求原文
└── 新建文件夹/my-agent/  版本一的一份早期拷贝（只作备份，不要在这里改）
```

## 版本一：Python 单体

- **架构**：一套进程里做完所有事。`router.py` 用关键词策略链判断"该回答还是该行动"，
  `local_agent.py`（Ollama `deepseek-r1:14b`）负责人格、语气、情绪与记忆注入，
  `api_agent.py`（DeepSeek `deepseek-flash`）负责工具调用与真实行动，事实由云端给出、
  再由本地模型用她的语气说出口。语言输出与系统行为在数据流上是两件事。
- **状态与记忆**：`state.json` 存情绪与运行状态，`memory.db`（SQLite）存对话与记忆条目，
  记忆有存储 / 检索 / 覆盖修正 / 遗忘 / 衰减 / 巩固的生命周期；进程重启后角色接着上一次活着。
- **表现层**：`live2d/avatar_server.py` 自带形象服务（默认端口 **8765**），把情绪映射成表情与动作；
  模型与播放器库就在 `live2d/` 下。这部分实现与取舍写在 `my-agent/README.md` 第 9 节。
- **可观测**：`logs/agent_log.jsonl` 每轮一个 `trace_id`。
- **局限（如实）**：单体、无扩展点；核心逻辑集中在 5 个 20–56 KB 的 `.py` 文件里；
  加一个渠道或换一个模型都要改这几个文件；没有配置界面（改 `.env` / `config.py`）；
  没有内核与人格的层界，人格逻辑与协议细节混在同一个文件；目录不是 git 仓库。

## 版本二：Cortico 框架上的实现

- **五层分离**：Core（语义无关的内核：会话、上下文、事件、工具循环、成本与日志）/
  Persona（`bots/miku/persona/`：人格、情绪、记忆纪律、梦）/ Memory（工作区即记忆，Git 记账）/
  World（渠道：终端与形象）/ Bot（装配）。
- **扩展点**：World、Provider、Bot 都是 npm 包，`cortico-world-live2d` 与
  `cortico-provider-ollama` 就是这么挂上去的；换模型只换 Provider 条目，人格包不动。
  仓内只剩 `terminal` 一个 World —— QQ、B站直播、Minecraft、联网搜索四个渠道连同它们的依赖
  （mineflayer / prismarine / three 等）已从这个版本里删掉，要哪个再写一个 `cortico-world-*` 包。
- **控制台**：`http://127.0.0.1:18790/` —— 与她的对话在这里；配置项由各所有者用 JSON Schema
  声明、控制台直接渲染（改完即生效），不写死在前端里。
- **形象层**：`http://127.0.0.1:18795/` —— 独立 World，自己起 HTTP 服务用 SSE 推通道值；
  每帧合成四路：待机动作（呼吸/微晃/视线游移，一直在）、内部状态（六个情绪维度 → 身体基线）、
  她说的话（词表片段 + 每句起音与头部重音）、她的措辞（`bots/miku/vtuber-pack/expressions.json`
  → 模型自带的 Live2D 表情）。页面右侧是同一份数据的数值面板（六维、心情、表情、正在做的片段、
  每个通道的值），右下角可取景：缩放、左右、上下、直接拖动画面、复位、记住。
- **她的状态怎么来的**：情绪六维由人说给她的话更新（控制台里操作员打的字也算），
  心情进系统前缀、连续值走面板；梦（第二个 session）在交接后整理记忆。
- **局限（如实）**：比版本一重（依赖 pnpm / Node / tsx；启动脚本自己的开销在第 24 轮从约 3 秒
  压到约 0.6 秒，剩下的等待是 bot 自己的装配）；
  控制台前端改一行要重建 Web 产物，且重建时不能有 bot 活着；语音（TTS）还没做。

## 两个版本放在一起看

| | 版本一 `my-agent/` | 版本二 `cortico/` |
|---|---|---|
| 语言与底座 | Python 单体 | TypeScript + Cortico 五层 |
| 人格在哪 | `local_agent.py` 里的提示词与状态机 | `bots/miku/persona/`，与内核分离 |
| 换模型 | 改 `.env` / `config.py`，重跑 | 加一个 Provider 条目 |
| 加一个渠道 | 改 `main.py` + `router.py` | 写一个 World 扩展包，不动内核 |
| 记忆 | 自建 SQLite（`memory.db`）+ `state.json` | 工作区文件 + Git 记账，`deployments/miku/` |
| 情绪 | 六维连续值，进上下文 | 六维连续值，进前缀；另有离散心情、梦、涌现 |
| 状态可见性 | JSONL 日志 + 命令行 | 控制台面板 + 配置页 + 运行日志查询 |
| 形象驱动 | 情绪 → 表情/动作（`avatar_server.py`，端口 8765） | 内部状态 + 台词 + 措辞三路 → 通道/表情（端口 18795） |
| 启动 | `start.bat`（需先装好 Ollama） | `启动她.bat`（用 API 端点，不依赖本地模型） |
| 测试 | 脚本化验收用例 | 扩展与人格的测试套件（`pnpm test`）+ 类型检查 |

结论：版本一是把题目 Lv1–Lv3 一次性做透的单体实现，改起来直接、读起来集中；
版本二把同一件事拆成了可替换的层与包，代价是更重，收益是加渠道、换模型、调人格都不动别人的代码。
当前在维护的是**版本二**；版本一只作为对照与备份保留。

## 现在两套各自怎么跑

```powershell
# 版本二（她）：控制台 18790，形象 18795
D:\二面\启动她.bat
D:\二面\停止她.bat

# 版本一：形象服务 8765，交互在自己那个窗口里
D:\二面\my-agent\start.bat
```

版本二需要 `my-agent\.env` 里的 `DEEPSEEK_API_KEY`（一键脚本自己会读）；版本一需要本机 Ollama。

**同一份部署只允许一个实例**（`deployments/miku/data/instance.lock`）。谁改完代码谁负责收尾：
把实例停掉再交给操作员，别占着 18790/18795 和那把锁——否则下一次启动只会得到"已经在跑"，
看不出是真跑着还是刚才那个没退干净。锁的主人死了，脚本会自己清掉。

## 已知未完成

- 语音（TTS）与口型同步未做：形象层的口型是按说话时长跑的振荡，不是音频同步。
- 根测试套件在本机跑不全：仓库路径含中文（`D:\二面`）时，vite 不解 `pathToFileURL` 的
  百分号编码，53 个测试文件在收集阶段失败（见 `修改记录.md` 第 25 轮）；CI 在 ASCII
  路径下同一套件是绿的。要在本机跑全套，需把仓库放到纯 ASCII 路径。
- 形象页的水印通过模型自带的开关参数关掉（`Param137=1`），没有为水印动过模型；模型目录唯一的
  改动是第 24 轮把贴图降到 2048²。
- 扩展的 `page.test.ts` 有一项断言与 8 个类型错误在改动前（HEAD）就是红的，与第 24 轮无关，未修。
- 版本二的记忆与状态目录会在验收后清空，角色从零开始培养。
