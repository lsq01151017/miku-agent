/**
 * 梦:引导、预算、浮现。工作区是真的,只有 LLM 是脚本化的(见 AGENTS.md §5)。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { message } from 'cortico/protocol/open-responses/context.ts';
import type { CoreApi, ForkOptions, ToolDef } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { GitWorkspaceMemory } from '../../bots/cormini/persona/memory.ts';
import { Dream } from '../../bots/miku/persona/dream.ts';
import { dreamOrientation, dreamTask } from '../../bots/miku/persona/dreamPrompts.ts';

let dir = '';
let ws: GitWorkspaceMemory;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'miku-dream-'));
  ws = new GitWorkspaceMemory({ memoryDir: dir, warn: () => {} });
});

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const writeTool: ToolDef = {
  name: 'write_file',
  description: 'Write a file.',
  tags: ['write'],
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async () => '[written]',
};

/** 只把模型换掉的 Core:调用 fork 时替模型调一次 surface,模拟"梦说了点什么"。 */
function fakeCore(surfaceText: string | null, seen: ForkOptions[], order: string[] = []): CoreApi {
  return {
    spawnFork: async (opts: ForkOptions): Promise<string> => {
      seen.push(opts);
      order.push(`start:${opts.id}`);
      if (surfaceText !== null) {
        const surface = opts.tools?.find((tool) => tool.name === 'surface');
        if (!surface) throw new Error('fork 没拿到 surface 工具');
        await surface.handler({ text: surfaceText }, {} as never);
      }
      order.push(`end:${opts.id}`);
      return '整理完了';
    },
    requestContextHandoff: () => true,
  } as unknown as CoreApi;
}

function makeDream(opts: {
  maxTokens?: number;
  surfaceText?: string | null;
  seen?: ForkOptions[];
  order?: string[];
  onEmergence?: (text: string) => void;
  handoffFile?: string | null;
}): Dream {
  return new Dream({
    core: fakeCore(opts.surfaceText ?? null, opts.seen ?? [], opts.order),
    context: () => ({ maxTokens: opts.maxTokens ?? 20000, keepPastThinking: false }),
    timezone: () => 'Asia/Shanghai',
    dreamTools: () => [writeTool],
    handoffFile: () => opts.handoffFile ?? null,
    log: nullLogger(),
    onEmergence: opts.onEmergence ?? (() => {}),
  });
}

const snapshot = (): ContextRecord[] => [
  message('system', '你是初音未来。'),
  message('user', '制作人:你好呀'),
  message('assistant', '你好,制作人～♪'),
];

describe('梦的提示词', () => {
  it('引导交代了身份延续与整理职责', () => {
    const text = dreamOrientation();
    expect(text).toContain('你还是同一个人');
    expect(text).toContain('消化、总结、归纳应当多于追加');
    expect(text).toContain('CONSTITUTION.md');
  });

  it('任务交代收尾方式(调用 surface),并带上交接笔记的路径', () => {
    const withNote = dreamTask({ nowText: '2026-09-16 22:00', handoffFile: 'handoffs/交接.md' });
    expect(withNote).toContain('surface');
    expect(withNote).toContain('handoffs/交接.md');
    expect(dreamTask({ nowText: '2026-09-16 22:00', handoffFile: null })).toContain('没有留下笔记文件');
  });
});

describe('梦的执行', () => {
  it('surface 的那段话交给浮现回调,梦结束后回到空闲', async () => {
    const got: string[] = [];
    const dream = makeDream({ surfaceText: '我把两条重复的备忘并成了一条。', onEmergence: (t) => got.push(t) });
    await dream.schedule(snapshot());
    expect(got).toEqual(['我把两条重复的备忘并成了一条。']);
    expect(dream.getStatus()).toEqual({ dreaming: false });
  });

  it('没调 surface 时不产生浮现', async () => {
    const got: string[] = [];
    const dream = makeDream({ surfaceText: null, onEmergence: (t) => got.push(t) });
    await dream.schedule(snapshot());
    expect(got).toEqual([]);
  });

  it('fork 的上下文是"主 session 的系统前缀 + 引导",任务说明在最后', async () => {
    const seen: ForkOptions[] = [];
    await makeDream({ seen, handoffFile: 'handoffs/交接.md' }).schedule(snapshot());
    const messages = seen[0]!.messages;
    expect(messages[0]!.item).toMatchObject({ role: 'system' });
    const guide = messages[messages.length - 1]!;
    expect(JSON.stringify(guide)).toContain('surface');
    expect(JSON.stringify(guide)).toContain('handoffs/交接.md');
  });

  it('预算不够时丢掉继承来的对话尾,并照常整理工作区', async () => {
    const seen: ForkOptions[] = [];
    // 引导本身就超过这个预算,动态尾只能清零;梦照样跑完。
    await makeDream({ seen, maxTokens: 300 }).schedule(snapshot());
    const messages = seen[0]!.messages;
    expect(messages).toHaveLength(2); // 系统前缀 + 引导
    expect(JSON.stringify(messages)).not.toContain('你好呀');
  });

  it('预算够时继承对话尾', async () => {
    const seen: ForkOptions[] = [];
    await makeDream({ seen, maxTokens: 20000 }).schedule(snapshot());
    expect(JSON.stringify(seen[0]!.messages)).toContain('你好呀');
  });

  it('两场梦串行执行,不并发写工作区', async () => {
    const order: string[] = [];
    const dream = makeDream({ surfaceText: '好', order });
    await Promise.all([dream.schedule(snapshot()), dream.schedule(snapshot())]);
    expect(order).toEqual(['start:dream', 'end:dream', 'start:dream', 'end:dream']);
  });

  it('每场梦的 surface 只收一次:第二次调用只是回执', async () => {
    const seen: ForkOptions[] = [];
    const core = fakeCore('第一次', seen);
    let second = '';
    (core as unknown as { spawnFork: (o: ForkOptions) => Promise<string> }).spawnFork = async (opts: ForkOptions) => {
      seen.push(opts);
      const surface = opts.tools!.find((tool) => tool.name === 'surface')!;
      await surface.handler({ text: '第一次' }, {} as never);
      second = String(await surface.handler({ text: '第二次' }, {} as never));
      return '';
    };
    const dream = new Dream({
      core,
      context: () => ({ maxTokens: 20000, keepPastThinking: false }),
      timezone: () => 'Asia/Shanghai',
      dreamTools: () => [writeTool],
      handoffFile: () => null,
      log: nullLogger(),
      onEmergence: () => {},
    });
    await dream.schedule(snapshot());
    expect(second).toContain('already surfaced');
  });
});
