/**
 * 包入口。默认导出是 `WorldDefinition`(加载器按 `cortico.kind === 'world'` 认它);
 * 命名导出是配置段与 World 类,测试和别的部署也能单独用。
 */
import type { WorldDefinition } from 'cortico/world.ts';
import { WORK_CONFIG_GROUP, WORK_DEFAULTS, WORK_PERMISSIONS, type WorkConfigSection, type WorkPermission } from './config.ts';
import { WORK } from './definition.ts';
import { WorkWorld } from './world.ts';

export { WORK } from './definition.ts';
export { WORK_CONFIG_GROUP, WORK_DEFAULTS, WORK_PERMISSIONS } from './config.ts';
export type { WorkConfigSection, WorkPermission } from './config.ts';
export { WorkWorld } from './world.ts';
export type { WorkWorldOptions } from './world.ts';

export default WORK satisfies WorldDefinition<WorkConfigSection>;
