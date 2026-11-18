import { describe, expect, it } from "vitest";
import { chatwootPlugin } from "../src/channel.js";
import { buildFormattingHints } from "../src/prompt-hints.js";

const cfg = (extra: Record<string, unknown> = {}) => ({
  channels: { chatwoot: { baseUrl: "https://chat.example.com", accountId: 1, apiToken: "t", webhookSecret: "s", ...extra } },
});
const text = (h: ReturnType<typeof buildFormattingHints>) => h.rules.join("\n");

describe("formatting hints for the agent", () => {
  it("teaches the handoff marker, internal blocks and finishing with an answer", () => {
    const t = text(buildFormattingHints(cfg()));
    expect(t).toContain("[[HANDOFF]]");
    expect(t).toContain("[[INTERNAL]]");
    expect(t).toContain("[[/INTERNAL]]");
    expect(t).toMatch(/always finish with a text answer/);
    expect(buildFormattingHints(cfg()).text_markup).toBe("plain_text");
  });

  it("uses the handoff marker from the config", () => {
    const t = text(buildFormattingHints(cfg({ handoff: { marker: "[[SERAHKAN]]" } })));
    expect(t).toContain("[[SERAHKAN]]");
    expect(t).not.toContain("[[HANDOFF]]");
  });

  it("still works before the channel is configured", () => {
    expect(text(buildFormattingHints({}))).toContain("[[HANDOFF]]");
    expect(text(buildFormattingHints(undefined))).toContain("[[INTERNAL]]");
  });

  it("is what the channel plugin hands to OpenClaw", () => {
    const hints = chatwootPlugin.agentPrompt?.inboundFormattingHints?.({ cfg: cfg() as never, accountId: null });
    expect(hints?.rules.join("\n")).toContain("[[INTERNAL]]");
  });
});
