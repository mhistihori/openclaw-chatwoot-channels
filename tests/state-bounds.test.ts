import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDedupeStore } from "../src/dedupe.js";
import { createHumanContextStore } from "../src/human-context.js";
import { readTailLines } from "../src/state-file.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "cw-bounds-"));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const lineCount = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).length;

describe("dedupe log is bounded", () => {
  it("rewrites the log while running, so a flood does not grow the file without limit", () => {
    const dir = tmp();
    const d = createDedupeStore({ stateDir: dir, maxEntries: 100 });
    for (let i = 0; i < 5000; i++) d.claim(`msg:1:${i}`);
    const file = join(dir, "chatwoot-dedupe.jsonl");
    expect(lineCount(file)).toBeLessThanOrEqual(200); // never more than twice what is kept
    expect(d.claim("msg:1:4999")).toBe(false); // recent claims still count
  });

  it("still dedupes across a restart after compaction", () => {
    const dir = tmp();
    const a = createDedupeStore({ stateDir: dir, maxEntries: 50 });
    for (let i = 0; i < 400; i++) a.claim(`msg:1:${i}`);
    const b = createDedupeStore({ stateDir: dir, maxEntries: 50 });
    expect(b.claim("msg:1:399")).toBe(false);
    expect(b.claim("msg:1:new")).toBe(true);
  });

  it("does not load a huge log whole on start, and shrinks it", () => {
    const dir = tmp();
    const file = join(dir, "chatwoot-dedupe.jsonl");
    const now = Date.now();
    const lines: string[] = [];
    for (let i = 0; i < 60_000; i++) lines.push(JSON.stringify({ k: `msg:1:${i}`, t: now }));
    writeFileSync(file, lines.join("\n") + "\n");
    const before = statSync(file).size;
    const d = createDedupeStore({ stateDir: dir, maxEntries: 1000, maxFileBytes: 64 * 1024 });
    expect(statSync(file).size).toBeLessThan(before / 10);
    expect(lineCount(file)).toBeLessThanOrEqual(1000);
    expect(d.claim("msg:1:59999")).toBe(false); // the newest lines were kept
  });

  it("keeps deduping from memory, and reports once, when the disk cannot be written", () => {
    const dir = tmp();
    const onError = vi.fn();
    const d = createDedupeStore({ stateDir: dir, onError });
    mkdirSync(join(dir, "chatwoot-dedupe.jsonl")); // appending to a directory fails
    expect(d.claim("a")).toBe(true);
    expect(d.claim("b")).toBe(true);
    expect(d.claim("a")).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("works from memory when the state directory cannot be created", () => {
    const dir = tmp();
    writeFileSync(join(dir, "blocker"), "x");
    const onError = vi.fn();
    const d = createDedupeStore({ stateDir: join(dir, "blocker", "sub"), onError });
    expect(d.claim("a")).toBe(true);
    expect(d.claim("a")).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("human-context log is bounded", () => {
  it("compacts while running", () => {
    const dir = tmp();
    const s = createHumanContextStore({ stateDir: dir });
    for (let i = 0; i < 30_000; i++) {
      s.add("1:42", { id: i, name: "Winda", text: "halo" });
      if (i % 2 === 0) s.commit("1:42", s.peek("1:42"));
    }
    const file = join(dir, "chatwoot-human-context.jsonl");
    expect(lineCount(file)).toBeLessThanOrEqual(10_000 + 20);
  });

  it("reads a huge log only from its tail", () => {
    const dir = tmp();
    const file = join(dir, "chatwoot-human-context.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 50_000; i++) lines.push(JSON.stringify({ op: "add", k: `1:${i % 3}`, e: { id: i, name: "W", text: "x", t: Date.now() } }));
    writeFileSync(file, lines.join("\n") + "\n");
    const s = createHumanContextStore({ stateDir: dir, maxFileBytes: 64 * 1024 });
    expect(statSync(file).size).toBeLessThan(64 * 1024);
    expect(s.peek("1:0").length).toBeLessThanOrEqual(20);
  });

  it("keeps working in memory when the disk cannot be written", () => {
    const dir = tmp();
    const onError = vi.fn();
    const s = createHumanContextStore({ stateDir: dir, onError });
    rmSync(join(dir, "chatwoot-human-context.jsonl"));
    mkdirSync(join(dir, "chatwoot-human-context.jsonl")); // appending to a directory fails
    s.add("1:42", { id: 1, name: "Winda", text: "halo" });
    expect(s.peek("1:42")).toHaveLength(1);
  });
});

describe("readTailLines", () => {
  it("drops the partial line a cut produces", () => {
    const dir = tmp();
    const file = join(dir, "f.jsonl");
    writeFileSync(file, ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"].join("\n") + "\n");
    expect(readTailLines(file, 25)).toEqual(["bbbbbbbbbb", "cccccccccc"]); // the cut lands inside the first line
    expect(readTailLines(file, 15)).toEqual(["cccccccccc"]); // the cut lands inside the second line
    expect(readTailLines(file, 1000)).toEqual(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"]);
    expect(readTailLines(join(dir, "missing"))).toEqual([]);
  });
});
