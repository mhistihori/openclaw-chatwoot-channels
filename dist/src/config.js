export const DEFAULT_WEBHOOK_PATH = "/chatwoot/webhook";
export const DEFAULT_REPLY_TIMEOUT_MS = 120_000;
export const DEFAULT_REPLAY_WINDOW_SECONDS = 300;
export const DEFAULT_HANDOFF_MARKER = "[[HANDOFF]]";
const STATUSES = ["pending", "open", "resolved", "snoozed"];
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
const DEFAULT_HANDOFF_MESSAGE = "Baik, kami hubungkan Anda dengan tim kami. Mohon tunggu sebentar ya.";
const DEFAULT_HANDOFF_NOTE = "Bot menyerahkan percakapan ini ke agen manusia. Alasan: {reason}.";
const DEFAULT_HANDOFF_LABEL = "bot-handoff";
export class ChatwootConfigError extends Error {
    constructor(message) {
        super(`chatwoot: ${message}`);
        this.name = "ChatwootConfigError";
    }
}
function toPositiveInt(value, field) {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
        throw new ChatwootConfigError(`${field} must be a positive integer`);
    }
    return n;
}
/**
 * `allowedInboxIds` as written in `openclaw.json`: an array (`[3, 5]`) or a comma-separated
 * string (`"3,5"`). The string form exists so the list can come from the environment through
 * OpenClaw's own substitution, `allowedInboxIds: "${CHATWOOT_ALLOWED_INBOX_IDS}"`.
 *
 * OpenClaw leaves a reference to a missing or empty variable in place as literal text. For an
 * allowlist that must stop the plugin: treating it as "no list" would silently answer every inbox.
 */
export function parseInboxIds(value) {
    if (value === undefined || value === null)
        return [];
    if (Array.isArray(value))
        return value.map((v) => toPositiveInt(v, "allowedInboxIds[]"));
    if (typeof value !== "string") {
        throw new ChatwootConfigError("allowedInboxIds must be a list of inbox ids or a comma-separated string");
    }
    if (/\$\{[^}]*\}/.test(value)) {
        throw new ChatwootConfigError("allowedInboxIds still contains an environment reference (" +
            value.trim() +
            "). The variable is missing or empty in the gateway's environment; set it, or use a fallback like ${NAME:-3}");
    }
    return value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "")
        .map((part) => toPositiveInt(part, "allowedInboxIds"));
}
function readSection(cfg) {
    const channels = cfg?.channels;
    const section = channels?.["chatwoot"];
    return section && typeof section === "object" ? section : undefined;
}
const ISOLATING_DM_SCOPES = ["per-peer", "per-channel-peer", "per-account-channel-peer"];
/**
 * OpenClaw's default `session.dmScope: "main"` puts every direct message in one rolling
 * session. For customer support that would let one customer's context surface in another's
 * conversation, so the plugin requires a scope that separates peers.
 */
export function checkSessionIsolation(cfg) {
    const scope = cfg?.session?.dmScope ?? "main";
    return { isolated: ISOLATING_DM_SCOPES.includes(scope), dmScope: scope };
}
/** True for hosts that are this machine: traffic to them never leaves it. */
export function isLoopbackHost(hostname) {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}
/** Cheap check used by setup and status surfaces. Never throws, never exposes secrets. */
export function inspectChatwootConfig(cfg) {
    const s = readSection(cfg);
    const hasToken = Boolean(s?.apiToken && s.apiToken.trim() !== "");
    const configured = Boolean(s?.baseUrl && s.accountId !== undefined && hasToken);
    return { configured, tokenStatus: hasToken ? "available" : "missing" };
}
/** Validate the `channels.chatwoot` section and apply defaults. Throws on bad config. */
export function resolveChatwootConfig(cfg) {
    const s = readSection(cfg);
    if (!s)
        throw new ChatwootConfigError("channels.chatwoot is missing");
    if (!s.baseUrl)
        throw new ChatwootConfigError("baseUrl is required");
    let baseUrl;
    try {
        baseUrl = new URL(s.baseUrl);
    }
    catch {
        throw new ChatwootConfigError("baseUrl is not a valid URL");
    }
    if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
        throw new ChatwootConfigError("baseUrl must be http(s)");
    }
    if (baseUrl.username !== "" || baseUrl.password !== "") {
        throw new ChatwootConfigError("baseUrl must not contain credentials; use apiToken");
    }
    // The API token travels in a header on every request, so plain http is only accepted for this
    // machine, or when the operator has said the network between the two is trusted.
    const insecureHttp = baseUrl.protocol === "http:" && !isLoopbackHost(baseUrl.hostname);
    if (insecureHttp && s.allowInsecureHttp !== true) {
        throw new ChatwootConfigError(`baseUrl uses plain http to ${baseUrl.hostname}, which would send the API token unencrypted. ` +
            "Use https, or set allowInsecureHttp: true if this is a private network you trust (for example a Docker or VPC network).");
    }
    if (!s.apiToken || s.apiToken.trim() === "") {
        throw new ChatwootConfigError("apiToken is required");
    }
    if (s.accountId === undefined)
        throw new ChatwootConfigError("accountId is required");
    const allowUnsigned = s.allowUnsignedWebhooks === true;
    if (!s.webhookSecret && !allowUnsigned) {
        throw new ChatwootConfigError("webhookSecret is required (or set allowUnsignedWebhooks: true for local development only)");
    }
    const respondStatuses = (s.respondStatuses ?? ["pending"]);
    for (const st of respondStatuses) {
        if (!STATUSES.includes(st))
            throw new ChatwootConfigError(`unknown status "${String(st)}"`);
    }
    const marker = s.handoff?.marker ?? DEFAULT_HANDOFF_MARKER;
    if (marker.trim() === "")
        throw new ChatwootConfigError("handoff.marker must not be empty");
    return {
        baseUrl: baseUrl.toString().replace(/\/+$/, ""),
        accountId: toPositiveInt(s.accountId, "accountId"),
        apiToken: s.apiToken.trim(),
        webhookSecret: s.webhookSecret?.trim() || undefined,
        allowUnsignedWebhooks: allowUnsigned,
        insecureHttp,
        webhookPath: s.webhookPath ?? DEFAULT_WEBHOOK_PATH,
        allowedInboxIds: parseInboxIds(s.allowedInboxIds),
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
