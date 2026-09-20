import type { ConfigGroup } from 'cortico/core/types.ts';
import { contextStageConfigGroup } from '../../cormini/persona/config.ts';

/**
 * 上下文阶段裁量。语义与 cormini / cortiv 共用一份声明,`id` 按 bot 取。
 */
export const MIKU_CONTEXT_CONFIG_GROUP = contextStageConfigGroup('miku');

/**
 * 情绪状态的时间尺度与开关。
 *
 * 词表分析是启发式推断(见 `emotion.ts`),所以要能被关掉:关掉后状态冻结在当前值,
 * 前缀仍带当前心情。默认值在 `index.ts` 的 `defaults()` 里,不写在 schema 上。
 */
export const MIKU_EMOTION_CONFIG_GROUP: ConfigGroup = {
  id: 'miku-emotion',
  owner: 'persona',
  schema: {
    type: 'object',
    title: '情绪',
    description:
      '六维连续值:每轮由词表更新,随时间向基线回落。只有离散心情进系统前缀,连续值在这里看。',
    properties: {
      'emotion.enabled': {
        type: 'boolean',
        title: '更新情绪',
        'x-hot': true,
        description: '关:状态冻结在当前值,前缀仍带当前心情。词表判断不可靠时关掉它。',
      },
      'emotion.maxStepPerTurn': {
        type: 'number',
        title: '单轮变化上限',
        minimum: 0.02,
        maximum: 1,
        multipleOf: 0.01,
        'x-hot': true,
        description:
          '一轮里单个维度的最大变化量。没有上限时,一句好话就能把心情顶到边界,状态失去分辨力。',
      },
      'emotion.decayScale': {
        type: 'number',
        title: '回落速度',
        minimum: 0.1,
        maximum: 10,
        multipleOf: 0.1,
        'x-suffix': '×',
        'x-hot': true,
        description: '各维度自带的回落半衰期乘以它。1 = 用维度自己的半衰期;越大回落越快。',
      },
      'emotion.patDailyGain': {
        type: 'number',
        title: '摸头每日数值上限',
        minimum: 0,
        maximum: 1,
        multipleOf: 0.05,
        'x-hot': true,
        description:
          '每天靠摸头最多能把心情抬多少(活力与羁绊按同一比例给)。写 0 就是摸头只舒服、不给数值。',
      },
    },
  },
};

/**
 * 文本工具协议。端点投递不了请求体的 `tools` 时,模型既不知道有哪些工具,也产不出结构化调用;
 * 打开后把工具表与调用写法写进前缀,端点侧把代码块翻成调用。
 *
 * 默认值在 `index.ts` 的 `defaults()` 里,不写在 schema 上:它取决于端点背后的模型,那属于部署。
 */
export const MIKU_TOOL_PROTOCOL_CONFIG_GROUP: ConfigGroup = {
  id: 'miku-tool-protocol',
  owner: 'persona',
  schema: {
    type: 'object',
    title: '工具协议',
    description: '端点不投递工具声明时,把工具表与调用写法写进前缀。',
    properties: {
      'toolProtocol.enabled': {
        type: 'boolean',
        title: '前缀带工具表',
        'x-hot': true,
        description: '端点能投递工具声明时关掉:重述既占前缀预算,又可能与实际声明不一致。',
      },
    },
  },
};

/**
 * memo 两层的容量。常驻层的全文每轮都在前缀里,active 层只列文件名,所以常驻要小得多。
 *
 * 容量是机械规则,所以硬拦而不是劝告:满了回执直接说清现状与出路(`move_file` 下沉一条)。
 * 默认值在 `index.ts` 的 `defaults()` 里,不写在 schema 上。
 */
export const MIKU_MEMO_CONFIG_GROUP: ConfigGroup = {
  id: 'miku-memo',
  owner: 'persona',
  schema: {
    type: 'object',
    title: '备忘容量',
    description: 'memo 常驻区与 active 区的条数上限;满了要靠 move_file 手动下沉。',
    properties: {
      'memo.residentCap': {
        type: 'integer',
        title: '常驻条数',
        minimum: 1,
        maximum: 50,
        multipleOf: 1,
        'x-suffix': '条',
        'x-hot': true,
        description: 'MEMORY 2 常驻区容量;这一层的全文每轮都进前缀,所以它是前缀预算的一部分。',
      },
      'memo.activeCap': {
        type: 'integer',
        title: 'active 条数',
        minimum: 1,
        maximum: 200,
        multipleOf: 1,
        'x-suffix': '条',
        'x-hot': true,
        description: 'memo/active/ 区容量(前缀只列文件名那一层)。',
      },
    },
  },
};

/**
 * 梦。交接之后从交接前的快照整理工作区,轮数上限管的是"整理到什么程度为止"。
 *
 * 它跑在当前端点上(fork 用活动端点的模型与窗口),所以预算与主 session 同一份。
 */
export const MIKU_DREAM_CONFIG_GROUP: ConfigGroup = {
  id: 'miku-dream',
  owner: 'persona',
  schema: {
    type: 'object',
    title: '梦',
    description: '交接后整理记忆的那一场;轮数上限决定它最多走多少步。',
    properties: {
      'dream.maxRounds': {
        type: 'integer',
        title: '轮数上限',
        minimum: 2,
        maximum: 60,
        multipleOf: 1,
        'x-suffix': '轮',
        'x-hot': true,
        description: '梦这一场的硬上限。整理是收束动作,轮数越多越容易把工作区改乱。',
      },
    },
  },
};
