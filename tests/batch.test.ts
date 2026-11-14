import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageBatcher, mergeJobs } from "../src/batch.js";
import type { InboundJob } from "../src/types.js";

const job = (id: number, text: string, extra: Partial<InboundJob> = {}): InboundJob => ({
  accountId: 1,
  conversationId: 42,
  inboxId: 5,
  messageId: id,
  contactId: 77,
  contactName: "Budi",
  text,
  timestampMs: 1000 + id,
  attachments: [],
  ...extra,
});

const ok = () => ({ ok: true as const });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Collects what each started turn took. */
function harness(limits: Parameters<typeof createMessageBatcher>[0]) {
  const batcher = createMessageBatcher(limits);
  const turns: InboundJob[][] = [];
  const start = (take: () => InboundJob[]) => {
    turns.push(take());
    return Promise.resolve();
  };
  return { batcher, turns, add: (j: InboundJob) => batcher.add(j, "1:42", start) };
}

describe("mergeJobs", () => {
  it("returns a single job untouched", () => {
    const j = job(1, "halo");
    expect(mergeJobs([j])).toBe(j);
  });

  it("joins texts in order, merges attachments and keeps the newest identity", () => {
    const merged = mergeJobs([
      job(1, "alamat saya", { attachments: [{ type: "image", url: "https://x/a.png" }] }),
      job(2, "berapa ongkirnya", { attachments: [{ type: "file", url: "https://x/b.pdf" }] }),
    ]);
    expect(merged.text).toBe("alamat saya\nberapa ongkirnya");
    expect(merged.messageId).toBe(2);
    expect(merged.timestampMs).toBe(1002);
    expect(merged.attachments.map((a) => a.url)).toEqual(["https://x/a.png", "https://x/b.pdf"]);
  });
});

describe("message batcher", () => {
  it("starts the turn only after the customer has been quiet for the debounce time", async () => {
    const h = harness({ debounceMs: 3000 });
    const p1 = h.add(job(1, "a"));
    await vi.advanceTimersByTimeAsync(2000);
    const p2 = h.add(job(2, "b"));
    await vi.advanceTimersByTimeAsync(2999);
    expect(h.turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.turns.map((t) => t.map((j) => j.text))).toEqual([["a", "b"]]);
    await Promise.all([p1, p2]);
  });

  it("does not hold a long burst past maxWaitMs", async () => {
    const h = harness({ debounceMs: 3000, maxWaitMs: 15_000 });
    for (let i = 0; i < 10; i++) {
      h.add(job(i, `m${i}`));
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(h.turns.length).toBeGreaterThanOrEqual(1);
    expect(h.turns[0]!.length).toBeLessThanOrEqual(8);
  });

  it("starts at once when the debounce is 0", async () => {
    const h = harness({ debounceMs: 0 });
    h.add(job(1, "a"));
    expect(h.turns).toHaveLength(1);
  });

  it("keeps collecting after the turn is queued, until it really starts", async () => {
    const batcher = createMessageBatcher({ debounceMs: 0 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const takenBy: InboundJob[][] = [];
    const start = (take: () => InboundJob[]) =>
      gate.then(() => {
        takenBy.push(take());
      });
    batcher.add(job(1, "a"), "1:42", start);
    batcher.add(job(2, "b"), "1:42", start); // the queued turn has not started: joins it
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(takenBy.map((t) => t.map((j) => j.text))).toEqual([["a", "b"]]);
    expect(batcher.size()).toBe(0);
  });

  it("opens a new batch once the previous turn has taken its messages", async () => {
    const h = harness({ debounceMs: 0 });
    h.add(job(1, "a"));
    h.add(job(2, "b"));
    expect(h.turns.map((t) => t.length)).toEqual([1, 1]);
  });

  it("limits messages per turn, conversations collecting at once, and asks for room only for a new batch", () => {
    const b = createMessageBatcher({ debounceMs: 10_000, maxMessages: 2, maxBatches: 2 });
    const start = () => new Promise<void>(() => {});
    const refuse = () => ({ ok: false as const, reason: "queue_full" as const });
    expect(b.check("a", ok)).toEqual({ ok: true });
    b.add(job(1, "x"), "a", start);
    expect(b.check("a", refuse)).toEqual({ ok: true }); // joining needs no queue room
    b.add(job(2, "y"), "a", start);
    expect(b.check("a", ok)).toEqual({ ok: false, reason: "conversation_busy" }); // batch is full
    b.add(job(3, "z"), "b", start);
    expect(b.check("c", ok)).toEqual({ ok: false, reason: "queue_full" }); // too many collecting
    expect(b.check("d", refuse)).toEqual({ ok: false, reason: "queue_full" });
  });

  it("limits the characters collected for one turn", () => {
    const b = createMessageBatcher({ debounceMs: 10_000, maxChars: 10 });
    b.add(job(1, "x".repeat(10)), "a", () => new Promise<void>(() => {}));
    expect(b.check("a", ok)).toEqual({ ok: false, reason: "conversation_busy" });
  });

  it("passes a failed turn to every message in the batch", async () => {
    const b = createMessageBatcher({ debounceMs: 0 });
    const p = b.add(job(1, "a"), "k", () => Promise.reject(new Error("boom")));
    await expect(p).rejects.toThrow("boom");
  });
});
