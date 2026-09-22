import type { WorldDefinition } from 'cortico/world.ts';
import { WORK_DEFAULTS, type WorkConfigSection } from './config.ts';
import { WorkWorld } from './world.ts';

export const WORK: WorldDefinition<WorkConfigSection> = {
  id: 'work',
  label: '工作接口',
  defaults: () => ({ ...WORK_DEFAULTS }),
  create: (ctx) =>
    new WorkWorld({
      cfg: ctx.cfg,
      dataDir: ctx.dataDir,
    }),
};
