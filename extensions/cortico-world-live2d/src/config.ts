/**
 * `worlds.live2d` 的配置段、默认值与配置组。
 *
 * 目录型的键以 `Dir` 结尾,时长以 `Ms` 结尾;开关是段内的 `enabled`。渲染服务只绑回环地址,
 * 与部署的控制台同一纪律:形象页不该被局域网里的别人看见。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';
import type { WorldSection } from 'cortico/world.ts';

export interface Live2DConfigSection extends WorldSection {
  /** 渲染服务端口;只绑 127.0.0.1。占用时向上找,最多 5 个。 */
  port: number;
  /** 素材包目录(params/clips/vocab)。相对路径按 bot 代码包解析。 */
  packDir: string;
  /** 播放器库目录:pixi、Cubism Core、cubism4 三个文件所在的 js/ 的上一级。 */
  webDir: string;
  /** 模型目录,内含 `.model3.json`。 */
  modelDir: string;
  /** 模型入口文件名;留空 = 用目录里唯一的那个 `.model3.json`。 */
  modelFile: string;
  /**
   * 通道 → 本模型参数的逐条修正,写成 `通道=参数名`,逗号或换行分隔。
   *
   * 包里的 `suggests` 只是**建议**:这份模型的腮参数是拼音命名(`Paramguzui`),
   * 包里建议的 `ParamCheekPuff` 在这个模型上不存在。右侧留空表示这条通道明确不接。
   * 配置 schema 的数组只支持数字,所以这里用一条字符串。
   */
  paramMap: string;
  /**
   * 通道值的偏移,写成 `通道=数字`,逗号分隔。合成之后、裁剪之前加。
   *
   * 用在**包的约定与模型参数的约定不一致**的通道上。实测:包里 `EyeOpenLeft` 的单位写着
   * 「[-1,1],**0=平常睁眼**」,而模型的 `ParamEyeLOpen` 是「[0,1],**1=睁眼**」——
   * 直接把 0 写进去就是**眼睛全闭**。给这两条通道加 1,中性才落在"睁着"上。
   */
  paramOffset: string;
  /**
   * 直接钉住某几个模型参数的定值,写成 `参数名=数值`,逗号分隔,渲染端每帧写一次。
   *
   * 用在**不归通道管**的参数上。实测:模型的水印挂在 `Param137` 上,默认值 0 时三个水印
   * 图层的透明度是 1(看得见),钉成 1 才是透明——作者的使用说明称「水印按键默认打开,
   * 需在设置表情中关闭」,对应的就是这条参数,不必改模型文件。
   */
  paramOverrides: string;
  /** state 片段保持多久后开始淡出。 */
  stateHoldMs: number;
  /** 淡出时长。 */
  stateFadeMs: number;
  /** 措辞命中的表情保持多久;过期回到心情对应的表情。 */
  expressionHoldMs: number;
  /** 一段话说完后口型至少再动多久。 */
  speechTailMs: number;
  /** 按字数估的说话速度(毫秒/字);口型与"她在说话"的时长用它。 */
  speechMsPerChar: number;
  /**
   * 待机动作的幅度倍率。
   *
   * 呼吸、微晃、视线游移按绝对时间算,一直在;设 0 她就完全静止。这些动作让"她什么都没说"
   * 的时候也不是一张静止的图,台词与情绪基线才叠在活人身上。
   */
  idleAmount: number;
}

export const LIVE2D_DEFAULTS: Live2DConfigSection = {
  enabled: false,
  port: 7795,
  packDir: 'vtuber-pack',
  webDir: '',
  modelDir: '',
  modelFile: '',
  paramMap: '',
  paramOffset: '',
  paramOverrides: '',
  stateHoldMs: 25_000,
  stateFadeMs: 8_000,
  expressionHoldMs: 9_000,
  speechTailMs: 600,
  speechMsPerChar: 130,
  idleAmount: 1,
};

export const LIVE2D_CONFIG_GROUP: ConfigGroup = {
  id: 'live2d',
  owner: 'world:live2d',
  schema: {
    type: 'object',
    title: 'Live2D 形象',
    description: '形象由内部状态与她说的话共同驱动;这一页配素材与渲染服务。',
    properties: {
      port: {
        type: 'integer',
        title: '渲染端口',
        minimum: 1024,
        maximum: 65535,
        description: '只绑 127.0.0.1。端口被占用时向上找,最多 5 个。',
      },
      'packDir': {
        type: 'string',
        title: '素材包目录',
        description: '含 params.json / clips.json / vocab.json。相对路径按 bot 代码包解析。',
      },
      'webDir': {
        type: 'string',
        title: '播放器库目录',
        description: '里面有 js/pixi.min.js、js/live2dcubismcore.min.js、js/cubism4.min.js。',
      },
      'modelDir': {
        type: 'string',
        title: '模型目录',
        description: '含 .model3.json 的目录;模型体积大且多带分发限制,不进版本库。',
      },
      'paramMap': {
        type: 'string',
        title: '通道参数修正',
        description: '写成「通道=参数名」，多项用逗号分隔，例如 CheekPuff=Paramguzui。'
          + '包里的参数名只是建议；本模型的参数叫别的名字时在这里改，右侧留空表示这条通道不接。',
      },
      'modelFile': {
        type: 'string',
        title: '模型入口文件',
        description: '留空 = 用模型目录里唯一的那个 .model3.json;多于一个时必须点名。',
      },
      'paramOffset': {
        type: 'string',
        title: '通道值偏移',
        description: '写成「通道=数字」，多项用逗号分隔，例如 EyeOpenLeft=1。'
          + '用在包的约定与模型参数的约定不一致的通道上：包说「0=平常睁眼」，而模型的参数是「1=睁眼」，'
          + '不加偏移就写成了全闭。',
      },
      'paramOverrides': {
        type: 'string',
        title: '参数定值',
        description: '写成「参数名=数值」，多项用逗号分隔，渲染端每帧写一次，例如 Param137=1 关掉水印。'
          + '用在不由通道驱动的参数上。',
      },
      'stateHoldMs': {
        type: 'integer',
        title: '表情保持',
        minimum: 1000,
        maximum: 600_000,
        'x-suffix': 'ms',
        description: '一个表情/姿态压住多久后开始淡出。基线不参与淡出,它一直在。',
      },
      'stateFadeMs': {
        type: 'integer',
        title: '淡出时长',
        minimum: 0,
        maximum: 120_000,
        'x-suffix': 'ms',
        description: '淡出用的时间;太短会显得抽一下。',
      },
      'expressionHoldMs': {
        type: 'integer',
        title: '台词表情保持',
        minimum: 0,
        maximum: 600_000,
        'x-suffix': 'ms',
        description: '她的话命中表情指令后挂多久。过期回到心情对应的表情;写成 0 就是不按措辞切表情。',
      },
      'speechTailMs': {
        type: 'integer',
        title: '口型最短时长',
        minimum: 0,
        maximum: 60_000,
        'x-suffix': 'ms',
        description: '一段话说完后口型至少再动的时长,也是极短一句话的下限。',
      },
      'speechMsPerChar': {
        type: 'integer',
        title: '说话速度',
        minimum: 10,
        maximum: 2000,
        'x-suffix': 'ms/字',
        description: '按字数估这段话说出来要多久;口型动的时长按它算。没有语音合成,这是估算不是唇形同步。',
      },
      'idleAmount': {
        type: 'number',
        title: '待机动作幅度',
        minimum: 0,
        maximum: 3,
        description: '呼吸、微晃、视线游移的幅度倍率,一直在跑;设 0 她就完全静止。',
      },
    },
  },
};
