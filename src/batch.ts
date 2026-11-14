import type { RejectReason } from "./queue.js";
import type { InboundJob } from "./types.js";

export interface BatchLimits {
  /** Wait this long after the customer's last message before the agent starts. 0 = do not wait. */
  debounceMs: number;
  /** Never hold a burst longer than this, however long the customer keeps typing. */
  maxWaitMs: number;
  /** Most messages merged into one turn. */
  maxMessages: number;
  /** Most characters merged into one turn. */
  maxChars: number;
  /** Most conversations collecting at once. */
  maxBatches: number;
}

export const DEFAULT_BATCH_LIMITS: BatchLimits = {
  debounceMs: 3000,
  maxWaitMs: 15_000,
  maxMessages: 20,
  maxChars: 12_000,
  maxBatches: 200,
};

/** One turn's worth of customer messages as a single job: texts joined in order, the newest message's identity. */
export function mergeJobs(jobs: InboundJob[]): InboundJob {
  const last = jobs[jobs.length - 1]!;
  if (jobs.length === 1) return last;
  return {
    ...last,
    text: jobs.map((j) => j.text).join("\n"),
    attachments: jobs.flatMap((j) => j.attachments),
  };
}

interface Batch {
  jobs: InboundJob[];
  chars: number;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The turn has been queued; it still takes new messages until it actually starts. */
  queued: boolean;
  work: Promise<void>;
  /** Queue the turn now. */
  fire: () => void;
}

/**
 * Groups customer messages that arrive close together into one agent turn, so a customer who
 * sends "address…" and then "how much?" gets one answer instead of two.
 *
 * A batch collects for `debounceMs` after the last message (at most `maxWaitMs` in total), is then
 * queued, and keeps taking messages until its turn really starts: while an earlier turn for the
 * same conversation is still running, newer messages wait in the next batch instead of
 * triggering a stale second answer. Everything is bounded by the limits.
 */
export function createMessageBatcher(overrides: Partial<BatchLimits> = {}, now: () => number = Date.now) {
  const limits: BatchLimits = { ...DEFAULT_BATCH_LIMITS, ...overrides };
  const open = new Map<string, Batch>();

  return {
    /** Would a message for `key` be accepted? `canStart` is asked only when it would open a new batch. */
    check(key: string, canStart: () => { ok: true } | { ok: false; reason: RejectReason }): { ok: true } | { ok: false; reason: RejectReason } {
      const b = open.get(key);
      if (b) return b.jobs.length >= limits.maxMessages || b.chars >= limits.maxChars ? { ok: false, reason: "conversation_busy" } : { ok: true };
      if (open.size >= limits.maxBatches) return { ok: false, reason: "queue_full" };
      return canStart();
    },

    /**
     * Add a message that `check` accepted. `start` queues the turn and receives `take`, which the
     * turn calls when it begins to claim every message collected so far. Resolves when that turn is done.
     */
    add(job: InboundJob, key: string, start: (take: () => InboundJob[]) => Promise<void>): Promise<void> {
      const existing = open.get(key);
      if (existing) {
        existing.jobs.push(job);
        existing.chars += job.text.length;
        if (!existing.queued) arm(existing);
        return existing.work;
      }

      let resolve!: () => void;
      let reject!: (e: unknown) => void;
      const work = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const batch: Batch = {
        jobs: [job],
        chars: job.text.length,
        startedAt: now(),
        timer: undefined,
        queued: false,
        work,
        fire: () => {
          batch.queued = true;
          batch.timer = undefined;
          const take = () => {
            if (open.get(key) === batch) open.delete(key);
            return batch.jobs;
          };
          start(take).then(resolve, reject);
        },
      };
      open.set(key, batch);
      arm(batch);
      return work;
    },

    /** Conversations currently collecting or waiting for their turn to start. */
    size: () => open.size,
  };

  function arm(b: Batch): void {
    if (b.timer) clearTimeout(b.timer);
    const delay = Math.max(0, Math.min(limits.debounceMs, b.startedAt + limits.maxWaitMs - now()));
    if (delay === 0) {
      b.timer = undefined;
      b.fire();
    } else {
      b.timer = setTimeout(b.fire, delay);
    }
  }
}

export type MessageBatcher = ReturnType<typeof createMessageBatcher>;
