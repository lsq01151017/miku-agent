/**
 * `worlds.work` 的配置段、默认值与配置组。
 *
 * 权限是这一段的核心:它决定 work_run 把请求送到 DSH 时带哪种执行模式,也决定
 * 形象页权限按钮显示什么。状态落在这里而不是 DSH 侧,单一事实来源是本部署的配置。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';
import type { WorldSection } from 'cortico/world.ts';

/** 权限三态:问(越界动作弹审批)/ 放行(全放行)/ 关(工具本地拒)。 */
export type WorkPermission = 'ask' | 'trusted' | 'off';

export interface WorkConfigSection extends WorldSection {
  /** DSH 控制台地址,桥路由挂在它上面,例如 `http://127.0.0.1:43120`。 */
  dshUrl: string;
  /** 桥的共享令牌;与 DSH 侧插件里的常量一致,防别的本地进程乱敲。 */
  token: string;
  /** 当前权限态;形象页的权限按钮读写的就是它。 */
  permission: WorkPermission;
  /** 等 DSH 一轮跑完的上限;审批等待也算在内,所以要给得宽。 */
  timeoutMs: number;
}

export const WORK_DEFAULTS: WorkConfigSection = {
  enabled: false,
  dshUrl: 'http://127.0.0.1:43120',
  token: 'bridge-miku-work-7f3a',
  permission: 'ask',
  timeoutMs: 600_000,
};

export const WORK_PERMISSIONS: readonly WorkPermission[] = ['ask', 'trusted', 'off'];

export const WORK_CONFIG_GROUP: ConfigGroup = {
  id: 'work',
  owner: 'world:work',
  schema: {
    type: 'object',
    title: '工作接口',
    description: '她请 DSH 在这台机器上干活的通道;权限按钮也落在这里。',
    // 键是 cfg 里的点分路径(与 terminal 组同一规矩),控制台按它读写活配置。
    properties: {
      'worlds.work.dshUrl': {
        type: 'string',
        title: 'DSH 地址',
        description: '桥路由所在的控制台地址,例如 http://127.0.0.1:43120。',
      },
      'worlds.work.token': {
        type: 'string',
        title: '桥令牌',
        description: '与 DSH 侧插件约定的共享令牌;两边一致才放行。',
      },
      'worlds.work.permission': {
        type: 'string',
        enum: [...WORK_PERMISSIONS],
        title: '权限',
        description: 'ask=越出 DSH 工作区的动作要在 DSH 里点允许;trusted=全放行不弹卡;off=她请不动 DSH。',
      },
      'worlds.work.timeoutMs': {
        type: 'integer',
        title: '等待上限',
        minimum: 5_000,
        maximum: 3_600_000,
        'x-suffix': 'ms',
        description: '等 DSH 一轮跑完的上限;审批卡等人点的时间也算在内,别给太短。',
      },
    },
  },
};
