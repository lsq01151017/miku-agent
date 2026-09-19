/**
 * 她说的话是**工具的调用参数**,不是正文。这里验两件事:
 *   1. `partialStringArgument` 从不完整的参数 JSON 里取话(转义切开时不许吐出半个字);
 *   2. 输出旁路把带 `speak` 标签的工具参数翻成正文增量交给接收她的 World。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import type { OutputTap, ToolDef, World } from 'cortico/core/types.ts';
import { Miku, partialStringArgument } from '../../bots/miku/persona/persona.ts';

describe('partialStringArgument', () => {
  it('字段还没出现时给 null,出现之后给出此刻的值', () => {
    expect(partialStringArgument('{"te', 'text')).toBe(null);
    expect(partialStringArgument('{"text"', 'text')).toBe(null);
    expect(partialStringArgument('{"text":', 'text')).toBe(null);
    expect(partialStringArgument('{"text":"你好', 'text')).toBe('你好');
    expect(partialStringArgument('{"text":"你好"}', 'text')).toBe('你好');
  });

  it('转义序列没拼完时不吐出半个字', () => {
    expect(partialStringArgument('{"text":"第一行\\', 'text')).toBe('第一行');
    expect(partialStringArgument('{"text":"第一行\\n第二行', 'text')).toBe('第一行\n第二行');
    expect(partialStringArgument('{"text":"引号\\"里', 'text')).toBe('引号"里');
    expect(partialStringArgument('{"text":"星\\u2', 'text')).toBe('星');
    expect(partialStringArgument('{"text":"星\\u2605', 'text')).toBe('星★');
  });

  it('只取命名的那个字段', () => {
    expect(partialStringArgument('{"note":"别的","text":"要的"}', 'text')).toBe('要的');
    expect(partialStringArgument('{"note":"别的"}', 'text')).toBe(null);
  });
});

/** 一个只说一句话的替身 World:声明 `speak` 标签的工具,并把自己的接收器交出来。 */
function speakingWorld(seen: StreamEvent[], external = false): World {
  const tool = {
    name: 'terminal_send',
    description: '说一句话',
    tags: ['speak'],
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: async () => '[sent]',
  } as unknown as ToolDef;
  return {
    id: 'terminal',
    tools: () => [tool],
    outputTap: () => ({
      onEvent: (event: StreamEvent) => seen.push(event),
      // 与形象层同形:只有"真的说了字"才算外部输出。
      ...(external ? { externalizes: (event: StreamEvent) => event.type === 'response.output_text.delta' } : {}),
    }),
  } as unknown as World;
}

describe('outputTap:把说话工具的参数字段翻成正文', () => {
  let dir = '';
  let seen: StreamEvent[] = [];

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'miku-speech-')); seen = []; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** 同一包内的子类:被保护的那条旁路可以直接问它要。 */
  class Probe extends Miku {
    tap(): OutputTap | undefined { return this.outputTap(); }
  }

  const build = (external = false): Probe => new Probe({
    memoryDir: dir,
    worlds: [speakingWorld(seen, external)],
    seedConstitution: '',
    context: () => ({ maxTokens: 1000, softRatio: 0.85, keepRatio: 0.34, firstTurn: false }),
  });

  const deltas = (): string[] =>
    seen.filter((event) => event.type === 'response.output_text.delta')
      .map((event) => (event as { delta: string }).delta);

  it('逐段吐出的话等于她说的那句话,且只吐增量', () => {
    const tap = build().tap()!;
    tap.onEvent({ type: 'response.output_item.added', item: { type: 'function_call', name: 'terminal_send', id: 'fc_1', call_id: 'call_1' } } as never);
    tap.onEvent({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"text":"你' } as never);
    tap.onEvent({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '好呀"}' } as never);

    expect(deltas().join('')).toBe('你好呀');
    expect(deltas().length).toBeGreaterThan(1);
  });

  it('不是说话工具、或没有正文参数时一个字都不发', () => {
    const tap = build().tap()!;
    tap.onEvent({ type: 'response.output_item.added', item: { type: 'function_call', name: 'read_file', id: 'fc_2', call_id: 'call_2' } } as never);
    tap.onEvent({ type: 'response.function_call_arguments.delta', item_id: 'fc_2', delta: '{"path":"a.md"}' } as never);
    expect(deltas()).toEqual([]);
  });

  it('她说的话算外部输出:有页面在看时这一轮不被抢占', () => {
    const tap = build(true).tap()!;
    const speaking = { type: 'response.output_item.added', item: { type: 'function_call', name: 'terminal_send' } } as never;
    const other = { type: 'response.output_item.added', item: { type: 'function_call', name: 'read_file' } } as never;
    expect(tap.externalizes?.(speaking)).toBe(true);
    expect(tap.externalizes?.(other)).toBe(false);
  });
});
