/** 端点与渠道选择归部署;这个包只给出人格身份与自己的默认值。 */
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { BotDefinition, BotParts } from 'cortico/bot.ts';
import type { CoreConfig, World } from 'cortico/core/types.ts';
import type { LoadedConfig } from 'cortico/deploy.ts';
import { CORE_DEFAULTS } from 'cortico/core/config.ts';
import type { WorldDeclaration } from 'cortico/world.ts';
import type { TerminalConfigSection } from 'cortico/worlds/terminal/config.ts';
import { MIKU_CONTEXT_DEFAULTS, Miku, type EmotionPolicy, type ToolProtocolPolicy } from './persona/persona.ts';
import {
  MIKU_CONTEXT_CONFIG_GROUP,
  MIKU_DREAM_CONFIG_GROUP,
  MIKU_EMOTION_CONFIG_GROUP,
  MIKU_MEMO_CONFIG_GROUP,
  MIKU_TOOL_PROTOCOL_CONFIG_GROUP,
} from './persona/config.ts';
import type { MemoCaps } from './persona/memoTiers.ts';
import type { Values, Mood } from './persona/emotion.ts';
import type { DreamPolicy } from './persona/persona.ts';
import type { ContextStagePolicy } from '../cormini/persona/persona.ts';

const HERE = resolve(import.meta.dirname);

/** 存在方式自述的源文件;控制台「Persona」页可编辑,重载前缀即生效。 */
const ORIENTATION_FILE = resolve(HERE, 'persona/ORIENTATION.md');

/**
 * 这个 Persona 为之设计的渠道:终端与自己的形象。别的平台不声明——渠道是扩展点,
 * 要接哪个就写一个 World 包,再把它的 id 加到这里。
 */
const DECLARES: readonly WorldDeclaration[] = ['terminal', 'live2d'];

/**
 * 形象层拿到内部状态的入口。
 *
 * World 扩展的形状归它自己的包,人格包只知道"有个 live2d 渠道,它可能收内部状态",
 * 所以这里按可选方法问一句:扩展没装或没这个方法是空转,不影响挂载。
 * 连续值给通道基线,离散心情给表情层。
 */
function emotionSink(worlds: readonly World[]): (values: Values, mood: Mood) => void {
  const live2d = worlds.find((world) => world.id === 'live2d') as
    | { setInternalState?: (values: Values, mood: Mood) => void }
    | undefined;
  return (values, mood) => live2d?.setInternalState?.(values, mood);
}

/**
 * 操作员说的话原样交给形象层。
 *
 * 「张嘴」「点点头」这类吩咐是**动作指令**,词表与片段都在形象层那边,所以人格包不解释它们,
 * 只把话递过去。同样是可选方法:扩展没装或没实现就是空转。
 */
function performSink(worlds: readonly World[]): (text: string) => void {
  const live2d = worlds.find((world) => world.id === 'live2d') as
    | { perform?: (text: string) => void }
    | undefined;
  return (text) => live2d?.perform?.(text);
}

export interface MikuConfig extends CoreConfig {
  /** 阶段长度四项归Persona,摘思维链归 core;同住 context 段。 */
  context: CoreConfig['context'] & ContextStagePolicy;
  rounds: { soft: number; hard: number };
  emotion: EmotionPolicy;
  toolProtocol: ToolProtocolPolicy;
  /** memo 两层的容量上限。 */
  memo: MemoCaps;
  /** 梦的轮数上限。 */
  dream: DreamPolicy;
  tick: {
    /** null disables baseline wakeups. */
    intervalMinutes: number | null;
  };
  worlds: {
    terminal: TerminalConfigSection;
  };
}

