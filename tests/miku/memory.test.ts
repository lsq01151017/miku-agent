/**
 * Lv2 记忆的机械规则:写权限矩阵、memo 容量门、人物名册。
 * 真实工作区(临时目录里的真文件),不碰模型。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitWorkspaceMemory } from '../../bots/cormini/persona/memory.ts';
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

describe('人物名册', () => {
  it('每份档案一行:文件名作称呼,首行作概括', () => {
    mkdirSync(join(dir, 'people'), { recursive: true });
    writeFileSync(join(dir, 'people', '可可.md'), '可可 — 制作人,喜欢下雨天。\n第二行不该出现。\n', 'utf8');
    writeFileSync(join(dir, 'people', '小满.md'), '', 'utf8');
    writeFileSync(join(dir, 'people', 'README.txt'), '不是档案\n', 'utf8');
    const roster = buildRoster(dir);
    expect(roster).toContain('- 可可 — 可可 — 制作人,喜欢下雨天。');
    expect(roster).toContain('- 小满 — (档案第一行为空)');
    expect(roster).not.toContain('第二行');
    expect(roster).not.toContain('README');
  });

  it('没有 people/ 目录时返回空串,缺省文案交给模板', () => {
    rmSync(join(dir, 'people'), { recursive: true, force: true });
    expect(buildRoster(dir)).toBe('');
  });
});
