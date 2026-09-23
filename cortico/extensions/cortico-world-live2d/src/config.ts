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
  /**
   * 控制台地址,例如 `http://127.0.0.1:18790`。
   *
   * 填了它,形象页的输入就能转到控制台的终端通道:页面连本 World 的 `/chat`,由这里转一手。
   * 页面因此只有一个来源,不必知道控制台在哪个端口。留空就没有这一路。
   */
  consoleUrl: string;
  /**
   * 外部 Agent 的地址,例如 `http://127.0.0.1:8790`。
   *
   * 填了它,形象页的输入就送到那个 Agent,它吐回来的文本当字幕显示,同时驱动她的台词片段、
   * 表情、口型与说话时长。约定:`POST <agentUrl>/agent/chat` JSON `{ message }`;回包是 SSE
   * (`data:` 每段一段文本或 JSON)也行,一次性 JSON/纯文本也行。留空就只走控制台那一路。
   */
  agentUrl: string;
  /**
   * TTS 服务地址(GPT-SoVITS api_v2),例如 `http://127.0.0.1:9880`。
   *
   * 填了它,`POST /voice/say` 就把一段文本合成成语音:音频经 `/state` 帧交给页面播放,
   * 口型跟真实振幅走。留空 = 语音关着,口型回退到按时长的振荡。
   */
  ttsUrl: string;
  /**
   * 她的回复出不出声。关了就不调 TTS(字幕照常,口型回退到按时长的振荡),形象页
   * 对话框的「声音」按钮与控制台这一页改的是同一个值。
   */
  voiceEnabled: boolean;
  /** 参考音频在 TTS 服务那台机器上的路径(api_v2 的 `ref_audio_path`);音色从这段参考来。 */
  ttsRefAudioFile: string;
  /** 参考音频说的话(api_v2 的 `prompt_text`),与参考音频逐字对应。 */
  ttsPromptText: string;
  /** 参考音频的语言(api_v2 的 `prompt_lang`,语言码如 `ja`/`zh`)。 */
  ttsPromptLang: string;
  /**
   * 合成文本的默认语言(api_v2 的 `text_lang`);`/voice/say` 请求里可用 `lang` 覆盖。
   * `auto` 让服务端按片判语言——她的回复中日混说都对;钉死一种语言时,另一种语言的
   * 汉字会被按钉死的语言念出来(api_v2 的既定行为)。
   */
  ttsTextLang: string;
  /**
   * 语音翻译服务地址,例如 `http://127.0.0.1:9882`。填了它,每段语音先经
   * `POST <地址>/translate`(JSON `{ text }` 回 `{ text }`)翻成目标语言再合成;
   * 字幕不受影响,始终显示原文。翻不出来就用原文合成,不静音。
   */
  ttsTranslateUrl: string;
  /** 一段语音至少这么多字才合成;不足时与后面的句子合并(省一次合成调用)。 */
  voiceSegmentMinChars: number;
  /** 一段语音至多这么多字;到了就切,从上限回溯找句界。 */
  voiceSegmentMaxChars: number;
  /**
   * 语音转写服务地址,例如 `http://127.0.0.1:9881`。
   *
   * 填了它,形象页的输入区多一枚「按住说」:按住录音,松开把音频经本 World 转给服务,
   * 转写回来的文本与打字输入走同一条路。留空 = 没有这一枚。
   */
  asrUrl: string;
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
  expressionHoldMs: 15_000,
  speechTailMs: 600,
  speechMsPerChar: 130,
  idleAmount: 1,
  consoleUrl: '',
  agentUrl: '',
  ttsUrl: '',
  voiceEnabled: true,
  ttsRefAudioFile: '',
  ttsPromptText: '',
  ttsPromptLang: '',
  ttsTextLang: 'auto',
  ttsTranslateUrl: '',
  voiceSegmentMinChars: 8,
  voiceSegmentMaxChars: 120,
  asrUrl: '',
};

