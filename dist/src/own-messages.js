const norm = (text) => text.trim().replace(/\s+/g, " ");
export function createOwnMessageTracker(opts = {}) {
    const now = opts.now ?? Date.now;
    const ttl = opts.expectTtlMs ?? 2 * 60 * 1000;
    const maxIds = opts.maxIds ?? 5000;
    const maxExpected = opts.maxExpected ?? 2000;
    const ids = new Set();
    let expected = [];
    function rememberId(id) {
        ids.add(id);
        if (ids.size > maxIds) {
            const oldest = ids.values().next().value;
            if (oldest !== undefined)
                ids.delete(oldest);
        }
    }
    return {
        /** Call right before sending `text` into a conversation. */
        expect(conversationId, text) {
            const t = now();
            expected = expected.filter((e) => e.t >= t - ttl);
            expected.push({ conversationId, text: norm(text), t });
            if (expected.length > maxExpected)
                expected.shift();
        },
        /** Call with the id Chatwoot returned for a message that was sent. */
        add(id) {
            if (id !== undefined)
                rememberId(id);
        },
        /** Is this webhook message one the plugin sent itself? A text match is used up once. */
        matches(conversationId, id, text) {
            if (ids.has(id))
                return true;
            const t = now();
            const wanted = norm(text);
            const i = expected.findIndex((e) => e.conversationId === conversationId && e.text === wanted && e.t >= t - ttl);
            if (i === -1)
                return false;
            expected.splice(i, 1);
            rememberId(id);
            return true;
        },
        has: (id) => ids.has(id),
    };
}
/** Process-wide instance, shared by the webhook handler and the outbound adapter. */
export const ownMessages = createOwnMessageTracker();
