/** Test and script assembly entry point with LLM injection and typed module access. */
import { resolve } from 'node:path';
import type { ResponseClient } from 'cortico/core/generation.ts';
import type { Bot } from 'cortico/bot.ts';
import { createBot } from 'cortico/bot.ts';
import { loadDeployment, type LoadedConfig } from 'cortico/deploy.ts';
import { withWorlds } from 'cortico/world.ts';
import { BUILTIN_WORLDS } from 'cortico/worlds/index.ts';
import { TerminalWorld } from 'cortico/worlds/terminal/world.ts';
import type { CortiSoulmate } from './persona/index.ts';
import type { Dream } from './persona/subconscious/index.ts';
import packageDefinition, { type BotConfig } from './index.ts';

const HERE = resolve(import.meta.dirname);
const REPO_ROOT = resolve(HERE, '../..');

/** 包定义配上仓内全部 World 实现:与启动器同一条线,只是不装扩展。 */
const definition = withWorlds(packageDefinition, BUILTIN_WORLDS);

export type { BotConfig } from './index.ts';
export type { LoadedConfig } from 'cortico/deploy.ts';

/** 层 1+2 连同仓内各 World 的默认段:与 `loadConfig` 用的是同一份定义。 */
export const composeDefaults = (): BotConfig => definition.defaults();

/** 从 `botDir` 这份部署加载一次配置。 */
export function loadConfig(botDir: string): LoadedConfig<BotConfig> {
  return loadDeployment(definition, botDir, REPO_ROOT);
}

export interface AssembledBot extends Bot<BotConfig> {
  persona: CortiSoulmate;
  dream: Dream;
  terminalWorld: TerminalWorld | null;
}

export function assembleBot(
  loaded: LoadedConfig<BotConfig>,
  overrides?: { llm?: ResponseClient },
): AssembledBot {
  const bot = createBot(loaded, {
    ...definition,
    build: (l, worlds) => ({ ...definition.build(l, worlds), llm: overrides?.llm }),
  });
  const find = <T>(ctor: new (...args: never[]) => T): T | null =>
    (bot.assembly.mounted.find((m) => m instanceof ctor) as T | undefined) ?? null;
  const persona = bot.parts.persona as CortiSoulmate;
  return Object.assign(bot, {
    persona,
    dream: persona.dream,
    terminalWorld: find(TerminalWorld),
  });
}
