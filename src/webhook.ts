import { createHmac, timingSafeEqual } from "node:crypto";
import type { InboundAttachment, InboundJob, ResolvedChatwootConfig } from "./types.js";

export type SignatureResult = { ok: true } | { ok: false; reason: string };

export interface VerifyParams {
  secret: string;
  rawBody: string;
  /** Value of `X-Chatwoot-Signature`, shaped `sha256=<hex>`. */
  signature: string | undefined;
  /** Value of `X-Chatwoot-Timestamp`, epoch seconds. */
  timestamp: string | undefined;
  nowMs: number;
  windowSeconds: number;
}

/** Chatwoot signs `"<timestamp>.<raw body>"` with HMAC-SHA256. */
export function computeSignature(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function verifySignature(p: VerifyParams): SignatureResult {
  if (!p.signature) return { ok: false, reason: "missing_signature" };
  if (!p.timestamp) return { ok: false, reason: "missing_timestamp" };

  const ts = Number(p.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(p.nowMs / 1000 - ts) > p.windowSeconds) return { ok: false, reason: "stale_timestamp" };

  const expected = Buffer.from(computeSignature(p.secret, p.timestamp, p.rawBody));
  const received = Buffer.from(p.signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

export type Classification =
  | { kind: "accept"; job: InboundJob }
  | { kind: "ignore"; reason: string };

type Dict = Record<string, unknown>;

function asDict(v: unknown): Dict | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Chatwoot sends `message_type` as "incoming" in webhooks and 0 in the REST API. */
function isIncoming(messageType: unknown): boolean {
  return messageType === "incoming" || messageType === 0;
}

function readAttachments(payload: Dict): InboundAttachment[] {
  const raw = payload["attachments"];
  if (!Array.isArray(raw)) return [];
  const out: InboundAttachment[] = [];
  for (const item of raw) {
    const d = asDict(item);
    const url = asString(d?.["data_url"]) ?? asString(d?.["thumb_url"]);
    if (url) out.push({ type: asString(d?.["file_type"]) ?? "file", url });
  }
  return out;
}

/**
 * Decide whether a webhook payload is a customer message the bot should answer.
 * Everything else (agent replies, private notes, other events, wrong status) is
 * ignored so the bot never answers itself or talks over a human.
 */
export function classifyWebhook(payload: unknown, cfg: ResolvedChatwootConfig): Classification {
  const p = asDict(payload);
  if (!p) return { kind: "ignore", reason: "not_an_object" };

  if (p["event"] !== "message_created") return { kind: "ignore", reason: "not_message_created" };
  if (!isIncoming(p["message_type"])) return { kind: "ignore", reason: "not_incoming" };
  if (p["private"] === true) return { kind: "ignore", reason: "private_note" };

  const sender = asDict(p["sender"]);
  const senderType = asString(sender?.["type"]);
  if (senderType !== undefined && senderType !== "contact") {
    return { kind: "ignore", reason: "sender_not_contact" };
  }

  const account = asDict(p["account"]);
  const accountId = asNumber(account?.["id"]);
  if (accountId !== undefined && accountId !== cfg.accountId) {
    return { kind: "ignore", reason: "other_account" };
  }

  const conversation = asDict(p["conversation"]);
  const conversationId = asNumber(conversation?.["id"]);
  if (conversationId === undefined) return { kind: "ignore", reason: "no_conversation" };

  const inboxId = asNumber(asDict(p["inbox"])?.["id"]) ?? asNumber(conversation?.["inbox_id"]);
  if (cfg.allowedInboxIds.length > 0 && (inboxId === undefined || !cfg.allowedInboxIds.includes(inboxId))) {
    return { kind: "ignore", reason: "inbox_not_allowed" };
  }

  const status = asString(conversation?.["status"]);
  if (!status || !(cfg.respondStatuses as string[]).includes(status)) {
    return { kind: "ignore", reason: `status_${status ?? "unknown"}` };
  }

  const messageId = asNumber(p["id"]);
  if (messageId === undefined) return { kind: "ignore", reason: "no_message_id" };

  const attachments = readAttachments(p);
  const content = (asString(p["content"]) ?? "").trim();
  if (content === "" && attachments.length === 0) return { kind: "ignore", reason: "empty" };

  const hints = attachments.map((a) => `[Attachment: ${a.type} ${a.url}]`);
  const text = [content, ...hints].filter((s) => s !== "").join("\n");

  const createdAt = asNumber(p["created_at"]);
  const timestampMs = createdAt !== undefined ? createdAt * (createdAt < 1e12 ? 1000 : 1) : Date.now();

  return {
    kind: "accept",
    job: {
      accountId: cfg.accountId,
      conversationId,
      inboxId,
      messageId,
      contactId: asNumber(sender?.["id"]),
      contactName: asString(sender?.["name"]) ?? "Customer",
      text,
      timestampMs,
      attachments,
    },
  };
}

/** Parse a raw body. Returns undefined when it is not valid JSON. */
export function parseBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}
