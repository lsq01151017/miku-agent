/**
 * `forget`:操作员明确要求忘记时,当场把它从记忆里删掉。
 *
 * 这是矩阵里唯一一处越权,来源是**指令本身**而不是角色:清醒时不许删文件(整理归梦),
 * 但"请忘掉这件事"是操作员的明确要求,等梦来清就等于没生效。
 *
 * 两道动作缺一不可:文件当场删除(检索、列表、读取立刻看不到),再请求重建系统前缀
 * (常驻内容下一批起不再发出)。同一批里已经发出去的前缀收不回来——那是已经说过的话。
 */
import type { ToolDef } from 'cortico/core/types.ts';
import { WorkspaceError, type GitWorkspaceMemory } from '../../cormini/persona/memory.ts';

/** 宪法不在可忘之列:她的身份不是一条可以按需抹掉的信息。 */
const PROTECTED = 'constitution.md';

export interface ForgetDeps {
  ws: GitWorkspaceMemory;
  /** 重建系统前缀;由 Persona 接到 `CoreApi.reloadSystemPrefix`。 */
  reloadPrefix: () => void;
}

export function forgetTool(deps: ForgetDeps): ToolDef {
  const { ws } = deps;
  return {
    name: 'forget',
    description: 'Erase one memory file for good, right now. Call this only when the operator explicitly asks you to '
      + 'forget something; it cannot be undone. Deleting on your own initiative is not permitted — organizing and '
      + 'clearing are the dream\'s job.',
    tags: ['write'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to erase, relative to your workspace.' },
        reason: { type: 'string', description: 'What the operator asked you to forget, in their words.' },
      },
      required: ['path'],
    },
    handler: async (args) => {
      const path = String(args.path ?? '');
      if (!path) return '[forget failed] path is required';
      let rel: string;
      try {
        rel = ws.normalize(path);
      } catch (error) {
        return `[forget failed] ${error instanceof WorkspaceError ? error.message : String(error)}`;
      }
      if (rel.toLowerCase() === PROTECTED) {
        return '[forget failed] CONSTITUTION.md is who you are, not a memory of something; it is not erasable.';
      }
      if (!ws.exists(rel)) return `[forget failed] no such file: ${rel}`;
      if (ws.isDir(rel)) return `[forget failed] ${rel} is a folder; forget its files one by one.`;
      try {
        ws.deleteFile(rel);
      } catch (error) {
        return `[forget failed] ${error instanceof WorkspaceError ? error.message : String(error)}`;
      }
      deps.reloadPrefix();
      return `[forgotten] ${rel} — deleted from the workspace and the system prefix is being rebuilt, so it is gone `
        + 'from here on. Its earlier version still exists in the workspace Git history.';
    },
  };
}
