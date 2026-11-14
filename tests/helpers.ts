import { vi } from "vitest";
import type { ChatwootClient } from "../src/chatwoot-client.js";
import { resolveChatwootConfig } from "../src/config.js";
import { createDedupeStore } from "../src/dedupe.js";
import { createHumanContextStore } from "../src/human-context.js";
import { createOwnMessageTracker } from "../src/own-messages.js";
import type { HandlerDeps, RunAgent } from "../src/handler.js";
import { createActiveTurns } from "../src/active-turns.js";
import { createMessageBatcher } from "../src/batch.js";
import { createKeyedQueue } from "../src/queue.js";
import type { ResolvedChatwootConfig } from "../src/types.js";
import { computeSignature } from "../src/webhook.js";

export const SECRET = "test-secret";

export function makeConfig(over: Record<string, unknown> = {}): ResolvedChatwootConfig {
  return resolveChatwootConfig({
    channels: {
      chatwoot: {
        baseUrl: "https://chat.example.com",
        accountId: 1,
        apiToken: "tok",
        webhookSecret: SECRET,
        replyTimeoutMs: 200,
        messageDebounceMs: 0,
        ...over,
      },
    },
  });
}

/** A realistic `message_created` payload for a customer message. */
export function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "message_created",
    id: 1001,
    content: "Halo, pesanan saya belum sampai",
    message_type: "incoming",
    private: false,
    created_at: 1_760_000_000,
    sender: { id: 77, name: "Budi", type: "contact" },
    account: { id: 1 },
    inbox: { id: 5 },
    conversation: { id: 42, status: "pending", inbox_id: 5 },
    ...over,
  };
}

/** A message a human agent (Winda) sent to the customer. */
export function humanPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return payload({
    id: 2001,
    content: "Halo, saya Winda. Garansi 1 tahun, klaim lewat nomor pesanan.",
    message_type: "outgoing",
    sender: { id: 9, name: "Winda", type: "user" },
    conversation: { id: 42, status: "open", inbox_id: 5 },
    ...over,
  });
}

export function signed(body: unknown, nowMs = Date.now(), secret = SECRET) {
  return signedRaw(JSON.stringify(body), nowMs, secret);
}

export function signedRaw(rawBody: string, nowMs = Date.now(), secret = SECRET) {
  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    rawBody,
    headers: {
      "x-chatwoot-signature": computeSignature(secret, timestamp, rawBody),
      "x-chatwoot-timestamp": timestamp,
    } as Record<string, string | undefined>,
  };
}

export interface FakeClient extends ChatwootClient {
  calls: Array<{ op: string; args: unknown[] }>;
}

export function fakeClient(failOn: string[] = []): FakeClient {
  const calls: FakeClient["calls"] = [];
  let nextMessageId = 5000;
  const op =
    <T>(name: string, value: () => T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push({ op: name, args });
      if (failOn.includes(name)) throw new Error(`${name} failed`);
      return value();
    };
  return {
    calls,
    sendMessage: op("sendMessage", () => ({ id: ++nextMessageId })) as ChatwootClient["sendMessage"],
    setStatus: op("setStatus", () => undefined) as ChatwootClient["setStatus"],
    addLabels: op("addLabels", () => undefined) as ChatwootClient["addLabels"],
  };
}

export function makeDeps(runAgent: RunAgent, client = fakeClient(), config = makeConfig()): HandlerDeps & { client: FakeClient } {
  return {
    config,
    client,
    dedupe: createDedupeStore(),
    queue: createKeyedQueue(),
    active: createActiveTurns(),
    batcher: createMessageBatcher({ debounceMs: config.messageDebounceMs }),
    humanContext: createHumanContextStore(),
    ownMessages: createOwnMessageTracker(),
    runAgent,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}
