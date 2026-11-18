import { describe, expect, it } from "vitest";
import { createFailureTracker, isTransientDispatchError, judgeReply, looksLikeHostNotice } from "../src/failures.js";

describe("looksLikeHostNotice", () => {
  it.each([
    "⚠️ Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`.",
    "  ⚠️ The AI service is busy.",
  ])("flags %s", (text) => {
    expect(looksLikeHostNotice(text)).toBe(true);
  });

  it.each([
    "The tool run finished, but no final summary was produced. I did not repeat any completed actions.",
    "  the TOOL RUN finished, but NO FINAL SUMMARY WAS PRODUCED.",
    "The agent run failed before producing a reply.",
    "Maaf. I did not repeat any completed actions.",
  ])("flags the runtime's plain-sentence fallback: %s", (text) => {
    expect(looksLikeHostNotice(text)).toBe(true);
    expect(judgeReply({ text })).toBe("fail");
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

describe("isTransientDispatchError", () => {
  const named = (name: string, message: string) => Object.assign(new Error(message), { name });

  it.each([
    named("DispatchSessionRefreshRequiredError", 'Session "agent:krbpro_cs:chatwoot:direct:1-137" changed while starting work. Retry.'),
    new Error("Session x changed while starting work. Retry."),
    named("GatewayDrainingError", "Gateway is temporarily unavailable. Please try again shortly."),
  ])("retries %s", (e) => {
    expect(isTransientDispatchError(e)).toBe(true);
  });

  it.each([
    new Error("agent did not finish within 120000ms"),
    new Error("The tool run finished, but no final summary was produced."),
    new Error("⚠️ Agent couldn't generate a response. Please try again."),
    new Error("429 rate limited"),
    "boom",
    undefined,
  ])("does not retry %s", (e) => {
    expect(isTransientDispatchError(e)).toBe(false);
  });
});
