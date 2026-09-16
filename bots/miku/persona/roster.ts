/**
 * 从 `people/*.md` 的文件名与首行生成名册。首行约定为"当前的称呼 + 一句概括"。
 *
 * 名册是机械抽取的:她把人写成文件,前缀里自动出现一行。这样"记住一个人的名字"
 * 不依赖她每次都主动回忆,也不需要谁去维护一份索引。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 没有档案时返回空串,缺省文案由 MEMORY.md 提供。 */
export function buildRoster(memoryDir: string): string {
  const dir = join(memoryDir, 'people');
  if (!existsSync(dir)) return '';
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md')
      && !e.name.startsWith('.') && !e.name.includes('.tmp-'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  if (files.length === 0) return '';

  return files
    .map((file) => {
      let first = '';
      try {
        first = (readFileSync(join(dir, file), 'utf8').split(/\r?\n/, 1)[0] ?? '').trim();
      } catch {
        first = '(档案读取失败)';
      }
      return `- ${file.replace(/\.md$/i, '')} — ${first || '(档案第一行为空)'}`;
    })
    .join('\n');
}
