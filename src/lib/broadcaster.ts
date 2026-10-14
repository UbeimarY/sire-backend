/**
 * Minimal in-memory pub/sub used to fan out events to server-streaming RPCs.
 * Each subscriber gets its own queue; the stream ends when the client aborts.
 */
export class Broadcaster<T> {
  private subscribers = new Set<(event: T) => void>();

  publish(event: T): void {
    for (const notify of this.subscribers) notify(event);
  }

  get size(): number {
    return this.subscribers.size;
  }

  async *subscribe(signal: AbortSignal, initial: T[] = []): AsyncGenerator<T> {
    const queue: T[] = [...initial];
    let wake: (() => void) | undefined;
    const notify = (event: T) => {
      queue.push(event);
      wake?.();
    };
    const onAbort = () => wake?.();
    this.subscribers.add(notify);
    signal.addEventListener("abort", onAbort);
    try {
      while (!signal.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
          continue;
        }
        yield queue.shift() as T;
      }
    } finally {
      this.subscribers.delete(notify);
      signal.removeEventListener("abort", onAbort);
    }
  }
}