export const LIVE2D_CONFIG_GROUP: ConfigGroup = {
  id: 'live2d',
  owner: 'world:live2d',
  schema: {
    type: 'object',
    title: 'Live2D 形象',
    description: '形象由内部状态与她说的话共同驱动;这一页配素材与渲染服务。',
    // 键是 cfg 里的点分路径(与 terminal 组同一规矩),控制台按它读写活配置。
    properties: {
      'worlds.live2d.port': {
        type: 'integer',
        title: '渲染端口',
        minimum: 1024,
        maximum: 65535,
        description: '只绑 127.0.0.1。端口被占用时向上找,最多 5 个。',
      },
      'worlds.live2d.packDir': {
        type: 'string',
        title: '素材包目录',
        description: '含 params.json / clips.json / vocab.json。相对路径按 bot 代码包解析。',
      },
      'worlds.live2d.webDir': {
        type: 'string',
        title: '播放器库目录',
        description: '里面有 js/pixi.min.js、js/live2dcubismcore.min.js、js/cubism4.min.js。',
      },
      'worlds.live2d.modelDir': {
        type: 'string',
        title: '模型目录',
        description: '含 .model3.json 的目录;模型体积大且多带分发限制,不进版本库。',
      },
      'worlds.live2d.paramMap': {
        type: 'string',
        title: '通道参数修正',
        description: '写成「通道=参数名」，多项用逗号分隔，例如 CheekPuff=Paramguzui。'
          + '包里的参数名只是建议；本模型的参数叫别的名字时在这里改，右侧留空表示这条通道不接。',
      },
      'worlds.live2d.modelFile': {
        type: 'string',
        title: '模型入口文件',
        description: '留空 = 用模型目录里唯一的那个 .model3.json;多于一个时必须点名。',
      },
      'worlds.live2d.paramOffset': {
        type: 'string',
        title: '通道值偏移',
        description: '写成「通道=数字」，多项用逗号分隔，例如 EyeOpenLeft=1。'
          + '用在包的约定与模型参数的约定不一致的通道上：包说「0=平常睁眼」，而模型的参数是「1=睁眼」，'
          + '不加偏移就写成了全闭。',
      },
      'worlds.live2d.paramOverrides': {
        type: 'string',
        title: '参数定值',
        description: '写成「参数名=数值」，多项用逗号分隔，渲染端每帧写一次，例如 Param137=1 关掉水印。'
          + '用在不由通道驱动的参数上。',
      },
      'worlds.live2d.stateHoldMs': {
        type: 'integer',
        title: '表情保持',
        minimum: 1000,
        maximum: 600_000,
        'x-suffix': 'ms',
        description: '一个表情/姿态压住多久后开始淡出。基线不参与淡出,它一直在。',
      },
      'worlds.live2d.stateFadeMs': {
        type: 'integer',
        title: '淡出时长',
        minimum: 0,
        maximum: 120_000,
        'x-suffix': 'ms',
        description: '淡出用的时间;太短会显得抽一下。',
      },
      'worlds.live2d.expressionHoldMs': {
        type: 'integer',
        title: '台词表情保持',
        minimum: 0,
        maximum: 600_000,
        'x-suffix': 'ms',
        description: '她的话命中表情指令后挂多久。过期回到心情对应的表情;写成 0 就是不按措辞切表情。',
      },
      'worlds.live2d.speechTailMs': {
        type: 'integer',
        title: '口型最短时长',
        minimum: 0,
        maximum: 60_000,
        'x-suffix': 'ms',
        description: '一段话说完后口型至少再动的时长,也是极短一句话的下限。',
      },
      'worlds.live2d.speechMsPerChar': {
        type: 'integer',
        title: '说话速度',
        minimum: 10,
        maximum: 2000,
        'x-suffix': 'ms/字',
        description: '按字数估这段话说出来要多久;口型动的时长按它算。没有语音合成,这是估算不是唇形同步。',
      },
      'worlds.live2d.idleAmount': {
        type: 'number',
        title: '待机动作幅度',
        minimum: 0,
        maximum: 3,
        description: '呼吸、微晃、视线游移的幅度倍率,一直在跑;设 0 她就完全静止。',
      },
      'worlds.live2d.consoleUrl': {
        type: 'string',
        title: '控制台地址',
        description: '例如 http://127.0.0.1:18790。填了它,形象页的输入就转到控制台的终端通道;'
          + '留空则不走这一路。',
      },
      'worlds.live2d.agentUrl': {
        type: 'string',
        title: '外部 Agent 地址',
        description: '例如 http://127.0.0.1:8790。填了它,形象页的输入就送给这个 Agent,'
          + '它吐回来的文本当字幕显示并驱动她的动作。约定:POST <地址>/agent/chat,JSON { message }。',
      },
      'worlds.live2d.ttsUrl': {
        type: 'string',
        title: 'TTS 服务地址',
        description: '例如 http://127.0.0.1:9880(GPT-SoVITS api_v2)。填了它,POST /voice/say '
          + '能把文本合成成语音,页面播放时口型跟真实振幅走;留空则口型按说话时长估算。',
      },
      'worlds.live2d.voiceEnabled': {
        type: 'boolean',
        title: '她的回复出声',
        description: '开着:回复按句界合成语音,页面播放,口型跟真实振幅。关了:不调 TTS,'
          + '只有字幕,口型按说话时长估算。形象页对话框的「声音」按钮改的就是这个值。',
      },
      'worlds.live2d.ttsRefAudioFile': {
        type: 'string',
        title: '参考音频路径',
        description: '参考音频在 TTS 服务那台机器上的路径(api_v2 的 ref_audio_path),音色从这段参考来。',
      },
      'worlds.live2d.ttsPromptText': {
        type: 'string',
        title: '参考音频文本',
        description: '参考音频说的话(api_v2 的 prompt_text),与参考音频逐字对应。',
      },
      'worlds.live2d.ttsPromptLang': {
        type: 'string',
        title: '参考音频语言',
        description: '参考音频的语言(api_v2 的 prompt_lang),语言码如 ja/zh。',
      },
      'worlds.live2d.ttsTextLang': {
        type: 'string',
        title: '合成文本语言',
        description: '合成文本的默认语言(api_v2 的 text_lang),语言码如 auto/zh/ja;'
          + 'auto 按片判语言,中日混说都对。/voice/say 请求里可用 lang 覆盖。',
      },
      'worlds.live2d.ttsTranslateUrl': {
        type: 'string',
        title: '语音翻译服务地址',
        description: '例如 http://127.0.0.1:9882。填了它,每段语音先翻成目标语言再合成,'
          + '字幕不受影响;翻不出来就用原文合成。约定:POST <地址>/translate,'
          + 'JSON { text } 回 { text }。',
      },
      'worlds.live2d.voiceSegmentMinChars': {
        type: 'integer',
        title: '语音分段下限',
        minimum: 1,
        maximum: 500,
        'x-suffix': '字',
        description: '她的回复按句界切成一段一段合成;不足这个字数的句子与后面合并,省一次合成调用。',
      },
      'worlds.live2d.voiceSegmentMaxChars': {
        type: 'integer',
        title: '语音分段上限',
        minimum: 16,
        maximum: 2000,
        'x-suffix': '字',
        description: '一段最多这么多字;到了就切,从上限回溯找句界。小段首响应快,大段合成调用少。',
      },
      'worlds.live2d.asrUrl': {
        type: 'string',
        title: '语音转写服务地址',
        description: '例如 http://127.0.0.1:9881。填了它,形象页的输入区多一枚「按住说」:'
          + '按住录音,松开转写成文本,与打字输入走同一条路。约定:POST <地址>/asr,'
          + '请求体是原始音频,回 JSON { text }。',
      },
    },
  },
};
