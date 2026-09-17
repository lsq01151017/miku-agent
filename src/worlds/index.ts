/**
 * 仓内 World 目录。启动器把它与扩展装进来的 World 并成一张表,经 `withWorlds()` 交给 bot 定义;
 * bot 只声明它为之设计的渠道,哪些真挂由部署的 `worlds.<id>.enabled` 决定。
 *
 * 仓内只留终端:QQ、B站直播、Minecraft、联网搜索四个 World 已按部署需要删除,
 * 渠道本身仍是扩展点——要加回来就是写一个 `cortico-world-*` 包(见 `templates/extension/world/`)。
 * `console-fixture` 是控制台边界的验收件,不在这里。
 */
import type { WorldDefinition, WorldSection } from '../world.ts';
import { TERMINAL } from './terminal/definition.ts';

export const BUILTIN_WORLDS: readonly WorldDefinition<WorldSection>[] = [
  TERMINAL,
] as WorldDefinition<WorldSection>[];
