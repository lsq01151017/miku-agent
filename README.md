# 初音未来 Agent —— Heart Heart Heart

一个有持续状态、人格、记忆与行动能力的虚拟形象智能体，外加一个由内部状态驱动的 Live2D 形象。
题目：[Heart Heart Heart](https://join.geek-tech.club/problems2/heart-heart-heart)。

| 目录 | 是什么 |
|---|---|
| `my-agent/` | 版本一：Python 单体（自建路由 + SQLite 记忆 + 自带形象服务） |
| `cortico/` | 版本二/三：TypeScript，跑在 Cortico 框架上（五层 + 扩展包）；28 轮演进历史在这个目录的提交里 |
| `记录/` | 过程记录：逐轮改了什么、为什么、怎么验证——从 [`记录/README.md`](记录/README.md) 读起 |
| `模型/` | Live2D 模型的原始压缩包 |
| `新建文件夹/` | 版本一的一份早期拷贝（备份） |

## 跑起来

```powershell
# 版本二/三（她）：控制台 http://127.0.0.1:18790/ ，形象页 http://127.0.0.1:18795/
.\启动她.bat        # 停止：.\停止她.bat

# 她的语音服务（本地 GPT-SoVITS + miku 微调模型，端口 9880）
.\启动语音.bat      # 停止：.\停止语音.bat

# 版本一：形象服务 8765，交互在自己那个窗口里
.\my-agent\start.bat
```

版本二/三需要 `my-agent\.env` 里的 `DEEPSEEK_API_KEY`（模板见 `my-agent\.env.example`）；
版本一还需要本机 Ollama。两套实现各自的取舍与已知限制见 [`记录/README.md`](记录/README.md)。
