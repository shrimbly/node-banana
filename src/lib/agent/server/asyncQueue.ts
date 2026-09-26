/**
 * A minimal push → async-iterate queue, for turning callbacks (JSON-RPC
 * notifications) into an async generator. Server-only.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiting: (() => void) | null = null;
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    this.items.push(item);
    this.wake();
  }

  /** No more items; iteration finishes once the buffered ones are read. */
  end(): void {
    this.ended = true;
    this.wake();
  }

  get isEnded(): boolean {
    return this.ended;
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}
