import { describe, expect, it } from "vitest";
import { classifyWebhook, computeSignature, verifySignature } from "../src/webhook.js";
import { humanPayload, makeConfig, payload } from "./helpers.js";

describe("verifySignature", () => {
  const body = '{"a":1}';
  const now = 1_760_000_000_000;
  const ts = String(now / 1000);
  const base = { secret: "s", rawBody: body, timestamp: ts, nowMs: now, windowSeconds: 300 };

  it("accepts a correct signature", () => {
    expect(verifySignature({ ...base, signature: computeSignature("s", ts, body) })).toEqual({ ok: true });
  });

  it("rejects a signature made with another secret", () => {
    const r = verifySignature({ ...base, signature: computeSignature("other", ts, body) });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered body", () => {
    const r = verifySignature({ ...base, rawBody: '{"a":2}', signature: computeSignature("s", ts, body) });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a stale timestamp (replay)", () => {
    const old = String(now / 1000 - 3600);
    const r = verifySignature({ ...base, timestamp: old, signature: computeSignature("s", old, body) });
    expect(r).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects missing headers", () => {
    expect(verifySignature({ ...base, signature: undefined })).toEqual({ ok: false, reason: "missing_signature" });
    expect(verifySignature({ ...base, signature: "x", timestamp: undefined })).toEqual({ ok: false, reason: "missing_timestamp" });
  });

  it("does not throw on a signature of the wrong length", () => {
    expect(verifySignature({ ...base, signature: "sha256=abc" })).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("classifyWebhook", () => {
  const cfg = makeConfig();

  it("accepts a customer message in a pending conversation", () => {
    const r = classifyWebhook(payload(), cfg);
    expect(r.kind).toBe("accept");
    if (r.kind === "accept") {
      expect(r.job).toMatchObject({ conversationId: 42, messageId: 1001, contactId: 77, contactName: "Budi", inboxId: 5 });
      expect(r.job.timestampMs).toBe(1_760_000_000_000);
    }
  });

  it.each([
    ["other events", { event: "conversation_created" }, "not_message_created"],
    ["outgoing messages", { message_type: "outgoing" }, "not_incoming"],
    ["private notes", { private: true }, "private_note"],
    ["agent senders", { sender: { id: 9, type: "user" } }, "sender_not_contact"],
    ["bot senders", { sender: { id: 9, type: "agent_bot" } }, "sender_not_contact"],
    ["other accounts", { account: { id: 2 } }, "other_account"],
    ["open conversations", { conversation: { id: 42, status: "open", inbox_id: 5 } }, "status_open"],
    ["empty messages", { content: "  " }, "empty"],
  ])("ignores %s", (_name, over, reason) => {
    expect(classifyWebhook(payload(over), cfg)).toEqual({ kind: "ignore", reason });
  });

  it("accepts the numeric message_type used by the REST API", () => {
    expect(classifyWebhook(payload({ message_type: 0 }), cfg).kind).toBe("accept");
  });

  it("filters by inbox allowlist", () => {
    const only7 = makeConfig({ allowedInboxIds: [7] });
    expect(classifyWebhook(payload(), only7)).toEqual({ kind: "ignore", reason: "inbox_not_allowed" });
    const only5 = makeConfig({ allowedInboxIds: [5] });
    expect(classifyWebhook(payload(), only5).kind).toBe("accept");
  });

  it("can answer open conversations when configured", () => {
    const c = makeConfig({ respondStatuses: ["pending", "open"] });
    expect(classifyWebhook(payload({ conversation: { id: 42, status: "open", inbox_id: 5 } }), c).kind).toBe("accept");
  });

  it("describes attachments for the agent", () => {
    const r = classifyWebhook(
      payload({ content: "", attachments: [{ file_type: "image", data_url: "https://chat.example.com/a.png" }] }),
      cfg,
    );
    expect(r.kind).toBe("accept");
    if (r.kind === "accept") expect(r.job.text).toBe("[Attachment: image https://chat.example.com/a.png]");
  });

  it("ignores garbage", () => {
    expect(classifyWebhook("nope", cfg)).toEqual({ kind: "ignore", reason: "not_an_object" });
    expect(classifyWebhook(null, cfg)).toEqual({ kind: "ignore", reason: "not_an_object" });
  });
});

describe("classifyWebhook: human replies", () => {
  const cfg = makeConfig();

  it("recognises a reply written by a human agent, whatever the conversation status", () => {
    const r = classifyWebhook(humanPayload(), cfg);
    expect(r.kind).toBe("human_reply");
    if (r.kind === "human_reply") {
      expect(r.reply).toMatchObject({ conversationId: 42, messageId: 2001, senderName: "Winda" });
      expect(r.reply.text).toContain("Garansi 1 tahun");
    }
  });

  it("accepts the numeric message_type used by the REST API", () => {
    expect(classifyWebhook(humanPayload({ message_type: 1 }), cfg).kind).toBe("human_reply");
  });

  it.each([
    ["a bot message", { sender: { id: 3, name: "OpenClaw", type: "agent_bot" } }, "not_incoming"],
    ["an outgoing message with a contact sender", { sender: { id: 3, type: "contact" } }, "not_incoming"],
    ["a private note", { private: true }, "private_note"],
    ["an empty message", { content: "   " }, "empty"],
    ["another account", { account: { id: 2 } }, "other_account"],
  ])("does not record %s", (_n, over, reason) => {
    expect(classifyWebhook(humanPayload(over), cfg)).toEqual({ kind: "ignore", reason });
  });

  it("respects the inbox allowlist", () => {
    expect(classifyWebhook(humanPayload(), makeConfig({ allowedInboxIds: [7] }))).toEqual({
      kind: "ignore",
      reason: "inbox_not_allowed",
    });
  });

  it("can be turned off", () => {
    expect(classifyWebhook(humanPayload(), makeConfig({ includeHumanReplies: false }))).toEqual({
      kind: "ignore",
      reason: "human_replies_disabled",
    });
  });
});
