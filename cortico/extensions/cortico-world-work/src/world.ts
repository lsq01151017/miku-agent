/**
 * 工作 World:把「请 DSH 在这台机器上干活」做成她的一件工具。
 *
 * 没有自己的服务、不监听端口——工具调用时现读配置、现读桥发布的头文件,POST 到
 * DSH 侧动态插件挂的路由,等那一轮代理会话跑完拿回执。权限三态(问/放行/关)落在本
 * World 的配置段:关在这里就地拒;问/放行随请求带给 DSH,由那边按请求套沙箱与审批策略。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolCallContext, ToolDef, ToolOutcome, World, WorldConsoleDecl, WorldHost } from 'cortico/core/types.ts';
import type { WorldContext } from 'cortico/world.ts';
import { WORK_CONFIG_GROUP, type WorkConfigSection } from './config.ts';

/** 环境提示词随包走,不在工作区里。 */
const ENV_PROMPT_FILE = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));
/** DSH 侧插件挂的路由;两边同一个约定。 */
const BRIDGE_ROUTE = '/api/miku-work/run';
/** 桥发布的头文件名,在部署数据目录里;DSH 侧插件每次启动重写。 */
const BRIDGE_HEADER_FILE = 'dsh-bridge.json';
/** task 上限与 DSH 侧一致;超了那边也会拒,这里先拒省一趟。 */
const TASK_LIMIT = 8000;

/** 桥回执的最小形状;多出来的字段忽略。 */
interface BridgeReply {
  ok?: unknown;
  reply?: unknown;
  error?: unknown;
  stop?: unknown;
  note?: unknown;
}

/** 桥发布的渲染器头;null 表示那头没有桌面墙,不用带。 */
interface BridgeHeader {
  header: string | null;
  value: string | null;
}

export interface WorkWorldOptions {
  cfg: WorkConfigSection;
  /** 部署数据目录;桥头文件在这里。 */
  dataDir: string;
}

export class WorkWorld implements World {
  readonly id = 'work';
  private readonly cfg: WorkConfigSection;
  private readonly dataDir: string;
  private host: WorldHost | null = null;

  constructor(opts: WorkWorldOptions) {
    this.cfg = opts.cfg;
    this.dataDir = opts.dataDir;
  }

  envPromptVars(): Record<string, string> {
    return { 'work.permission': this.cfg.permission };
  }

