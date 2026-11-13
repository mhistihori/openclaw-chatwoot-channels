import { describe, expect, it } from "vitest";
import { createKeyedQueue, QueueExpiredError } from "../src/queue.js";

const tick = () => new Promise((r) => setTimeout(r, 5));
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

describe("keyed queue", () => {
  it("runs jobs for one key in order, one at a time", async () => {
    const q = createKeyedQueue();
    const order: string[] = [];
    const g = gate();
    const a = q.run("k", async () => {
      order.push("a-start");
      await g.p;
      order.push("a-end");
    });
    const b = q.run("k", async () => void order.push("b"));
    await tick();
    expect(order).toEqual(["a-start"]);
    g.open();
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("limits backlog per conversation and in total, and frees room afterwards", async () => {
    const q = createKeyedQueue({ maxPerKey: 2, maxTotal: 3 });
    const g = gate();
    const jobs = [q.run("a", () => g.p), q.run("a", () => g.p)];
    expect(q.tryAdmit("a")).toEqual({ ok: false, reason: "conversation_busy" });
    jobs.push(q.run("b", () => g.p));
    expect(q.tryAdmit("c")).toEqual({ ok: false, reason: "queue_full" });
    expect(q.pending()).toBe(3);
    g.open();
    await Promise.all(jobs);
    await tick();
    expect(q.pending()).toBe(0);
    expect(q.size()).toBe(0);
    expect(q.tryAdmit("a")).toEqual({ ok: true });
  });

  it("caps how many jobs run at once across conversations", async () => {
    const q = createKeyedQueue({ maxConcurrent: 2 });
    let active = 0;
    let peak = 0;
    const g = gate();
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await g.p;
      active--;
    };
    const all = ["a", "b", "c", "d"].map((k) => q.run(k, task));
    await new Promise((r) => setTimeout(r, 10));
    expect(active).toBe(2);
    g.open();
    await Promise.all(all);
    expect(peak).toBe(2);
  });

  it("drops a job that waited too long without running it", async () => {
    let t = 0;
    const q = createKeyedQueue({ maxWaitMs: 1000 }, () => t);
    const g = gate();
    let ran = false;
    const first = q.run("k", () => g.p);
    await tick(); // the first job is now running
    const second = q.run("k", async () => void (ran = true));
    const outcome = second.then(
      () => undefined,
      (e: unknown) => e,
    );
    t = 5000;
    g.open();
    await first;
    expect(await outcome).toBeInstanceOf(QueueExpiredError);
    expect(ran).toBe(false);
  });

  it("keeps going after a failed job", async () => {
    const q = createKeyedQueue();
    await expect(q.run("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(q.run("k", async () => "ok")).resolves.toBe("ok");
  });
});
