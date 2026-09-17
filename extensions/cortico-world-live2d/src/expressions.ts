/**
 * 心情 → 模型自带表情。
 *
 * 这是第三层驱动,和另外两层都不重叠:
 *   - 通道层写 `ParamAngle*`/`ParamMouth*`/`ParamEye*`/`ParamBrow*`;
 *   - 这份模型的八个表情只写 `Param125` 与 `Param130-137`(开关参数)。
 * 两组参数不相交,所以表情可以和基线、片段同时生效,谁也不覆盖谁。
 *
 * 只用**情绪**类的四个:脸红、前倾、圈圈、唱歌、比心里的四个。葱是道具、QQ 人是画风、
 * 水印是作者的标记,都不是情绪,不列进表里。水印另有一条路:作者把开关留在了 `Param137` 上
 * (默认可见),部署用 `paramOverrides` 钉住它,不由表情表决定。
 *
 * 表里没有的心情(寂寞、低落、认真、平静)返回 null:那几种由连续的基线表达,
 * 硬塞一个表情会把"低落"演成别的意思。
 */

/** 心情标签 → 本模型的表情名。键是 `bots/miku/persona/emotion.ts` 里的 Mood。 */
export const MOOD_EXPRESSIONS: Readonly<Record<string, string>> = {
  害羞: 'blush',
  温柔: 'lean',
  元气: 'sing',
  开心: 'heart',
};

/** 表里提到、这份模型却没有的表情名;启动时报出来。 */
export function missingExpressions(available: ReadonlySet<string>): string[] {
  return [...new Set(Object.values(MOOD_EXPRESSIONS))].filter((name) => !available.has(name)).sort();
}

/** 此刻该挂哪个表情;心情不在表里、或模型没有它,都给 null。 */
export function expressionForMood(mood: string | null, available: ReadonlySet<string>): string | null {
  if (!mood) return null;
  const name = MOOD_EXPRESSIONS[mood];
  if (!name || !available.has(name)) return null;
  return name;
}
