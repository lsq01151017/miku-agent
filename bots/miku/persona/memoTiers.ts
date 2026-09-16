/**
 * MEMORY 2 三级结构的只读视图 + 容量常量。照 `bots/corti-soulmate/persona/memoTiers.ts` 移植。
 *
 *   memo/顶层(常驻,前缀全文,容量 residentCap)
 *   memo/active/(前缀只列文件名,容量 activeCap)
 *   memo/archived/(前缀只显示数量,正文由她自己翻)
 *
 * 她使用通用文件工具(write_file/move_file/…)搬运条目;`memoCapGuard` 在写入时强制容量上限。
 * 本类只负责"各层现在有哪些文件",供前缀拼装与容量检查使用,不写盘。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { GitWorkspaceMemory } from '../../cormini/persona/memory.ts';

export interface MemoCaps {
  residentCap: number;
  activeCap: number;
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

  /** 常驻层的全文,各自带一行分隔抬头。读不出来的条目照实说,不静默略过。 */
  residentBodies(): string {
    return this.residentFiles()
      .map((name) => {
        let body = '';
        try {
          body = this.ws.readFile(`memo/${name}`);
        } catch {
          body = '(读取失败)';
        }
        return `── memo/${name} ──\n${body.trimEnd()}`;
      })
      .join('\n');
  }
}
