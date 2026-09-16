# cortico-world-live2d

Owner: `src/index.ts`

让 Live2D 形象由两件事共同驱动:**她的内部状态**(情绪)与**她说的话**(词表命中),再用一个网页
播放器渲染出来。素材来自 `vtuber-pack`——一份数据包,不是代码。

| 文件 | 内容 |
|---|---|
| `src/pack.ts` | 读 `params.json` / `clips.json` / `vocab.json`,并报出数据缺口 |
| `src/baseline.ts` | 内部状态 → 通道基线(情绪驱动的那一层) |
| `src/performance.ts` | 合成:基线 + 片段 + 时间线,按量程裁剪 |
| `tests/` | 素材包读取、基线映射、词表触发与合成 |

## 三层

1. **基线**——情绪驱动,一直在。这是题目要求的「身体由内部状态驱动」:六个维度各自相对自己
   的出厂基线归一化,再映射到通道。口型不在其中,它归说话。
2. **片段**——词汇表命中触发。三种形状:关键帧的 `pulse`(一次手势)、保持值的 `sustain`
   (表情/姿态)、视线目标 `gaze`。同分类的 state 互相替换,不同分类可以并存。
3. **合成**——相加后按 `params.json` 的量程裁剪。噪声与扫视都是时间的纯函数,不是随机数:
   同一时刻同一输入算出同一组值。

## 通道是抽象层

包说 `FaceAngleZ`,模型接的是 `ParamAngleZ`;`params.json` 的 `suggests` 是建议映射,
`range` 是裁剪边界,`losesIfMissing` 说明缺了这条通道会丢掉什么表演。换模型只换映射。

## 数据有缺口,读取要报出来

真实包里 `vocab.json` 提到的 `fx_*` 特效片段并不存在于 `clips.json`。`loadPack` 把这些名字
列在 `missingClipIds` 里,引擎遇到它们就是不触发——静默跳过会让"特效为什么不出现"变成谜。
