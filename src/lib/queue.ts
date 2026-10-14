/** Push-based async iterable, used to feed client-streaming and bidi requests. */
export function createQueue<T>() {
  const items: T[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(item: T) {
      if (closed) return;
      items.push(item);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      while (true) {
        if (items.length) {
          yield items.shift() as T;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    },
  };
}
