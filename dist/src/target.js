/**
 * OpenClaw addresses a conversation by a single string. For Chatwoot that is
 * `<chatwootAccountId>-<conversationId>`: conversation ids are only unique
 * inside one Chatwoot account, so the account id is part of the peer id.
 */
export function formatPeerId(accountId, conversationId) {
    return `${accountId}-${conversationId}`;
}
/** Accepts `chatwoot:5-123`, `5-123` and a bare `123`. */
export function parseTarget(to) {
    const bare = to.replace(/^chatwoot:/i, "").trim();
    const m = /^(?:(\d+)-)?(\d+)$/.exec(bare);
    if (!m)
        return undefined;
    return { accountId: m[1] ? Number(m[1]) : undefined, conversationId: Number(m[2]) };
}
