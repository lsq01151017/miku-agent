/** 部署配置的默认值归属、覆盖顺序、World 配置与密钥读取。 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDeployment } from '../../src/deploy.ts';
import { CORE_DEFAULTS } from '../../src/core/config.ts';
import { composeDefaults, loadConfig } from '../../bots/corti-soulmate/assemble.ts';
import { PERSONA_DEFAULTS } from '../../bots/corti-soulmate/persona/config.ts';

function withConfig(json: unknown): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bot-cfgtest-'));
  if (json !== undefined) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(json), 'utf8');
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("部署配置合并与默认值归属", () => {
  it("Core 默认配置不包含 Persona 参数", () => {
    expect(CORE_DEFAULTS.batching).toHaveProperty('quietGapMs');
    expect(CORE_DEFAULTS.context.keepPastThinking).toBe(true);
    // Persona 的阶段预算、轮数和作息不属于 Core 默认值。
    for (const key of ['models', 'loop', 'memo', 'tick', 'dream']) {
      expect(CORE_DEFAULTS, `core 不该持有 ${key}`).not.toHaveProperty(key);
    }
  });

  it('composeDefaults 把三方的默认值合到一起,来源可追', () => {
    const cfg = composeDefaults();
    expect(cfg.batching).toEqual(CORE_DEFAULTS.batching);
    // Persona 可提供自有参数及 Core 参数的建议值。
    expect(PERSONA_DEFAULTS).not.toHaveProperty('models');
    expect(cfg.providers.deepseek.spec?.model).toBe('deepseek-flash');
    expect(cfg.memo).toEqual(PERSONA_DEFAULTS.memo);
    expect(cfg.context.maxTokens).toBe(PERSONA_DEFAULTS.context.maxTokens);
    // Persona 设置阶段预算，模型容量由 provider 配置决定。
    expect(cfg.context.keepPastThinking).toBe(CORE_DEFAULTS.context.keepPastThinking);
    // World 默认值住在各自的世界段里,不是顶层配置。
    expect(cfg.worlds.terminal.pin).toBe('');
  });

  it("部署 config.json 覆盖 Persona 建议值", () => {
    const { dir, cleanup } = withConfig({ context: { maxTokens: 32000 }, memo: { residentCap: 3 } });
    try {
      const { config } = loadConfig(dir);
      expect(config.context.maxTokens).toBe(32000);
      expect(config.memo.residentCap).toBe(3);
      expect(config.context.keepRatio).toBe(PERSONA_DEFAULTS.context.keepRatio);
    } finally { cleanup(); }
  });

  it('密钥按名字取:进程环境优先,其次 .env(core 不认识具体名字)', () => {
    const { dir, cleanup } = withConfig(undefined);
    try {
      writeFileSync(join(dir, '.env'), 'SOME_MODULE_KEY=from-file\n', 'utf8');
      const loaded = loadConfig(dir);
      expect(loaded.secret('SOME_MODULE_KEY')).toBe('from-file');
      expect(loaded.secret('从没配过的名字')).toBe('');
      process.env.SOME_MODULE_KEY = 'from-env';
      try {
        expect(loadConfig(dir).secret('SOME_MODULE_KEY')).toBe('from-env');
      } finally {
        delete process.env.SOME_MODULE_KEY;
      }
    } finally { cleanup(); }
  });

  it("密钥使用进程环境或部署 .env，不读取仓库根 .env", () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-reporoot-'));
    const botDir = join(root, 'bots', 'x');
    mkdirSync(botDir, { recursive: true });
    writeFileSync(join(root, '.env'), 'SHARED_KEY=from-repo-root\n', 'utf8');
    try {
      expect(loadDeployment({ defaults: composeDefaults }, botDir, root).secret('SHARED_KEY')).toBe('');
      writeFileSync(join(botDir, '.env'), 'SHARED_KEY=from-bot-dir\n', 'utf8');
      expect(loadDeployment({ defaults: composeDefaults }, botDir, root).secret('SHARED_KEY')).toBe('from-bot-dir');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('loadConfig:段里的数组整段替换,不与默认值合并', () => {
  /** 用一个自带数组段的最小定义:这条语义不依赖任何一个仓内 World。 */
  const definition = {
    defaults: () => ({
      ...composeDefaults(),
      worlds: { demo: { enabled: false, roster: [] as Array<{ id: number; enabled: boolean }> } },
    }),
  };
  const load = (json: unknown): { dir: string; cleanup: () => void; config: { worlds: { demo: { enabled: boolean; roster: Array<{ id: number; enabled: boolean }> } } } } => {
    const { dir, cleanup } = withConfig(json);
    return { dir, cleanup, config: loadDeployment(definition as never, dir, dir).config as never };
  };

  it('无config.json → 默认空数组', () => {
    const site = load(undefined);
    try {
      expect(site.config.worlds.demo.roster).toEqual([]);
    } finally { site.cleanup(); }
  });

  it('config.json 写的{id,enabled}[]整段替换默认空数组(含 disabled 条目)', () => {
    const site = load({
      worlds: { demo: { roster: [{ id: 111, enabled: false }, { id: 222, enabled: true }] } },
    });
    try {
      expect(site.config.worlds.demo.roster).toEqual([{ id: 111, enabled: false }, { id: 222, enabled: true }]);
    } finally { site.cleanup(); }
  });

  it('每次加载都拿到独立配置树,不会把运行时热改泄漏进默认值', () => {
    const first = load({ worlds: { demo: { roster: [{ id: 555, enabled: true }] } } });
    const second = load(undefined);
    try {
      first.config.worlds.demo.enabled = true;
      expect(first.config.worlds.demo.roster).toEqual([{ id: 555, enabled: true }]);
      expect(second.config.worlds.demo.roster).toEqual([]);
      expect(second.config.worlds.demo.enabled).toBe(false);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });
});