  tools(): ToolDef[] {
    return [{
      name: 'work_run',
      description: '请 DSH(本机的代理框架)替你在这台机器上干一件事:建文件、跑命令、整理目录、查资料都行。'
        + 'task 用一句完整的话说清楚要做什么、在哪儿、做成什么样;它会作为一轮真正的代理会话执行,'
        + '回执是那轮的最终答复,不是原始命令输出。一次说一件完整的事,拆成多次调用反而慢。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '要 DSH 做的事,一句完整的话;写清位置与期望结果。' },
        },
        required: ['task'],
        additionalProperties: false,
      },
      tags: ['act'],
      barrierAfter: true,
      handler: (args, ctx) => this.runTask(args, ctx),
    }];
  }

  console(): WorldConsoleDecl {
    const on = this.cfg.enabled;
    return {
      label: '工作接口',
      lamps: [{
        label: '通道',
        state: on ? 'online' : 'offline',
        hint: on ? `请求经 ${this.cfg.dshUrl} 送到 DSH;权限:${this.cfg.permission}` : '未启用',
      }],
      config: [WORK_CONFIG_GROUP],
      promptDocs: [{
        key: 'worlds.work.envPrompt',
        title: '工作接口',
        description: '告诉她怎么请 DSH 干活,以及权限三态各意味着什么。',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [],
      }],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
  }

  async stop(): Promise<void> {
    this.host = null;
  }

  /** 桥发布的头;文件不在或内容不全就当没有,让 DSH 的响应自己说话。 */
  private bridgeHeader(): BridgeHeader | null {
    try {
      const raw = JSON.parse(readFileSync(join(this.dataDir, BRIDGE_HEADER_FILE), 'utf8')) as Partial<BridgeHeader>;
      if (raw.header === null) return { header: null, value: null };
      if (typeof raw.header === 'string' && raw.header !== '' && typeof raw.value === 'string' && raw.value !== '') {
        return { header: raw.header, value: raw.value };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async runTask(args: Record<string, unknown>, ctx: ToolCallContext): Promise<string | ToolOutcome> {
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    if (task === '') return { text: 'task 是空的:说清楚要 DSH 做什么。', failed: true };
    if (task.length > TASK_LIMIT) {
      return { text: `task 太长(${task.length} 字,上限 ${TASK_LIMIT}):拆成一件更小的事。`, failed: true };
    }
    if (this.cfg.permission === 'off') {
      return '工作接口现在是关着的,这次没有做。请制作人到形象页把权限按钮打开(选「每次问」或「放行」),'
        + '或者先把这件事记下来,等打开后再做。';
    }
    return this.callBridge(task, ctx.signal);
  }

  private async callBridge(task: string, signal: AbortSignal | undefined): Promise<ToolOutcome> {
    const base = this.cfg.dshUrl.trim().replace(/\/+$/, '');
    if (base === '') return { text: '没配 worlds.work.dshUrl,不知道往哪儿送。', failed: true };
    const perm = this.cfg.permission === 'trusted' ? 'trusted' : 'ask';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const bridge = this.bridgeHeader();
    if (bridge !== null && bridge.header !== null && bridge.value !== null) headers[bridge.header] = bridge.value;
    const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await fetch(base + BRIDGE_ROUTE, {
        method: 'POST',
        headers,
        body: JSON.stringify({ task, perm, token: this.cfg.token }),
        signal: combined,
      });
    } catch (err) {
      return { text: this.netErrorText(err), failed: true };
    }
    if (response.status === 401) return { text: '桥令牌对不上:两边配置的 token 不一致。', failed: true };
    if (response.status === 403) {
      return { text: 'DSH 的桌面外壳把请求挡在门外:桥发布的头文件可能过期了。重启 DSH 侧的桥插件再试。', failed: true };
    }
    if (response.status === 404) return { text: 'DSH 上没有这条路由:桥插件没在跑。', failed: true };
    if (!response.ok) {
      return { text: `DSH 那边回 HTTP ${response.status}:桥内部出错了。`, failed: true };
    }
    let out: BridgeReply;
    try {
      out = await response.json() as BridgeReply;
    } catch {
      return { text: '桥的回执不是 JSON,这次没做成。', failed: true };
    }
    if (out.ok === true) {
      const reply = typeof out.reply === 'string' ? out.reply : '';
      const note = typeof out.note === 'string' && out.note !== '' ? `\n(${out.note})` : '';
      return { text: (reply + note) || '做完了,但那轮没有留下文字答复。' };
    }
    const error = typeof out.error === 'string' && out.error !== '' ? out.error : '没有给原因';
    const partial = typeof out.reply === 'string' && out.reply !== '' ? `\n那轮留下的部分答复:\n${out.reply}` : '';
    return { text: `DSH 那轮没成:${error}。${partial}`, failed: true };
  }

  /** 网络层失败按原因分话:超时、抢占、连不上各说各的。 */
  private netErrorText(err: unknown): string {
    const name = err instanceof Error ? err.name : String(err);
    if (name === 'TimeoutError') {
      return `等了 ${Math.round(this.cfg.timeoutMs / 1000)} 秒 DSH 那轮还没完(可能在等审批卡,制作人没点):这次没结果,`
        + '问一下制作人再重试。';
    }
    if (name === 'AbortError') return '这一轮被打断,DSH 那边的结果没等到。';
    const cause = err instanceof Error ? err.cause : undefined;
    if (cause instanceof Error && 'code' in cause && cause.code === 'ECONNREFUSED') {
      return `连不上 ${this.cfg.dshUrl}:DSH 没在跑,或者桥插件没起来。`;
    }
    return `送不到 DSH:${err instanceof Error ? err.message : String(err)}`;
  }
}
