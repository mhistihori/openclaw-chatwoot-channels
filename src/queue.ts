export interface QueueLimits {
  /** Most jobs waiting or running for one conversation. */
  maxPerKey: number;
  /** Most jobs waiting or running across all conversations. */
  maxTotal: number;
  /** Most jobs running at the same time (each one is an agent turn). */
  maxConcurrent: number;
  /** A job that waited longer than this is dropped instead of run. */
  maxWaitMs: number;
}

export const DEFAULT_QUEUE_LIMITS: QueueLimits = {
  maxPerKey: 5,
  maxTotal: 200,
  maxConcurrent: 8,
  maxWaitMs: 5 * 60_000,
};

export type RejectReason = "conversation_busy" | "queue_full";

/** Thrown into a job's promise when it waited too long and was never started. */
export class QueueExpiredError extends Error {
  constructor(waitedMs: number) {
    super(`job expired after waiting ${waitedMs}ms`);
    this.name = "QueueExpiredError";
  }
}

/**
 * Runs tasks one at a time per key, so two quick messages in the same conversation never
 * produce interleaved agent turns or replies. The queue is bounded so a flood of messages
 * cannot grow memory or start unlimited agent turns:
 *
 * - `tryAdmit(key)` says whether a new job fits (per-conversation and total limits);
 * - at most `maxConcurrent` jobs run at once, the rest wait their turn in arrival order;
 * - a job that waited longer than `maxWaitMs` is dropped without running.
 */
export function createKeyedQueue(overrides: Partial<QueueLimits> = {}, now: () => number = Date.now) {
  const limits: QueueLimits = { ...DEFAULT_QUEUE_LIMITS, ...overrides };
  const tails = new Map<string, Promise<void>>();
  const perKey = new Map<string, number>();
  let total = 0;
  let running = 0;
  const waiting: Array<() => void> = [];

  async function acquireSlot(): Promise<void> {
    if (running < limits.maxConcurrent) {
      running++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  function releaseSlot(): void {
    const next = waiting.shift();
    if (next) next(); // The slot passes straight to the next job.
    else running--;
  }

  return {
    /** Check, without queueing anything, whether a job for `key` would be accepted. */
    tryAdmit(key: string): { ok: true } | { ok: false; reason: RejectReason } {
      if ((perKey.get(key) ?? 0) >= limits.maxPerKey) return { ok: false, reason: "conversation_busy" };
      if (total >= limits.maxTotal) return { ok: false, reason: "queue_full" };
      return { ok: true };
    },
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const enqueuedAt = now();
      total++;
      perKey.set(key, (perKey.get(key) ?? 0) + 1);

      const prev = tails.get(key) ?? Promise.resolve();
      const result = prev
        .then(
          () => undefined,
          () => undefined,
        )
        .then(async () => {
          await acquireSlot();
          try {
            const waited = now() - enqueuedAt;
            if (waited > limits.maxWaitMs) throw new QueueExpiredError(waited);
            return await task();
          } finally {
            releaseSlot();
          }
        });

      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, tail);
      void tail.then(() => {
        total--;
        const left = (perKey.get(key) ?? 1) - 1;
        if (left <= 0) perKey.delete(key);
        else perKey.set(key, left);
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
    /** Conversations that currently have work queued or running. */
    size: () => tails.size,
    /** Jobs queued or running across all conversations. */
    pending: () => total,
  };
}

export type KeyedQueue = ReturnType<typeof createKeyedQueue>;
