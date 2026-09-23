/**
 * 回复流的语音分段器,`src/world.ts` 用:增量进来,按句界切出适合一次合成的段。
 *
 * 切法是确定性的:同一串增量永远切出同一段。攒够 `minChars` 才切(太短的句子与后面
 * 合并,省一次合成调用);攒到 `maxChars` 就切,从上限回溯找句界,找不到才硬切。
 * `flush()` 把说剩的尾巴交出来(轮末冲刷用),`clear()` 整个丢弃(打断用)。
 */

/** 句界字符。不含 ASCII 句点:小数与缩写会误切。 */
const TERMINATORS = '。！？!?!…\n';

function lastTerminator(text: string, limit: number): number {
  for (let i = Math.min(limit, text.length) - 1; i >= 0; i--) {
    if (TERMINATORS.includes(text[i]!)) return i;
  }
  return -1;
}

export interface VoiceSegmenterOptions {
  /** 一段至少这么多字才切出去;不足时与后续句子合并。 */
  minChars: number;
  /** 一段至多这么多字;到了就切,从上限回溯找句界。 */
  maxChars: number;
}

export class VoiceSegmenter {
  private readonly opts: VoiceSegmenterOptions;
  private buffer = '';

  constructor(opts: VoiceSegmenterOptions) {
    this.opts = { minChars: Math.max(1, opts.minChars), maxChars: Math.max(opts.minChars, opts.maxChars) };
  }

  /** 喂一段增量,返回这次切出来的零或多段(顺序即语序)。 */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.nextCut();
      if (cut === null) break;
      out.push(cut);
    }
    return out;
  }

  /** 说剩的尾巴交出来;没有尾巴是 null。 */
  flush(): string | null {
    const tail = this.buffer;
    this.buffer = '';
    return tail === '' ? null : tail;
  }

  /** 整个丢弃(回复被打断时)。 */
  clear(): void {
    this.buffer = '';
  }

  private nextCut(): string | null {
    const { minChars, maxChars } = this.opts;
    if (this.buffer.length >= maxChars) {
      const at = lastTerminator(this.buffer, maxChars);
      return this.take(at === -1 ? maxChars : at + 1);
    }
    const at = lastTerminator(this.buffer, this.buffer.length);
    // 句界还没出现,或这句话太短:攒着,等后面的字。
    if (at === -1 || at + 1 < minChars) return null;
    return this.take(at + 1);
  }

  private take(count: number): string {
    const cut = this.buffer.slice(0, count);
    this.buffer = this.buffer.slice(count);
    return cut;
  }
}
