/**
 * memo 容量守门与 `move_file`。照 `bots/corti-soulmate/persona/tools.ts` 移植,
 * 与本包 `permissions.ts` 的分区一致。
 */
import type { ToolDef } from 'cortico/core/types.ts';
import { WorkspaceError, type GitWorkspaceMemory } from '../../cormini/persona/memory.ts';
import type { MemoTiers } from './memoTiers.ts';

const quote = (names: string[]): string =>
  names.length ? names.map((name) => `"${name}"`).join(', ') : '(none)';

/** memo 三层归属(只认一级文件);别的路径返回 null。 */
function memoTierOf(ws: GitWorkspaceMemory, rel: string): 'resident' | 'active' | 'archived' | null {
  const path = ws.normalize(rel);
  if (/^memo\/active\/[^/]+$/i.test(path)) return 'active';
  if (/^memo\/archived\/[^/]+$/i.test(path)) return 'archived';
  if (/^memo\/[^/]+$/i.test(path)) return 'resident';
  return null;
}

/**
 * 容量守门:向已满的层**新建**文件时硬拦。
 *
 * 只拦"新增一个文件":覆写已存在的、以及同层内改名都不增加数量,一律放行。
 * 满时不自动下沉——那是在替她做取舍;回执说清现状,并指路 `move_file`。
 */
export function memoCapGuard(
  ws: GitWorkspaceMemory,
  memo: MemoTiers,
  destRel: string,
  fromRel?: string,
): string | null {
  const tier = memoTierOf(ws, destRel);
  const fromTier = fromRel ? memoTierOf(ws, fromRel) : null;
  if (tier === 'resident' && !ws.exists(destRel) && fromTier !== 'resident') {
    const residents = memo.residentFiles();
    if (residents.length >= memo.caps.residentCap) {
      return `memo/ (resident, shown in full every prefix) is full (${residents.length}/${memo.caps.residentCap}). `
        + `Move one down to memo/active/ with move_file first, then retry. Current residents: ${quote(residents)}.`;
    }
  }
  if (tier === 'active' && !ws.exists(destRel) && fromTier !== 'active') {
    const actives = memo.activeFiles();
    if (actives.length >= memo.caps.activeCap) {
      return `memo/active/ is full (${actives.length}/${memo.caps.activeCap}). `
        + `Move one down to memo/archived/ with move_file first, then retry. Current active/: ${quote(actives)}.`;
    }
  }
  return null;
}

export interface MoveFileDeps {
  ws: GitWorkspaceMemory;
  /** 写准入(同 Persona 的 writeGuard):返回理由就拒绝。 */
  guard: (op: 'rename' | 'write', path: string, role: string) => string | null;
  capGuard: (to: string, from: string) => string | null;
}

/** 工作区内移动或改名。memo 层间搬运走它;父目录按需创建。 */
export function moveFileTool(deps: MoveFileDeps): ToolDef {
  const { ws } = deps;
  return {
    name: 'move_file',
    description: 'Move or rename a file within your workspace. Use it to shift a memo between tiers when one is full '
      + '(memo/ → memo/active/ → memo/archived/); parent folders are created as needed.',
    tags: ['write'],
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Current path, relative to your workspace.' },
        to: { type: 'string', description: 'New path, relative to your workspace.' },
      },
      required: ['from', 'to'],
    },
    handler: async (args, ctx) => {
      const from = String(args.from ?? '');
      const to = String(args.to ?? '');
      if (!from || !to) return '[move failed] from 与 to 都要给';
      const denied = deps.guard('rename', from, ctx.role)
        ?? deps.guard('write', to, ctx.role)
        ?? deps.capGuard(to, from);
      if (denied) return `[move failed] ${denied}`;
      try {
        ws.renameFile(from, to);
      } catch (error) {
        if (error instanceof WorkspaceError) return `[move failed] ${error.message}`;
        return `[move failed] ${error instanceof Error ? error.message : String(error)}`;
      }
      return `[moved] ${ws.normalize(from)} → ${ws.normalize(to)}`;
    },
  };
}
