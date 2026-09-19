/** 验证未启动 World 的状态灯声明:非空、名称唯一、状态合法且数量不超限。 */
import { describe, expect, it } from 'vitest';
import { MODULE_LAMP_MAX, type World, type WorldLamp } from '../src/core/types.ts';
import { ConsoleFixtureWorld } from '../src/worlds/console-fixture/world.ts';
import { TerminalWorld } from '../src/worlds/terminal/world.ts';

const MODULES: Array<() => World> = [
  () => new ConsoleFixtureWorld(),
  () => new TerminalWorld(),
];

const STATES: ReadonlyArray<WorldLamp['state']> = ['online', 'loading', 'error', 'offline'];

describe('状态灯契约', () => {
  it.each(MODULES.map((make) => [make().id, make] as const))(
    '%s:状态灯名称唯一、状态合法且数量不超限',
    (_id, make) => {
      const lamps = make().console?.()?.lamps ?? [];
      expect(lamps.length, 'World 必须声明状态灯')
        .toBeGreaterThan(0);
      expect(lamps.length).toBeLessThanOrEqual(MODULE_LAMP_MAX);
      for (const lamp of lamps) {
        expect(STATES).toContain(lamp.state);
        expect(lamp.label, '状态灯必须有名称').toBeTruthy();
        if (lamp.hint !== undefined) expect(typeof lamp.hint).toBe('string');
      }

      expect(new Set(lamps.map((l) => l.label)).size).toBe(lamps.length);
    },
  );
});

describe('几个具体判据', () => {
  const lampsOf = (mod: World): WorldLamp[] => mod.console?.()?.lamps ?? [];
  const find = (mod: World, label: string): WorldLamp | undefined =>
    lampsOf(mod).find((l) => l.label === label);

  it('终端对话没人在线仍是绿：没人说话不是故障', () => {
    expect(lampsOf(new TerminalWorld())).toEqual([
      { label: '对话通道', state: 'online', hint: '无人在线' },
    ]);
  });

  it('未启动时是灰，不是红：没连上不等于出错', () => {
    expect(find(new TerminalWorld(), '对话通道')?.state).toBe('online');
  });
});
