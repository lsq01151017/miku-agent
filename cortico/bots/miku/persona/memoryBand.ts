/**
 * MEMORY 段各占位符此刻的值:地图、人物名册、memo 三层、当前时间。
 * 引导语与空态措辞在 `MEMORY.md` 里;这里只算活数据。
 *
 * 地图自己列,不用 `GitWorkspaceMemory.treeShallow()`:那个把根标签写死成 `persona/`,
 * 而本包的工作区叫 `workspace/`——前缀里出现一个不存在的目录名就是错的。
 */
import { readdirSync } from 'node:fs';
import type { PromptVarDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { GitWorkspaceMemory } from '../../cormini/persona/memory.ts';
import { ageNote, type MemoTiers } from './memoTiers.ts';
import { buildRoster } from './roster.ts';

/** 控制台展示的模板变量说明。 */
export const MEMORY_VAR_DECLS: readonly PromptVarDecl[] = [
  { name: 'memory.tree', description: '工作区最外层条目;目录带 /。', multiline: true },
  { name: 'memory.roster', description: '人物名册:每行「文件名的称呼 — 档案第一行」。', multiline: true },
  { name: 'memory.memoResident', description: '常驻 memo 的全文,每条抬头带它多少天没动。', multiline: true },
  { name: 'memory.memoActive', description: 'memo/active/ 里的文件名,各带多少天没动。' },
  { name: 'memory.memoStale', description: '超过所在层半衰期的条目;翻新还是沉下去由她判断。' },
  { name: 'memory.memoArchivedCount', description: 'memo/archived/ 里的归档条数。' },
  { name: 'memory.emergences', description: '最近几场梦的浮现,每行一条。', multiline: true },
  { name: 'memory.now', description: '前缀组装那一刻的时间。**在两次前缀重建之间是冻结的**。' },
  { name: 'memory.timezone', description: '时区名。' },
];

/** 最外层条目,目录在前;子目录的内容靠 list_files 下钻,不进常驻前缀。 */
function workspaceMap(ws: GitWorkspaceMemory): string {
  return readdirSync(ws.memoryDir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && !entry.name.includes('.tmp-'))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .join('\n');
}

export function memoryVars(
  ws: GitWorkspaceMemory,
  memo: MemoTiers,
  ctx: { now: Date; timezone: string },
  /** 最近几场梦的浮现(MEMORY 3)。 */
  emergences: readonly string[],
): Record<string, string> {
  const now = ctx.now.getTime();
  return {
    'memory.tree': workspaceMap(ws),
    'memory.roster': buildRoster(ws.memoryDir),
    'memory.memoResident': memo.residentBodies(now),
    'memory.memoActive': memo.activeAges(now).map(({ name, ageDays }) => `「${name}」(${ageNote(ageDays)})`).join('、'),
    'memory.memoStale': memo
      .stale(now)
      .map(({ tier, name, ageDays }) => `「${name}」(${ageNote(ageDays)},${tier === 'resident' ? '常驻' : 'active'})`)
      .join('、'),
    'memory.memoArchivedCount': String(memo.archivedCount()),
    'memory.emergences': emergences.map((text) => `- ${text}`).join('\n'),
    'memory.now': nowIso(ctx.timezone, ctx.now),
    'memory.timezone': ctx.timezone,
  };
}
