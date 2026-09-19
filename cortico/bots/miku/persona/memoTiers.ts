/**
 * MEMORY 2 三级结构的只读视图 + 容量常量。照 `bots/corti-soulmate/persona/memoTiers.ts` 移植。
 *
 *   memo/顶层(常驻,前缀全文,容量 residentCap)
 *   memo/active/(前缀只列文件名,容量 activeCap)
 *   memo/archived/(前缀只显示数量,正文由她自己翻)
 *
 * 她使用通用文件工具(write_file/move_file/…)搬运条目;`memoCapGuard` 在写入时强制容量上限。
 * 本类只负责"各层现在有哪些文件、各自多久没动",供前缀拼装与容量检查使用,不写盘。
 *
 * 年纪按 mtime 算:重写一条就是巩固(mtime 随之刷新)。半衰期随层走——常驻层是重要的事,
 * 忘得慢;active/ 是时间性线索,忘得快。超过半衰期的条目进 `stale()`:那是"该翻新还是
 * 该沉下去"的候选名单,只报事实,取舍仍是她的。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { GitWorkspaceMemory } from '../../cormini/persona/memory.ts';

export interface MemoCaps {
  residentCap: number;
  activeCap: number;
}

/** 各层的活跃度半衰期(天)。重要性越高,忘得越慢;超过它即算"很久没动"。 */
export const MEMORY_HALF_LIFE_DAYS = { resident: 90, active: 30 } as const;

/** 一条记忆此刻的年纪。 */
export interface MemoAge {
  name: string;
  /** 距上次改动过了几天;不足一天算 0。 */
  ageDays: number;
}

const DAY_MS = 86_400_000;

/** 年纪的可读形式:不足一天说"今天动过",否则说"N 天没动"。 */
export function ageNote(ageDays: number): string {
  return ageDays < 1 ? '今天动过' : `${Math.round(ageDays)}天没动`;
}

export class MemoTiers {
  constructor(readonly ws: GitWorkspaceMemory, readonly caps: MemoCaps) {}

  /** 目录内的 memo 文件,按 mtime 升序(最旧在前;时间序纯机械)。 */
  private entries(relDir: string): Array<{ name: string; mtime: number }> {
    let abs: string;
    try {
      abs = this.ws.resolveSafe(relDir);
    } catch {
      return [];
    }
    if (!existsSync(abs)) return [];
    return readdirSync(abs, { withFileTypes: true })
      // 所有文件都占容量,不限扩展名;临时与隐藏文件除外。
      .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.includes('.tmp-'))
      .map((e) => ({ name: e.name, mtime: statSync(join(abs, e.name)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  }

  /** 常驻文件名,mtime 升序。 */
  residentFiles(): string[] {
    return this.entries('memo').map((x) => x.name);
  }

  /** active/ 文件名,mtime 升序。 */
  activeFiles(): string[] {
    return this.entries('memo/active').map((x) => x.name);
  }

  archivedCount(): number {
    return this.entries('memo/archived').length;
  }

  /** 常驻层的条目与年纪,mtime 升序。 */
  residentAges(now: number): MemoAge[] {
    return this.entries('memo').map(({ name, mtime }) => ({ name, ageDays: Math.max(0, (now - mtime) / DAY_MS) }));
  }

  /** active/ 的条目与年纪,mtime 升序。 */
  activeAges(now: number): MemoAge[] {
    return this.entries('memo/active').map(({ name, mtime }) => ({ name, ageDays: Math.max(0, (now - mtime) / DAY_MS) }));
  }

  /** 超过所在层半衰期的条目,常驻在前。只报哪条、多久没动;翻新还是沉下去由她判断。 */
  stale(now: number): Array<MemoAge & { tier: keyof typeof MEMORY_HALF_LIFE_DAYS }> {
    const pick = (ages: MemoAge[], tier: 'resident' | 'active'): Array<MemoAge & { tier: 'resident' | 'active' }> =>
      ages.filter((x) => x.ageDays > MEMORY_HALF_LIFE_DAYS[tier]).map((x) => ({ tier, ...x }));
    return [...pick(this.residentAges(now), 'resident'), ...pick(this.activeAges(now), 'active')];
  }

  /** 常驻层的全文,抬头带年纪注记。读不出来的条目照实说,不静默略过。 */
  residentBodies(now: number): string {
    return this.residentAges(now)
      .map(({ name, ageDays }) => {
        let body = '';
        try {
          body = this.ws.readFile(`memo/${name}`);
        } catch {
          body = '(读取失败)';
        }
        return `── memo/${name} ──(${ageNote(ageDays)})\n${body.trimEnd()}`;
      })
      .join('\n');
  }
}
