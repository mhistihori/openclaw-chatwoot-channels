import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHumanContextStore, formatWithHumanContext } from "../src/human-context.js";
import { createOwnMessageTracker } from "../src/own-messages.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "cw-human-"));
  dirs.push(d);
  return d;
};

describe("human context store", () => {
  it("keeps replies per conversation, oldest first", () => {
    const s = createHumanContextStore();
    s.add("1:42", { id: 1, name: "Winda", text: "satu" });
    s.add("1:42", { id: 2, name: "Winda", text: "dua" });
    s.add("1:43", { id: 3, name: "Budi", text: "lain" });
    expect(s.peek("1:42").map((e) => e.text)).toEqual(["satu", "dua"]);
    expect(s.peek("1:43").map((e) => e.text)).toEqual(["lain"]);
    expect(s.peek("1:99")).toEqual([]);
  });

  it("ignores a repeat of the same message id", () => {
    const s = createHumanContextStore();
    s.add("k", { id: 1, name: "W", text: "a" });
    s.add("k", { id: 1, name: "W", text: "a" });
    expect(s.peek("k")).toHaveLength(1);
  });

  it("forgets only the replies that were committed", () => {
    const s = createHumanContextStore();
    s.add("k", { id: 1, name: "W", text: "a" });
    const seen = s.peek("k");
    s.add("k", { id: 2, name: "W", text: "b" }); // arrives while the bot is busy
    s.commit("k", seen);
    expect(s.peek("k").map((e) => e.text)).toEqual(["b"]);
  });

  it("caps replies per conversation and the length of each", () => {
    const s = createHumanContextStore({ maxPerConversation: 3, maxCharsPerReply: 10 });
    for (let i = 1; i <= 5; i++) s.add("k", { id: i, name: "W", text: "x".repeat(50) });
    const list = s.peek("k");
    expect(list.map((e) => e.id)).toEqual([3, 4, 5]);
    expect(list[0]!.text).toBe(`${"x".repeat(10)}…`);
  });

  it("drops the oldest conversation beyond the limit", () => {
    const s = createHumanContextStore({ maxConversations: 2 });
    s.add("a", { id: 1, name: "W", text: "1" });
    s.add("b", { id: 2, name: "W", text: "2" });
    s.add("c", { id: 3, name: "W", text: "3" });
    expect(s.peek("a")).toEqual([]);
    expect(s.peek("c")).toHaveLength(1);
  });

  it("forgets replies after the ttl", () => {
    let t = 0;
    const s = createHumanContextStore({ ttlMs: 100, now: () => t });
    s.add("k", { id: 1, name: "W", text: "a" });
    t = 150;
    expect(s.peek("k")).toEqual([]);
  });

  it("survives a restart, including what was already committed", () => {
    const stateDir = tmp();
    const first = createHumanContextStore({ stateDir });
    first.add("k", { id: 1, name: "W", text: "lama" });
    first.add("k", { id: 2, name: "W", text: "baru" });
    first.commit("k", first.peek("k").slice(0, 1));

    const second = createHumanContextStore({ stateDir });
    expect(second.peek("k").map((e) => e.text)).toEqual(["baru"]);
  });

  it("compacts the log on start and tolerates a torn last line", () => {
    const stateDir = tmp();
    const s = createHumanContextStore({ stateDir });
    for (let i = 1; i <= 4; i++) s.add("k", { id: i, name: "W", text: `m${i}` });
    s.commit("k", s.peek("k").slice(0, 3));
    const file = join(stateDir, "chatwoot-human-context.jsonl");
    writeFileSync(file, `${readFileSync(file, "utf8")}{"op":"add","k":"k","e":{"id":9`); // crash mid-write

    const restarted = createHumanContextStore({ stateDir });
    expect(restarted.peek("k").map((e) => e.text)).toEqual(["m4"]);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("formatWithHumanContext", () => {
  it("returns the customer text unchanged when nothing happened", () => {
    expect(formatWithHumanContext([], "halo")).toBe("halo");
  });

  it("puts the human replies in front of the customer's message", () => {
    const out = formatWithHumanContext(
      [
        { id: 1, name: "Winda", text: "Garansi 1 tahun.", t: 0 },
        { id: 2, name: "Winda", text: "baris satu\nbaris dua", t: 0 },
      ],
      "Berapa lama klaimnya?",
    );
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^\[Human agent replies/);
    expect(lines).toContain("- Winda: Garansi 1 tahun.");
    expect(lines).toContain("- Winda: baris satu baris dua");
    expect(lines[lines.length - 2]).toBe("[New message from the customer]");
    expect(lines[lines.length - 1]).toBe("Berapa lama klaimnya?");
  });
});

describe("own message tracker", () => {
  it("remembers ids and forgets the oldest beyond its limit", () => {
    const t = createOwnMessageTracker({ maxIds: 2 });
    t.add(1);
    t.add(2);
    t.add(3);
    expect(t.has(1)).toBe(false);
    expect(t.has(2)).toBe(true);
    expect(t.has(3)).toBe(true);
  });

  it("ignores a missing id", () => {
    const t = createOwnMessageTracker();
    t.add(undefined);
    expect(t.has(0)).toBe(false);
  });

  it("recognises an announced text even when the webhook beats the id", () => {
    const t = createOwnMessageTracker();
    t.expect(42, "Halo, ada yang bisa dibantu?");
    expect(t.matches(42, 9001, "Halo, ada yang bisa dibantu?")).toBe(true);
    expect(t.has(9001)).toBe(true); // learned from the match
  });

  it("matches despite whitespace differences", () => {
    const t = createOwnMessageTracker();
    t.expect(42, "Baris satu\n\nbaris dua  ");
    expect(t.matches(42, 1, " Baris satu baris dua")).toBe(true);
  });

  it("uses an announced text up once, so a human repeating it is still heard", () => {
    const t = createOwnMessageTracker();
    t.expect(42, "Terima kasih");
    expect(t.matches(42, 1, "Terima kasih")).toBe(true);
    expect(t.matches(42, 2, "Terima kasih")).toBe(false);
  });

  it("does not match another conversation or different words", () => {
    const t = createOwnMessageTracker();
    t.expect(42, "Terima kasih");
    expect(t.matches(43, 1, "Terima kasih")).toBe(false);
    expect(t.matches(42, 2, "Terima kasih banyak")).toBe(false);
  });

  it("stops matching an announced text after the ttl", () => {
    let now = 0;
    const t = createOwnMessageTracker({ now: () => now, expectTtlMs: 1000 });
    t.expect(42, "Halo");
    now = 5000;
    expect(t.matches(42, 1, "Halo")).toBe(false);
  });
});
