/** 端点与渠道选择归部署;这个包只给出人格身份与自己的默认值。 */
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { BotDefinition, BotParts } from 'cortico/bot.ts';
import type { CoreConfig, World } from 'cortico/core/types.ts';
import type { LoadedConfig } from 'cortico/deploy.ts';
import { CORE_DEFAULTS } from 'cortico/core/config.ts';
import type { WorldDeclaration } from 'cortico/world.ts';
import type { TerminalConfigSection } from 'cortico/worlds/terminal/config.ts';
import { MIKU_CONTEXT_DEFAULTS, Miku, type EmotionPolicy } from './persona/persona.ts';
import { MIKU_CONTEXT_CONFIG_GROUP, MIKU_EMOTION_CONFIG_GROUP } from './persona/config.ts';
import type { ContextStagePolicy } from '../cormini/persona/persona.ts';

const HERE = resolve(import.meta.dirname);

/** 存在方式自述的源文件;控制台「Persona」页可编辑,重载前缀即生效。 */
const ORIENTATION_FILE = resolve(HERE, 'persona/ORIENTATION.md');

/**
 * 这个Persona为之设计的渠道。表现层 World 在接入后再加进这里;bilibili、QQ、Minecraft
 * 这些渠道不声明:她的活动范围只有终端与自己的形象。
 */
const DECLARES: readonly WorldDeclaration[] = ['terminal'];

export interface MikuConfig extends CoreConfig {
  /** 阶段长度四项归Persona,摘思维链归 core;同住 context 段。 */
  context: CoreConfig['context'] & ContextStagePolicy;
  rounds: { soft: number; hard: number };
  emotion: EmotionPolicy;
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
      configGroups: [MIKU_CONTEXT_CONFIG_GROUP, MIKU_EMOTION_CONFIG_GROUP],
      // 阶段预算与软预警线(终端页上下文圈的分母与黄线);计数与物理上限由 core 报
      status: () => ({
        context: { maxTokens: cfg.context.maxTokens, softRatio: cfg.context.softRatio },
        emotion: persona.emotionState(),
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
    emotion: { enabled: true, maxStepPerTurn: 0.3, decayScale: 1 },
    tick: { intervalMinutes: null },
  } as unknown as MikuConfig),
  build,
};

export default definition;
