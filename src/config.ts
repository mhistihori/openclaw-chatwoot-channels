import type {
  ChatwootChannelConfig,
  ChatwootStatus,
  ResolvedChatwootConfig,
} from "./types.js";

export const DEFAULT_WEBHOOK_PATH = "/chatwoot/webhook";
export const DEFAULT_REPLY_TIMEOUT_MS = 120_000;
export const DEFAULT_REPLAY_WINDOW_SECONDS = 300;
export const DEFAULT_HANDOFF_MARKER = "[[HANDOFF]]";

const STATUSES: readonly ChatwootStatus[] = ["pending", "open", "resolved", "snoozed"];

const DEFAULT_HANDOFF_KEYWORDS = [
  "bicara dengan manusia",
  "bicara dengan petugas",
  "hubungkan ke cs",
  "hubungkan ke agen",
  "minta cs",
  "talk to a human",
  "talk to human",
  "speak to a human",
  "speak to an agent",
  "human agent",
];

const DEFAULT_HANDOFF_MESSAGE =
  "Baik, kami hubungkan Anda dengan tim kami. Mohon tunggu sebentar ya.";
const DEFAULT_HANDOFF_NOTE =
  "Bot menyerahkan percakapan ini ke agen manusia. Alasan: {reason}.";
const DEFAULT_HANDOFF_LABEL = "bot-handoff";

export class ChatwootConfigError extends Error {
  constructor(message: string) {
    super(`chatwoot: ${message}`);
    this.name = "ChatwootConfigError";
  }
}

function toPositiveInt(value: unknown, field: string): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new ChatwootConfigError(`${field} must be a positive integer`);
  }
  return n;
}

function readSection(cfg: unknown): ChatwootChannelConfig | undefined {
  const channels = (cfg as { channels?: Record<string, unknown> } | undefined)?.channels;
  const section = channels?.["chatwoot"];
  return section && typeof section === "object" ? (section as ChatwootChannelConfig) : undefined;
}

const ISOLATING_DM_SCOPES = ["per-peer", "per-channel-peer", "per-account-channel-peer"];

/**
 * OpenClaw's default `session.dmScope: "main"` puts every direct message in one rolling
 * session. For customer support that would let one customer's context surface in another's
 * conversation, so the plugin requires a scope that separates peers.
 */
export function checkSessionIsolation(cfg: unknown): { isolated: boolean; dmScope: string } {
  const scope = (cfg as { session?: { dmScope?: string } } | undefined)?.session?.dmScope ?? "main";
  return { isolated: ISOLATING_DM_SCOPES.includes(scope), dmScope: scope };
}

/** Cheap check used by setup and status surfaces. Never throws, never exposes secrets. */
export function inspectChatwootConfig(cfg: unknown): {
  configured: boolean;
  tokenStatus: "available" | "missing";
} {
  const s = readSection(cfg);
  const hasToken = Boolean(s?.apiToken && s.apiToken.trim() !== "");
  const configured = Boolean(s?.baseUrl && s.accountId !== undefined && hasToken);
  return { configured, tokenStatus: hasToken ? "available" : "missing" };
}

/** Validate the `channels.chatwoot` section and apply defaults. Throws on bad config. */
export function resolveChatwootConfig(cfg: unknown): ResolvedChatwootConfig {
  const s = readSection(cfg);
  if (!s) throw new ChatwootConfigError("channels.chatwoot is missing");

  if (!s.baseUrl) throw new ChatwootConfigError("baseUrl is required");
  let baseUrl: URL;
  try {
    baseUrl = new URL(s.baseUrl);
  } catch {
    throw new ChatwootConfigError("baseUrl is not a valid URL");
  }
  if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
    throw new ChatwootConfigError("baseUrl must be http(s)");
  }

  if (!s.apiToken || s.apiToken.trim() === "") {
    throw new ChatwootConfigError("apiToken is required");
  }
  if (s.accountId === undefined) throw new ChatwootConfigError("accountId is required");

  const allowUnsigned = s.allowUnsignedWebhooks === true;
  if (!s.webhookSecret && !allowUnsigned) {
    throw new ChatwootConfigError(
      "webhookSecret is required (or set allowUnsignedWebhooks: true for local development only)",
    );
  }

  const respondStatuses = (s.respondStatuses ?? ["pending"]) as ChatwootStatus[];
  for (const st of respondStatuses) {
    if (!STATUSES.includes(st)) throw new ChatwootConfigError(`unknown status "${String(st)}"`);
  }

  const marker = s.handoff?.marker ?? DEFAULT_HANDOFF_MARKER;
  if (marker.trim() === "") throw new ChatwootConfigError("handoff.marker must not be empty");

  return {
    baseUrl: baseUrl.toString().replace(/\/+$/, ""),
    accountId: toPositiveInt(s.accountId, "accountId"),
    apiToken: s.apiToken.trim(),
    webhookSecret: s.webhookSecret?.trim() || undefined,
    allowUnsignedWebhooks: allowUnsigned,
    webhookPath: s.webhookPath ?? DEFAULT_WEBHOOK_PATH,
    allowedInboxIds: (s.allowedInboxIds ?? []).map((v) => toPositiveInt(v, "allowedInboxIds[]")),
    respondStatuses,
    replyTimeoutMs: s.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS,
    replayWindowSeconds: s.replayWindowSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS,
    stateDir: s.stateDir,
    allowSharedSession: s.allowSharedSession === true,
    includeHumanReplies: s.includeHumanReplies !== false,
    handoff: {
      keywords: (s.handoff?.keywords ?? DEFAULT_HANDOFF_KEYWORDS).map((k) => k.toLowerCase()),
      marker,
      message: s.handoff?.message ?? DEFAULT_HANDOFF_MESSAGE,
      note: s.handoff?.note ?? DEFAULT_HANDOFF_NOTE,
      label: s.handoff?.label ?? DEFAULT_HANDOFF_LABEL,
    },
  };
}
