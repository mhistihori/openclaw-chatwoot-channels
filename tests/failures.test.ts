import { describe, expect, it } from "vitest";
import { createFailureTracker, judgeReply, looksLikeHostNotice } from "../src/failures.js";

describe("looksLikeHostNotice", () => {
  it.each([
    "⚠️ Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`.",
    "  ⚠️ The AI service is busy.",
  ])("flags %s", (text) => {
    expect(looksLikeHostNotice(text)).toBe(true);
  });

  it.each(["Halo, ada yang bisa saya bantu?", "Pesanan Anda ⚠️ sedang dikirim", "", undefined])("lets %s through", (text) => {
    expect(looksLikeHostNotice(text)).toBe(false);
  });
});

describe("judgeReply", () => {
  it("sends a normal answer", () => {
    expect(judgeReply({ text: "Pesanan Anda sudah dikirim." })).toBe("send");
  });

  it.each([{ isReasoning: true }, { isCommentary: true }, { isCompactionNotice: true }])("drops internal notice %j", (flags) => {
    expect(judgeReply({ text: "thinking...", ...flags })).toBe("drop");
  });

  it("fails on flagged errors, whatever the text says", () => {
    expect(judgeReply({ text: "prepared model runtime publication was superseded", isError: true })).toBe("fail");
  });

  it("fails on the warning prefix even without a flag", () => {
    expect(judgeReply({ text: "⚠️ The AI service is busy." })).toBe("fail");
  });

  it("treats an internal notice flag as more specific than an error flag", () => {
    expect(judgeReply({ text: "x", isError: true, isReasoning: true })).toBe("drop");
  });
});

describe("failure tracker", () => {
  it("returns a recorded failure once", () => {
    const t = createFailureTracker();
    t.record("agent:support:chatwoot:direct:1-4", "boom");
    expect(t.take("agent:support:chatwoot:direct:1-4")).toBe("boom");
    expect(t.take("agent:support:chatwoot:direct:1-4")).toBeUndefined();
  });

  it("keeps sessions apart", () => {
    const t = createFailureTracker();
    t.record("a", "fail a");
    expect(t.take("b")).toBeUndefined();
    expect(t.take("a")).toBe("fail a");
  });

  it("matches a failure recorded without a session key", () => {
    const t = createFailureTracker();
    t.record(undefined, "no key");
    expect(t.take("whatever")).toBe("no key");
  });

  it("keeps the first failure of a turn, not the generic follow-up", () => {
    const t = createFailureTracker();
    t.record("a", "⚠️ The AI service is having trouble.");
    t.record("a", "⚠️ OpenClaw couldn't produce or deliver a reply.");
    expect(t.take("a")).toBe("⚠️ The AI service is having trouble.");
  });

  it("gives a default message when the text is empty", () => {
    const t = createFailureTracker();
    t.record("a", "  ");
    expect(t.take("a")).toBe("agent reported an error");
  });
});
