/**
 * 从 `people/*.md` 的文件名与首段生成名册。约定是"称呼 + 一句概括"。
 *
 * 概括取第一条既不是空行、也不是 Markdown 标题的正文——真实模型习惯先写一行 `# 名字` 再写内容,
 * 机械层照它的写法取,而不是要求它迁就抽取器的形状。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 首个非空且非标题的行;没有就给空串。 */
function summaryOf(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    return trimmed;
  }
  return '';
}

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
      let summary = '';
      try {
        summary = summaryOf(readFileSync(join(dir, file), 'utf8'));
      } catch {
        summary = '(档案读取失败)';
      }
      return `- ${file.replace(/\.md$/i, '')} — ${summary || '(档案里没有正文)'}`;
    })
    .join('\n');
}