function build(loaded: LoadedConfig<MikuConfig>, worlds: World[]): BotParts<MikuConfig> {
  const cfg = loaded.config;

  const persona = new Miku({
    memoryDir: loaded.memoryDir,
    context: () => cfg.context,
    rounds: { ...cfg.rounds },
    seedConstitution: readFileSync(resolve(HERE, 'persona/CONSTITUTION.seed.md'), 'utf8'),
    worlds,
    orientationFile: ORIENTATION_FILE,
    // 部署侧的自述覆盖:存在就用它,控制台保存也落到那边。
    orientationOverrideFile: resolve(loaded.rootDir, 'prompts', 'ORIENTATION.md'),
    // 首轮对话是部署者自己写的,与 ORIENTATION 覆盖同住 prompts/;代码包不带。
    firstTurnDir: resolve(loaded.rootDir, 'prompts'),
    // 现读:控制台上改完即生效,不用重启。
    emotion: () => cfg.emotion,
    toolProtocol: () => cfg.toolProtocol,
    memo: () => cfg.memo,
    dream: () => cfg.dream,
    // 梦算自己的预算时要和 core 用同一份:留着思维链就多花 token。
    keepPastThinking: () => cfg.context.keepPastThinking,
    timezone: () => cfg.timezone,
    onEmotion: emotionSink(worlds),
    onOperatorText: performSink(worlds),
    tickDelayMs: () =>
      cfg.tick.intervalMinutes === null ? null : cfg.tick.intervalMinutes * 60_000,
  });

  return {
    persona,
    onStart: () => {
      persona.startRhythm();
    },
    onStop: () => {
      persona.stopRhythm();
    },
    console: {
      configGroups: [
        MIKU_CONTEXT_CONFIG_GROUP,
        MIKU_EMOTION_CONFIG_GROUP,
        MIKU_MEMO_CONFIG_GROUP,
        MIKU_DREAM_CONFIG_GROUP,
        MIKU_TOOL_PROTOCOL_CONFIG_GROUP,
      ],
      // 阶段预算与软预警线(终端页上下文圈的分母与黄线);计数与物理上限由 core 报
      status: () => ({
        context: { maxTokens: cfg.context.maxTokens, softRatio: cfg.context.softRatio },
        emotion: persona.emotionState(),
        dream: persona.dreamStatus(),
      }),
    },
  };
}

const definition: BotDefinition<MikuConfig> = {
  id: 'miku',
  // 记忆系统与 Cormini 同一套(工作区即记忆,Git 记账)。
  memoryName: 'GitMem',
  declares: DECLARES,
  defaults: () => ({
    ...CORE_DEFAULTS,
    displayName: '初音未来',
    // 端点表是全局部署事实(`<部署根>/providers/`),不归代码包:本机那条 ollama
    // 端点的地址、模型、上下文窗口都在那里。这里只留层 1 的默认。
    providers: { ...structuredClone(CORE_DEFAULTS.providers) },
    web: { port: 7790, theme: 'mint' },
    paths: { memory: 'workspace', data: 'data' },
    batching: { ...CORE_DEFAULTS.batching },
    context: { ...MIKU_CONTEXT_DEFAULTS, ...CORE_DEFAULTS.context },
    rounds: { soft: 6, hard: 12 },
    // 词表分析默认开着;它不可靠时可以整层关掉,状态冻结在当前值。
    // 摸头每天最多把心情抬 0.25:疼爱要有回应,也不能靠摸头把羁绊刷满。
    emotion: { enabled: true, maxStepPerTurn: 0.3, decayScale: 1, patDailyGain: 0.25 },
    // 端点收不到请求体的 `tools` 时,部署把它打开。默认关:能投递声明的端点不需要重述。
    toolProtocol: { enabled: false },
    // 常驻层的全文每轮进前缀,所以它比 active 小一个量级。7 条约是 7 份短备忘。
    memo: { residentCap: 7, activeCap: 21 },
    // 整理是收束动作:轮数给多了容易把工作区改乱。
    dream: { maxRounds: 8 },
    tick: { intervalMinutes: null },
  } as unknown as MikuConfig),
  build,
};

export default definition;
