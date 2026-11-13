export const DEFAULT_QUEUE_LIMITS = {
    maxPerKey: 5,
    maxTotal: 200,
    maxConcurrent: 8,
    maxWaitMs: 5 * 60_000,
};
/** Thrown into a job's promise when it waited too long and was never started. */
export class QueueExpiredError extends Error {
    constructor(waitedMs) {
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
export function createKeyedQueue(overrides = {}, now = Date.now) {
    const limits = { ...DEFAULT_QUEUE_LIMITS, ...overrides };
    const tails = new Map();
    const perKey = new Map();
    let total = 0;
    let running = 0;
    const waiting = [];
    async function acquireSlot() {
        if (running < limits.maxConcurrent) {
            running++;
            return;
        }
        await new Promise((resolve) => waiting.push(resolve));
    }
    function releaseSlot() {
        const next = waiting.shift();
        if (next)
            next(); // The slot passes straight to the next job.
        else
            running--;
    }
    return {
        /** Check, without queueing anything, whether a job for `key` would be accepted. */
        tryAdmit(key) {
            if ((perKey.get(key) ?? 0) >= limits.maxPerKey)
                return { ok: false, reason: "conversation_busy" };
            if (total >= limits.maxTotal)
                return { ok: false, reason: "queue_full" };
            return { ok: true };
        },
        run(key, task) {
            const enqueuedAt = now();
            total++;
            perKey.set(key, (perKey.get(key) ?? 0) + 1);
            const prev = tails.get(key) ?? Promise.resolve();
            const result = prev
                .then(() => undefined, () => undefined)
                .then(async () => {
                await acquireSlot();
                try {
                    const waited = now() - enqueuedAt;
                    if (waited > limits.maxWaitMs)
                        throw new QueueExpiredError(waited);
                    return await task();
                }
                finally {
                    releaseSlot();
                }
            });
            const tail = result.then(() => undefined, () => undefined);
            tails.set(key, tail);
            void tail.then(() => {
                total--;
                const left = (perKey.get(key) ?? 1) - 1;
                if (left <= 0)
                    perKey.delete(key);
                else
                    perKey.set(key, left);
                if (tails.get(key) === tail)
                    tails.delete(key);
            });
            return result;
        },
        /** Conversations that currently have work queued or running. */
        size: () => tails.size,
        /** Jobs queued or running across all conversations. */
        pending: () => total,
    };
}
