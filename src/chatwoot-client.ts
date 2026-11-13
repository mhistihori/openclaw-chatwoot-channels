import type { ChatwootStatus, Logger } from "./types.js";

export interface ChatwootClient {
  sendMessage(conversationId: number, content: string, opts?: { private?: boolean }): Promise<{ id?: number }>;
  setStatus(conversationId: number, status: ChatwootStatus): Promise<void>;
  addLabels(conversationId: number, labels: string[]): Promise<void>;
}

export interface ClientOptions {
  baseUrl: string;
  accountId: number;
  apiToken: string;
  fetch?: typeof fetch;
  logger?: Logger;
  maxAttempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class ChatwootApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ChatwootApiError";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Split text so a single message stays under channel limits (WhatsApp is the strictest at 4096). */
export function chunkText(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== "") chunks.push(rest);
  return chunks;
}

export function createChatwootClient(opts: ClientOptions): ChatwootClient {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const root = `${opts.baseUrl.replace(/\/+$/, "")}/api/v1/accounts/${opts.accountId}`;

  async function request(method: string, path: string, body: unknown): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await doFetch(`${root}${path}`, {
          method,
          headers: { "content-type": "application/json", api_access_token: opts.apiToken },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
          // The token is a custom header, which fetch does not strip on a cross-origin redirect,
          // so a redirect could hand it to another host. Chatwoot's API does not redirect.
          redirect: "error",
        });
        if (res.ok) {
          const text = await res.text();
          return text === "" ? {} : JSON.parse(text);
        }
        const retryable = res.status === 429 || res.status >= 500;
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        const err = new ChatwootApiError(`${method} ${path} -> ${res.status} ${detail}`, res.status, retryable);
        if (!retryable) throw err;
        lastError = err;
      } catch (e) {
        if (e instanceof ChatwootApiError && !e.retryable) throw e;
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
      })) as { id?: number };
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
