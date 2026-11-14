export const DEFAULT_BATCH_LIMITS = {
    debounceMs: 3000,
    maxWaitMs: 15_000,
    maxMessages: 20,
    maxChars: 12_000,
    maxBatches: 200,
};
/** One turn's worth of customer messages as a single job: texts joined in order, the newest message's identity. */
export function mergeJobs(jobs) {
    const last = jobs[jobs.length - 1];
    if (jobs.length === 1)
        return last;
    return {
        ...last,
        text: jobs.map((j) => j.text).join("\n"),
        attachments: jobs.flatMap((j) => j.attachments),
    };
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
export function createMessageBatcher(overrides = {}, now = Date.now) {
    const limits = { ...DEFAULT_BATCH_LIMITS, ...overrides };
    const open = new Map();
    return {
        /** Would a message for `key` be accepted? `canStart` is asked only when it would open a new batch. */
        check(key, canStart) {
            const b = open.get(key);
            if (b)
                return b.jobs.length >= limits.maxMessages || b.chars >= limits.maxChars ? { ok: false, reason: "conversation_busy" } : { ok: true };
            if (open.size >= limits.maxBatches)
                return { ok: false, reason: "queue_full" };
            return canStart();
        },
        /**
         * Add a message that `check` accepted. `start` queues the turn and receives `take`, which the
         * turn calls when it begins to claim every message collected so far. Resolves when that turn is done.
         */
        add(job, key, start) {
            const existing = open.get(key);
            if (existing) {
                existing.jobs.push(job);
                existing.chars += job.text.length;
                if (!existing.queued)
                    arm(existing);
                return existing.work;
            }
            let resolve;
            let reject;
            const work = new Promise((res, rej) => {
                resolve = res;
                reject = rej;
            });
            const batch = {
                jobs: [job],
                chars: job.text.length,
                startedAt: now(),
                timer: undefined,
                queued: false,
                work,
                fire: () => {
                    batch.queued = true;
                    batch.timer = undefined;
                    // Whatever happens to the turn, this batch must leave the map: a turn that is rejected
                    // before it starts (it waited too long in the queue) never calls `take`, and a batch
                    // left behind would swallow every later message for the conversation. Only remove it
                    // if it is still the open one; a newer batch for the same key is not ours to touch.
                    const release = () => {
                        if (open.get(key) === batch)
                            open.delete(key);
                    };
                    const take = () => {
                        release();
                        return batch.jobs;
                    };
                    let started;
                    try {
                        started = start(take);
                    }
                    catch (e) {
                        started = Promise.reject(e);
                    }
                    started.then(() => {
                        release();
                        resolve();
                    }, (e) => {
                        release();
                        reject(e);
                    });
                },
            };
            open.set(key, batch);
            arm(batch);
            return work;
        },
        /** Conversations currently collecting or waiting for their turn to start. */
        size: () => open.size,
    };
    function arm(b) {
        if (b.timer)
            clearTimeout(b.timer);
        const delay = Math.max(0, Math.min(limits.debounceMs, b.startedAt + limits.maxWaitMs - now()));
        if (delay === 0) {
            b.timer = undefined;
            b.fire();
        }
        else {
            b.timer = setTimeout(b.fire, delay);
        }
    }
}
