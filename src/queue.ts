/**
 * Runs tasks one at a time per key, so two quick messages in the same
 * conversation never produce interleaved agent turns or replies.
 */
export function createKeyedQueue() {
  const tails = new Map<string, Promise<void>>();

  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve();
      const result = prev.then(task, task);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
    size: () => tails.size,
  };
}

export type KeyedQueue = ReturnType<typeof createKeyedQueue>;
