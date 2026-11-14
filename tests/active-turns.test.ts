import { describe, expect, it } from "vitest";
import { createActiveTurns } from "../src/active-turns.js";

describe("active turns", () => {
  it("refuses a turn beyond the limit and takes it back after one ends", () => {
    const t = createActiveTurns(2);
    const a = t.tryBegin("a");
    const b = t.tryBegin("b");
    expect(a.ok && b.ok).toBe(true);
    expect(t.tryBegin("c")).toEqual({ ok: false, reason: "too_many_turns" });
    if (a.ok) a.end();
    expect(t.count()).toBe(1);
    expect(t.tryBegin("c").ok).toBe(true);
  });

  it("refuses a second turn for a conversation that still has one running", () => {
    const t = createActiveTurns(5);
    const a = t.tryBegin("a");
    expect(t.tryBegin("a")).toEqual({ ok: false, reason: "turn_still_running" });
    if (a.ok) a.end();
    expect(t.tryBegin("a").ok).toBe(true);
  });

  it("ignores a repeated end, so it cannot free someone else's slot", () => {
    const t = createActiveTurns(5);
    const first = t.tryBegin("a");
    if (first.ok) first.end();
    const second = t.tryBegin("a");
    if (first.ok) first.end(); // late duplicate call
    expect(t.count()).toBe(1);
    if (second.ok) second.end();
    expect(t.count()).toBe(0);
  });
});
