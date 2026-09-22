# cortico-world-work

影子:`src/world.ts` 的 `WorkWorld` 与 `src/definition.ts` 的 `WORK`(契约在框架的 `src/world.ts` 与 `src/core/types.ts`)。

把「请 DSH 在这台机器上干活」做成她的一件工具。没有自己的服务、不监听端口:`work_run`
工具调用时现读配置,POST 到 DSH 侧动态插件挂在控制台上的路由(`/api/miku-work/run`),
等那边一轮真正的代理会话跑完,把最终答复作为回执带回来。

- **权限三态**落在本 World 的配置段(`worlds.work.permission`):`off` 在这里就地拒;
  `ask`/`trusted` 随请求带给 DSH,由那边按请求套沙箱与审批策略——`ask` 越出 DSH 工作区的
  动作会弹审批卡,`trusted` 全放行。形象页的权限按钮读写的就是这个值。
- **桥发布的头文件**(`dsh-bridge.json`,在部署数据目录):DSH 桌面外壳只放行带渲染器头的
  请求,桥插件每次启动把该头写进这个文件,本 World 读它随请求带上。文件写 `null` 表示
  那头没有桌面墙(plain `dsh web`),不用带。
- **令牌**(`worlds.work.token`):与 DSH 侧插件里的常量一致,防别的本地进程乱敲。

DSH 侧的桥是动态插件,不随 DSH 进程持久:DSH 重启后要在那个会话里重新定义并运行
(见 `记录/修改记录.md` 第 43 轮)。桥不在时,`work_run` 的回执会说明原因。
