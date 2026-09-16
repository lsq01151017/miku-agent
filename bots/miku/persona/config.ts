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
