/**
 * OutputCollector
 *
 * Accumulates bytes from a command's combined stdout/stderr stream while
 * keeping only the last `maxBytes` worth in memory (tail-only truncation).
 *
 * The collector reports back to the caller:
 *   - `totalBytes`: total bytes ever pushed (across both streams).
 *   - `tail`: the trailing window, up to `maxBytes`.
 *   - `truncated`: true when totalBytes > maxBytes.
 *   - `droppedBytes`: how many bytes were discarded from the head.
 *
 * The class operates on Buffers to stay encoding-safe; callers can decode
 * once at the end. Chunks are stored as-is and joined only on `getTail()`,
 * so push() is O(chunk length) amortized and only trims when the running
 * total exceeds `maxBytes`.
 */
export interface CollectorSnapshot {
  tail: Buffer;
  totalBytes: number;
  droppedBytes: number;
  truncated: boolean;
}

export class OutputCollector {
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private totalBytes = 0;
  private droppedBytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0) {
      throw new Error(`OutputCollector: maxBytes must be a non-negative finite number, got ${maxBytes}`);
    }
    this.maxBytes = Math.floor(maxBytes);
  }

  /**
   * Push a chunk of bytes into the collector. Accepts strings or Buffers.
   * Strings are interpreted as UTF-8.
   */
  public push(chunk: Buffer | string): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    if (buf.length === 0) return;

    this.totalBytes += buf.length;

    if (this.maxBytes === 0) {
      this.droppedBytes += buf.length;
      return;
    }

    this.chunks.push(buf);
    this.bufferedBytes += buf.length;
    this.trim();
  }

  /**
   * Trim chunks from the head until bufferedBytes <= maxBytes.
   * The most recent chunk may need to be partially sliced.
   */
  private trim(): void {
    while (this.bufferedBytes > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0];
      const overshoot = this.bufferedBytes - this.maxBytes;
      if (head.length <= overshoot) {
        this.chunks.shift();
        this.bufferedBytes -= head.length;
        this.droppedBytes += head.length;
      } else {
        this.chunks[0] = head.subarray(overshoot);
        this.bufferedBytes -= overshoot;
        this.droppedBytes += overshoot;
      }
    }
  }

  /**
   * Get the current tail snapshot. The returned Buffer is a fresh copy.
   */
  public getSnapshot(): CollectorSnapshot {
    const tail = this.chunks.length === 0
      ? Buffer.alloc(0)
      : Buffer.concat(this.chunks, this.bufferedBytes);
    return {
      tail,
      totalBytes: this.totalBytes,
      droppedBytes: this.droppedBytes,
      truncated: this.droppedBytes > 0,
    };
  }

  public getTotalBytes(): number {
    return this.totalBytes;
  }

  public getDroppedBytes(): number {
    return this.droppedBytes;
  }

  public isTruncated(): boolean {
    return this.droppedBytes > 0;
  }

  public getMaxBytes(): number {
    return this.maxBytes;
  }
}
