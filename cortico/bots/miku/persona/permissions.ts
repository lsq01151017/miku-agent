/**
 * 写权限矩阵,机械硬拦。照 `bots/corti-soulmate/ persona/permissions.ts` 移植,区域按本包的工作区布局。
 *
 * 一句话纪律:清醒时写笔记、备忘和人物观察,只有梦重写宪法与遗忘。拒绝理由是一句话,
 * 会作为工具回执回到她手上——写清楚为什么、该走哪条路。
 *
 * 两条路径对应两个 session id;梦那一路的 session 由梦那一步声明。
 */
import { normalizeWorkspacePath } from '../../cormini/persona/memory.ts';

export type PersonaRole = 'main' | 'dream';

export const PERSONA_ROLES: readonly PersonaRole[] = ['main', 'dream'];

/** 未知 session id 一律按权限较窄的主意识处理。 */
export function asPersonaRole(sessionId: string): PersonaRole {
  return sessionId === 'dream' ? 'dream' : 'main';
}

export type FileOp = 'read' | 'write' | 'append' | 'rename' | 'delete';

export type AccessResult = { ok: true } | { ok: false; reason: string };

export type Zone = 'note' | 'memo' | 'people' | 'constitution' | 'other';

/** 区域按路径前缀判定。自建目录归 other,与 note/ 同权。 */
export function zoneOf(relPath: string): Zone {
  const p = normalizeWorkspacePath(relPath).toLowerCase();
  if (p === 'constitution.md') return 'constitution';
  if (p === 'note' || p.startsWith('note/')) return 'note';
  if (p === 'memo' || p.startsWith('memo/')) return 'memo';
  if (p === 'people' || p.startsWith('people/')) return 'people';
  return 'other';
}

const deny = (reason: string): AccessResult => ({ ok: false, reason });
const ALLOW: AccessResult = { ok: true };

export function checkAccess(role: PersonaRole, op: FileOp, relPath: string): AccessResult {
  if (op === 'read') return ALLOW; // 两条路径全区域可读

  const zone = zoneOf(relPath);

  if (role === 'main') {
    switch (zone) {
      case 'note':
      case 'memo':
      case 'other':
        if (op === 'write' || op === 'append' || op === 'rename') return ALLOW;
        return deny('Deleting is not permitted here; the dream clears the workspace. To relocate a file, use move_file.');
      case 'people':
        if (op === 'append') return ALLOW;
        if (op === 'write') return deny('people/ is append-only; use append_file.');
        return deny('people/ files cannot be renamed or deleted here; use append_file to add an observation.');
      case 'constitution':
        return deny('CONSTITUTION.md is read-only while awake; the dream revises it.');
    }
  }

  if (zone === 'constitution' && (op === 'rename' || op === 'delete')) {
    return deny('CONSTITUTION.md cannot be renamed or deleted; a revision edits its content.');
  }
  return ALLOW;
}
