/**
 * Remembers, per agent session, that the host tried to send an error to the customer and
 * we cancelled it. The agent turn finishes normally from the host's point of view (the error
 * was just another reply), so this is how the dispatcher learns the turn actually failed.
 */
export function createFailureTracker() {
  const failures = new Map<string, string>();
  const UNKNOWN = "";

  return {
    /**
     * The first failure of a turn wins. After an error the host often adds a generic follow-up
     * ("OpenClaw couldn't produce or deliver a reply"); the first message is the useful one.
     */
    record(sessionKey: string | undefined, text: string | undefined): void {
      const key = sessionKey ?? UNKNOWN;
      if (!failures.has(key)) failures.set(key, text?.trim() || "agent reported an error");
    },
    /** Returns and clears the failure for this session (or one recorded without a session key). */
    take(sessionKey: string): string | undefined {
      const text = failures.get(sessionKey) ?? failures.get(UNKNOWN);
      failures.delete(sessionKey);
      failures.delete(UNKNOWN);
      return text;
    },
  };
}

export type FailureTracker = ReturnType<typeof createFailureTracker>;

/**
 * Sentences the OpenClaw runtime sends as an ordinary reply, with no flag, when a turn produced
 * no answer. They are plumbing, never something to show a customer. These come from the
 * runtime itself (OpenClaw 2026.11.3, `SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT` and
 * `GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT`); the lower-case fragments below are matched anywhere
 * in the text. If a later version words them differently the empty-turn rule in the handler
 * (a turn that sent nothing is handed to a human) still catches the result.
 */
const HOST_NOTICE_FRAGMENTS = [
  "no final summary was produced",
  "i did not repeat any completed actions",
  "the agent run failed before producing a reply",
];

/**
 * OpenClaw renders some failures as "⚠️ <explanation>" without any flag we can see, and some as
 * a plain sentence (see above). An agent answer that starts with ⚠️ or contains one of those
 * sentences is treated as a failed turn: that errs towards a human taking over, which is the safe side.
 */
export function looksLikeHostNotice(text: string | undefined): boolean {
  if (typeof text !== "string") return false;
  if (/^\s*⚠️/u.test(text)) return true;
  const lower = text.toLowerCase();
  return HOST_NOTICE_FRAGMENTS.some((f) => lower.includes(f));
}

export interface ReplyPayloadFlags {
  text?: string;
  isError?: boolean;
  isReasoning?: boolean;
  isCommentary?: boolean;
  isCompactionNotice?: boolean;
}

export type ReplyVerdict = "send" | "drop" | "fail";

/** What to do with a reply on its way to a customer. */
export function judgeReply(payload: ReplyPayloadFlags): ReplyVerdict {
  // Reasoning, tool commentary and compaction notices are internal. Drop them silently.
  if (payload.isReasoning || payload.isCommentary || payload.isCompactionNotice) return "drop";
  // Errors must never reach a customer. They become a handoff instead.
  if (payload.isError || looksLikeHostNotice(payload.text)) return "fail";
  return "send";
}
