/**
 * 梦:交接后从交接前的快照 fork 出的整理线程。照 `bots/corti-soulmate/persona/subconscious/index.ts` 移植。
 *
 * 结构照旧:交接时把不可变快照排进串行队列,一次交接一场梦;梦用同一份系统前缀(同一个身份,
 * 也复用前缀缓存)加一段引导,继承截断到预算内的对话尾;结束时 `surface` 的那段话回到醒来那一侧。
 *
 * 与参考实现的两处差异都来自本地窗口只有 4096 token:
 *  - 引导是紧凑版(见 `dreamPrompts.ts`);
 *  - 留给动态尾的余量按预算比例算,不写死 8000——固定余量在 3072 的预算上会把动态尾挤成零。
 */
import { message, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { hasRole, withoutPastReasoning } from 'cortico/protocol/open-responses/context-helpers.ts';
import type { CoreApi, Logger, ToolDef } from 'cortico/core/types.ts';
import { estimateMessagesTokens, nowIso } from 'cortico/core/util.ts';
import { GenerationError } from 'cortico/core/generation.ts';
import { closeDanglingCalls, rebuildTail } from 'cortico/core/truncate.ts';
import { dreamOrientation, dreamTask } from './dreamPrompts.ts';

export const DREAM = 'dream';

/**
 * 预留给引导、工具回执与输出的比例。窗口越小越不能写死绝对值:
 * 固定 8000 在 64k 上是余量,在 3072 上是把动态尾清零。
 */
const DREAM_RESERVE_RATIO = 0.3;

export interface DreamContextPolicy {
  /** 阶段预算,与主 session 同一份。 */
  maxTokens: number;
  keepPastThinking: boolean;
}

export interface DreamDeps {
  core: CoreApi;
  /** 每次现读:阶段预算与控制台上的改动即时生效。 */
  context: () => DreamContextPolicy;
  timezone: () => string;
  /** 梦的工具面:文件工具 + 只读的 World 工具。 */
  dreamTools: () => ToolDef[];
  /** 交接留下的笔记文件,相对工作区;没有就给 null。 */
  handoffFile: () => string | null;
  log: Logger;
  onEmergence: (text: string) => void;
}

export class Dream {
  private readonly d: DreamDeps;
  private dreaming = false;
  /** 串行队列:并发写工作区会互相踩。 */
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: DreamDeps) {
    this.d = deps;
  }

  getStatus(): { dreaming: boolean } {
    return { dreaming: this.dreaming };
  }

  /** 强制入梦仍走上下文交接事务,不另起生命周期。 */
  forceDreamAndTruncate(): boolean {
    if (this.dreaming) return false;
    return this.d.core.requestContextHandoff();
  }

  /** 把不可变快照排进队列;返回的 Promise 在这场的整理结束后兑现。 */
  schedule(snapshot: ContextRecord[]): Promise<void> {
    const run = (): Promise<void> => this.run(snapshot);
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  /** `surface` 是每场梦私有的一次性工具,不属于任何 session 的常备工具。 */
  private makeSurfaceTool(surfaced: { text: string | null }): ToolDef {
    return {
      name: 'surface',
      description: 'Hand a short sleep summary back to the waking thread. One call only; '
        + 'if nothing is worth returning, do not call this.',
      tags: ['flow'],
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The summary: a few sentences, first person, conclusion only.' },
        },
        required: ['text'],
      },
      handler: async (args) => {
        const text = String(args.text ?? '').trim();
        if (!text) return '[bad input] text is empty';
        if (surfaced.text !== null) return '[already surfaced once; ending]';
        surfaced.text = text;
        return '[sleep summary captured; it reaches the waking thread when this fork ends]';
      },
    };
  }

  private async run(snapshot: ContextRecord[]): Promise<void> {
    const { log } = this.d;
    this.dreaming = true;
    const started = Date.now();
    log.info('梦开始', { sessionMessages: snapshot.length });
    try {
      const policy = this.d.context();
      // 引导接在原快照之后:同一身份,也复用主 session 的前缀缓存。
      const guide: ContextRecord = message('user', [
        dreamOrientation(),
        dreamTask({ nowText: nowIso(this.d.timezone()), handoffFile: this.d.handoffFile() }),
      ].join('\n\n'));

      const closed = closeDanglingCalls([...snapshot]);
      let head = 0;
      while (head < closed.length && hasRole(closed[head], 'system')) head++;
      const systemMsgs = closed.slice(0, head);
      const dynamic = closed.slice(head);
      const view = policy.keepPastThinking ? dynamic : withoutPastReasoning(dynamic);
      const fixedTokens = estimateMessagesTokens([...systemMsgs, guide]);
      const reserve = Math.floor(policy.maxTokens * DREAM_RESERVE_RATIO);
      const dynamicBudget = Math.max(0, policy.maxTokens - fixedTokens - reserve);
      let inherited: ContextRecord[] = dynamic;
      if (estimateMessagesTokens(view) > dynamicBudget) {
        inherited = rebuildTail(view, dynamicBudget);
        // 单条消息仍超预算时放弃动态尾:梦照样能整理工作区,只是少了刚过去的那一幕。
        if (estimateMessagesTokens(inherited) > dynamicBudget) inherited = [];
      }

      const surfaced = { text: null as string | null };
      const summary = await this.d.core.spawnFork({
        id: DREAM,
        messages: [...systemMsgs, ...inherited, guide],
        tools: [...this.d.dreamTools(), this.makeSurfaceTool(surfaced)],
        stopWhen: () => surfaced.text !== null,
        wrapUpHint: '收尾:值得留一段睡眠摘要就现在调 surface,否则安静结束。',
        nudge: {
          when: (lastContent) => surfaced.text === null && lastContent.trim().length > 0,
          message: '[system] 你写下的正文没有落到醒来那一侧。值得说就调一次 surface,否则安静结束。',
        },
      });
      log.info('梦结束', {
        ms: Date.now() - started,
        fixedTokens,
        dynamicBudget,
        inheritedMessages: inherited.length,
        surfaced: surfaced.text !== null,
        summary: (summary ?? '').slice(0, 300),
      });
      if (surfaced.text !== null) this.d.onEmergence(surfaced.text);
    } catch (error) {
      log.error('梦失败', {
        err: String(error),
        ...(error instanceof GenerationError ? { body: error.body.slice(0, 500) } : {}),
      });
    } finally {
      this.dreaming = false;
    }
  }
}
