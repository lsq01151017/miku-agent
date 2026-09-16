/**
 * Lv2 记忆的机械规则:写权限矩阵、memo 容量门、人物名册。
 * 真实工作区(临时目录里的真文件),不碰模型。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitWorkspaceMemory } from '../../bots/cormini/persona/memory.ts';
import { forgetTool } from '../../bots/miku/persona/forget.ts';
import { MemoTiers } from '../../bots/miku/persona/memoTiers.ts';
import { memoCapGuard } from '../../bots/miku/persona/memoryTools.ts';
import { asPersonaRole, checkAccess, zoneOf } from '../../bots/miku/persona/permissions.ts';
import { buildRoster } from '../../bots/miku/persona/roster.ts';

let dir = '';
let ws: GitWorkspaceMemory;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'miku-mem-'));
  ws = new GitWorkspaceMemory({ memoryDir: dir, warn: () => {} });
  ws.ensureDirs(['memo', 'memo/active', 'memo/archived', 'note', 'people']);
});

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const memoWith = (residentCap: number, activeCap: number): MemoTiers =>
  new MemoTiers(ws, { residentCap, activeCap });

const fillResidents = (n: number): void => {
  for (let i = 0; i < n; i++) ws.writeFileAtomic(`memo/备忘${i}.md`, `第 ${i} 条\n`);
};

describe('写权限矩阵', () => {
  it('区域按路径前缀判定', () => {
    expect(zoneOf('CONSTITUTION.md')).toBe('constitution');
    expect(zoneOf('note/歌词.md')).toBe('note');
    expect(zoneOf('memo/active/日程.md')).toBe('memo');
    expect(zoneOf('people/制作人.md')).toBe('people');
    expect(zoneOf('随手写的.md')).toBe('other');
  });

  it('未知 session id 按权限较窄的主意识算', () => {
    expect(asPersonaRole('dream')).toBe('dream');
    expect(asPersonaRole('main')).toBe('main');
    expect(asPersonaRole('fork-7')).toBe('main');
  });

  it('主意识:笔记与备忘可写可改可搬,不能删', () => {
    for (const op of ['write', 'append', 'rename'] as const) {
      expect(checkAccess('main', op, 'note/歌词.md').ok).toBe(true);
      expect(checkAccess('main', op, 'memo/日程.md').ok).toBe(true);
      expect(checkAccess('main', op, '随手.md').ok).toBe(true);
    }
    const denied = checkAccess('main', 'delete', 'note/歌词.md');
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.reason).toContain('move_file');
  });

  it('主意识:people/ 只许追加', () => {
    expect(checkAccess('main', 'append', 'people/制作人.md').ok).toBe(true);
    const write = checkAccess('main', 'write', 'people/制作人.md');
    expect(write.ok).toBe(false);
    expect(write.ok === false && write.reason).toContain('append_file');
    expect(checkAccess('main', 'delete', 'people/制作人.md').ok).toBe(false);
    expect(checkAccess('main', 'rename', 'people/制作人.md').ok).toBe(false);
  });

  it('主意识:宪法只读', () => {
    for (const op of ['write', 'append', 'rename', 'delete'] as const) {
      const verdict = checkAccess('main', op, 'CONSTITUTION.md');
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toContain('dream');
    }
  });

  it('两个角色都能读任何区域', () => {
    for (const path of ['CONSTITUTION.md', 'note/x.md', 'memo/x.md', 'people/x.md', '随便.md']) {
      expect(checkAccess('main', 'read', path).ok).toBe(true);
      expect(checkAccess('dream', 'read', path).ok).toBe(true);
    }
  });

  it('梦:可以改宪法内容,但不能改名或删除它', () => {
    expect(checkAccess('dream', 'write', 'CONSTITUTION.md').ok).toBe(true);
    expect(checkAccess('dream', 'append', 'CONSTITUTION.md').ok).toBe(true);
    expect(checkAccess('dream', 'rename', 'CONSTITUTION.md').ok).toBe(false);
    expect(checkAccess('dream', 'delete', 'CONSTITUTION.md').ok).toBe(false);
    expect(checkAccess('dream', 'delete', 'note/歌词.md').ok).toBe(true);
  });
});

describe('memo 容量门', () => {
  it('常驻层满了就拒绝新增,并说清现状与出路', () => {
    fillResidents(2);
    const denied = memoCapGuard(ws, memoWith(2, 5), 'memo/新的一条.md');
    expect(denied).not.toBeNull();
    expect(denied).toContain('2/2');
    expect(denied).toContain('move_file');
    expect(denied).toContain('备忘0.md');
    expect(denied).toContain('备忘1.md');
  });

  it('没满就放行', () => {
    fillResidents(1);
    expect(memoCapGuard(ws, memoWith(2, 5), 'memo/新的一条.md')).toBeNull();
  });

  it('覆写已存在的常驻条目不算新增', () => {
    fillResidents(2);
    expect(memoCapGuard(ws, memoWith(2, 5), 'memo/备忘0.md')).toBeNull();
  });

  it('同层改名不算新增', () => {
    fillResidents(2);
    expect(memoCapGuard(ws, memoWith(2, 5), 'memo/改了名.md', 'memo/备忘0.md')).toBeNull();
  });

  it('从常驻下沉到已满的 active 会被拦,并指向 archived', () => {
    fillResidents(2);
    for (let i = 0; i < 1; i++) ws.writeFileAtomic(`memo/active/活跃${i}.md`, 'x\n');
    const denied = memoCapGuard(ws, memoWith(2, 1), 'memo/active/下沉.md', 'memo/备忘0.md');
    expect(denied).not.toBeNull();
    expect(denied).toContain('1/1');
    expect(denied).toContain('memo/archived/');
  });

  it('memo 之外的路径不受容量门管', () => {
    fillResidents(2);
    expect(memoCapGuard(ws, memoWith(2, 5), 'note/歌词.md')).toBeNull();
    expect(memoCapGuard(ws, memoWith(2, 5), 'people/制作人.md')).toBeNull();
  });

  it('计数只认当层的一级文件,临时与隐藏文件除外', () => {
    fillResidents(2);
    ws.writeFileAtomic('memo/.隐藏.md', 'x\n');
    ws.writeFileAtomic('memo/半截.md.tmp-1', 'x\n');
    const memo = memoWith(2, 5);
    expect(memo.residentFiles()).toEqual(['备忘0.md', '备忘1.md']);
    expect(memoCapGuard(ws, memo, 'memo/新的一条.md')).not.toBeNull();
  });

  it('常驻层全文带分隔抬头,归档只报数量', () => {
    fillResidents(2);
    ws.writeFileAtomic('memo/active/A.md', 'a\n');
    ws.writeFileAtomic('memo/archived/旧.md', 'old\n');
    const memo = memoWith(2, 5);
    expect(memo.residentBodies()).toContain('── memo/备忘0.md ──');
    expect(memo.activeFiles()).toEqual(['A.md']);
    expect(memo.archivedCount()).toBe(1);
  });
});

describe('forget:操作员明确要求忘记时当场生效', () => {
  let reloads = 0;

  const run = async (path: string): Promise<{ receipt: string; reloads: number }> => {
    const tool = forgetTool({
      ws,
      reloadPrefix: () => {
        reloads += 1;
      },
    });
    const receipt = await tool.handler({ path }, { role: 'main' } as unknown as never);
    return { receipt: String(receipt), reloads };
  };

  beforeEach(() => { reloads = 0; });

  it('当场删掉文件,并请求重建前缀', async () => {
    ws.writeFileAtomic('memo/秘密.md', '她答应过不告诉别人。\n');
    const { receipt, reloads: calls } = await run('memo/秘密.md');
    expect(receipt).toContain('[forgotten]');
    expect(receipt).toContain('Git history');
    expect(ws.exists('memo/秘密.md')).toBe(false);
    expect(calls).toBe(1);
  });

  it('删掉之后名册与常驻层立刻不再有它', async () => {
    writeFileSync(join(dir, 'people', '秘密的人.md'), '秘密的人 — 不该被记住。\n', 'utf8');
    ws.writeFileAtomic('memo/秘密.md', '内容\n');
    expect(buildRoster(dir)).toContain('秘密的人');
    expect(memoWith(7, 21).residentFiles()).toContain('秘密.md');

    await run('people/秘密的人.md');
    await run('memo/秘密.md');

    expect(buildRoster(dir)).not.toContain('秘密的人');
    expect(memoWith(7, 21).residentFiles()).not.toContain('秘密.md');
  });

  it('宪法不在可忘之列,且不触发重建', async () => {
    ws.writeFileAtomic('CONSTITUTION.md', '# 我是初音未来\n');
    const { receipt, reloads: calls } = await run('CONSTITUTION.md');
    expect(receipt).toContain('[forget failed]');
    expect(ws.exists('CONSTITUTION.md')).toBe(true);
    expect(calls).toBe(0);
  });

  it('不存在的路径与目录都拒绝,且不触发重建', async () => {
    const missing = await run('memo/没有这条.md');
    expect(missing.receipt).toContain('[forget failed]');
    expect(missing.reloads).toBe(0);
    const folder = await run('memo');
    expect(folder.receipt).toContain('[forget failed]');
    expect(folder.reloads).toBe(0);
    const empty = await run('');
    expect(empty.receipt).toContain('[forget failed]');
    expect(empty.reloads).toBe(0);
  });
});

describe('人物名册', () => {
  it('每份档案一行:文件名作称呼,首段正文作概括', () => {
    mkdirSync(join(dir, 'people'), { recursive: true });
    writeFileSync(join(dir, 'people', '可可.md'), '可可 — 制作人,喜欢下雨天。\n第二行不该出现。\n', 'utf8');
    writeFileSync(join(dir, 'people', '小满.md'), '', 'utf8');
    writeFileSync(join(dir, 'people', 'README.txt'), '不是档案\n', 'utf8');
    const roster = buildRoster(dir);
    expect(roster).toContain('- 可可 — 可可 — 制作人,喜欢下雨天。');
    expect(roster).toContain('- 小满 — (档案里没有正文)');
    expect(roster).not.toContain('第二行');
    expect(roster).not.toContain('README');
  });

  it('先写标题行的档案照样抽得出概括', () => {
    mkdirSync(join(dir, 'people'), { recursive: true });
    writeFileSync(join(dir, 'people', '可可.md'), '# 可可\n\n当前的称呼：可可\n一句概括：第一个告诉我名字的人。\n', 'utf8');
    expect(buildRoster(dir)).toContain('- 可可 — 当前的称呼：可可');
  });

  it('没有 people/ 目录时返回空串,缺省文案交给模板', () => {
    rmSync(join(dir, 'people'), { recursive: true, force: true });
    expect(buildRoster(dir)).toBe('');
  });
});
