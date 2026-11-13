/**
 * Tells the plugin's own messages apart from a human agent's.
 *
 * When the configured token belongs to a human user instead of a bot, Chatwoot reports the bot's
 * own replies as messages from a human agent. Without a guard they would be fed back to the bot
 * as "what the human said".
 *
 * Message ids alone are not enough: Chatwoot queues the webhook as soon as it stores the message,
 * and it can reach the gateway before the API response carrying the id has been read. So the
 * plugin announces the text it is about to send (`expect`) and the webhook is matched against
 * that; ids are remembered as well, for the cases where the text was altered.
 */
export interface OwnMessageOptions {
  now?: () => number;
  /** How long an announced text can still match a webhook. */
  expectTtlMs?: number;
  maxIds?: number;
  maxExpected?: number;
}

const norm = (text: string): string => text.trim().replace(/\s+/g, " ");

export function createOwnMessageTracker(opts: OwnMessageOptions = {}) {
  const now = opts.now ?? Date.now;
  const ttl = opts.expectTtlMs ?? 2 * 60 * 1000;
  const maxIds = opts.maxIds ?? 5000;
  const maxExpected = opts.maxExpected ?? 2000;
  const ids = new Set<number>();
  let expected: Array<{ conversationId: number; text: string; t: number }> = [];

  function rememberId(id: number) {
    ids.add(id);
    if (ids.size > maxIds) {
      const oldest = ids.values().next().value;
      if (oldest !== undefined) ids.delete(oldest);
    }
  }

  return {
    /** Call right before sending `text` into a conversation. */
    expect(conversationId: number, text: string): void {
      const t = now();
      expected = expected.filter((e) => e.t >= t - ttl);
      expected.push({ conversationId, text: norm(text), t });
      if (expected.length > maxExpected) expected.shift();
    },
    /** Call with the id Chatwoot returned for a message that was sent. */
    add(id: number | undefined): void {
      if (id !== undefined) rememberId(id);
    },
    /** Is this webhook message one the plugin sent itself? A text match is used up once. */
    matches(conversationId: number, id: number, text: string): boolean {
      if (ids.has(id)) return true;
      const t = now();
      const wanted = norm(text);
      const i = expected.findIndex((e) => e.conversationId === conversationId && e.text === wanted && e.t >= t - ttl);
      if (i === -1) return false;
      expected.splice(i, 1);
      rememberId(id);
      return true;
    },
    has: (id: number): boolean => ids.has(id),
  };
}

export type OwnMessageTracker = ReturnType<typeof createOwnMessageTracker>;

/** Process-wide instance, shared by the webhook handler and the outbound adapter. */
export const ownMessages: OwnMessageTracker = createOwnMessageTracker();
