<!-- Owner: package.json, vitest.config.ts, tsconfig.json, tsconfig.web.json -->

# 开发

Node 22+,pnpm 11(版本由 `package.json` 的 `packageManager` 指定)。规则在 [AGENTS.md](../AGENTS.md),贡献流程在
[CONTRIBUTING.md](../CONTRIBUTING.md)。

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm start <部署名>` | 启动部署;`pnpm bots` 列出可用部署 |
| `pnpm test` / `pnpm test:watch` | vitest;`pnpm exec vitest run <路径>` 跑一部分 |
| `pnpm run typecheck` | Node 侧 `tsc --noEmit` |
| `pnpm typecheck:web` | 浏览器侧,`tsconfig.web.json` |
| `pnpm build:web` | 控制台产物:esbuild 分包 + Tailwind,写 `dist/web/` |
| `pnpm logq` | 查运行日志(见 [runs.md](runs.md)) |
| `pnpm check:extension <目录>` | 校验一个扩展包 |
| `pnpm audit:release` | 发布审计:部署资源、明文凭证、异常大文件 |

提交前必须通过 `pnpm test` 与 `pnpm run typecheck`;修改浏览器代码还需通过
`pnpm typecheck:web` 与 `pnpm build:web`。bot 运行期间禁止构建其正在使用的控制台文件。
使用测试、`pnpm typecheck` 或 `scratch/` 下的脚本验证改动,禁止为验证而启动真实 bot。
假数据控制台随四个内建 World 一起删掉了;要看控制台就起一个部署,或看控制台的测试。

扩展是 `file:` 依赖:启动器从 `extensions/node_modules/<包名>` 读它,不是读 `extensions/<包名>`
源码目录。改完扩展源码要重装一次快照,否则跑起来的是上一次装的那一份:

```bash
cd extensions && pnpm install --ignore-scripts --ignore-workspace
```

`--ignore-workspace` 不能省,否则根 lockfile 会多出一个 importer;`file:` 依赖会被缓存,
必要时先删掉 `extensions/node_modules`。

## 两份 tsconfig

Node 侧与浏览器侧分别配置类型库:`tsconfig.json` 排掉 `src/web/client/**`、`src/web/shared/**`、
各 `console/**` 与 jsdom 测试;`tsconfig.web.json` 使用 DOM 类型并移除 `@types/node`。
浏览器配置的 `include` 必须覆盖根配置排除的文件,并显式清空继承的 `exclude`。
该配置设有 `files: []`,遗漏上述设置可能导致没有文件被检查而仍以状态 0 退出。
被 Node 侧 import 到的共享文件两边都查。

## 测试

`vitest.config.ts`:`pool: forks`,两个 worker,超时 20 秒,`CORTICO_LANGUAGE=zh`(断言中文
文案,与机器区域无关)。

| 目录 | 覆盖 |
|---|---|
| `tests/*.test.ts` | 部署分层、装配、扩展、路径、发布审计、环境提示词契约、状态灯契约、架构边界 |
| `tests/core/` | 总线、主循环、fork、事件库、附件、成本、上下文;`fixture-*.ts` 是脚本化的模型 |
| `tests/web/` | 控制台:协议、内核、各框架页、面板 bundle、零 diff 验收 |
| `tests/worlds/<id>/` | 各 World |
| `tests/corti-soulmate/`、`tests/cormini/`、`tests/cortiv/` | 三个 Persona |
| `tests/integration/` | 整机:启动即暂停、系统装配 |
| `tests/helpers/` | `fake-host.ts`(World 的假宿主) |

测试使用脚本化模型、本地 git 仓库、端口与事件库;World 宿主与平台服务使用 `FakeHost` 等替身,
部分 HTTP 响应由测试提供。测试不访问外部网络。

## 目录

| 路径 | 内容 |
|---|---|
| `bin/cortico.mjs` | 启动器,仅依赖 Node 内建模块;可在安装项目依赖前运行 |
| `src/core/` | Core(见 [src/core/README.md](../src/core/README.md)) |
| `src/bot.ts`、`src/world.ts`、`src/deploy.ts`、`src/paths.ts`、`src/launcher.ts` | 装配、部署与启动 |
| `src/providers/`、`src/protocol/open-responses/` | 模型端点与通信协议 |
| `src/web/` | 控制台 |
| `src/extensions/`、`src/extensions.ts` | 扩展装载 |
| `src/worlds/<id>/` | 内建 World |
| `bots/<名>/` | bot 包 |
| `scripts/` | `build-web`、`dev-console`、`logq`、`extension-check`、`release-audit`、`migrate-rename`、`generate-open-responses` |
| `templates/extension/<kind>/` | World、Provider、bot 三类扩展的可安装模板 |
| `scratch/`、`deprecated/`、`deployments/`、`extensions/` | 都不进版本控制 |

## 文档

`docs/` 每页与每份代码单元的 README 首行写 owner。改 owner 的提交改页。没有代码 owner 的文字
不进 `docs/`。
