export class ChatwootApiError extends Error {
    status;
    retryable;
    constructor(message, status, retryable) {
        super(message);
        this.status = status;
        this.retryable = retryable;
        this.name = "ChatwootApiError";
    }
}
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Split text so a single message stays under channel limits (WhatsApp is the strictest at 4096). */
export function chunkText(text, limit = 4000) {
    if (text.length <= limit)
        return [text];
    const chunks = [];
    let rest = text;
    while (rest.length > limit) {
        let cut = rest.lastIndexOf("\n\n", limit);
        if (cut < limit / 2)
            cut = rest.lastIndexOf("\n", limit);
        if (cut < limit / 2)
            cut = rest.lastIndexOf(" ", limit);
        if (cut < limit / 2)
            cut = limit;
        chunks.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    if (rest !== "")
        chunks.push(rest);
    return chunks;
}
export function createChatwootClient(opts) {
    const doFetch = opts.fetch ?? fetch;
    const sleep = opts.sleep ?? defaultSleep;
    const maxAttempts = opts.maxAttempts ?? 3;
    const baseDelay = opts.baseDelayMs ?? 500;
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const root = `${opts.baseUrl.replace(/\/+$/, "")}/api/v1/accounts/${opts.accountId}`;
    async function request(method, path, body) {
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const res = await doFetch(`${root}${path}`, {
                    method,
                    headers: { "content-type": "application/json", api_access_token: opts.apiToken },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(timeoutMs),
                });
                if (res.ok) {
                    const text = await res.text();
                    return text === "" ? {} : JSON.parse(text);
                }
                const retryable = res.status === 429 || res.status >= 500;
                const detail = (await res.text().catch(() => "")).slice(0, 200);
                const err = new ChatwootApiError(`${method} ${path} -> ${res.status} ${detail}`, res.status, retryable);
                if (!retryable)
                    throw err;
                lastError = err;
            }
            catch (e) {
                if (e instanceof ChatwootApiError && !e.retryable)
                    throw e;
                lastError = e;
            }
            if (attempt < maxAttempts) {
                const delay = baseDelay * 2 ** (attempt - 1);
                opts.logger?.warn(`chatwoot: ${method} ${path} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`);
                await sleep(delay);
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    return {
        async sendMessage(conversationId, content, o) {
            const res = (await request("POST", `/conversations/${conversationId}/messages`, {
                content,
                message_type: "outgoing",
                private: o?.private === true,
            }));
            return { id: typeof res.id === "number" ? res.id : undefined };
        },
        async setStatus(conversationId, status) {
            await request("POST", `/conversations/${conversationId}/toggle_status`, { status });
        },
        async addLabels(conversationId, labels) {
            await request("POST", `/conversations/${conversationId}/labels`, { labels });
        },
    };
}
