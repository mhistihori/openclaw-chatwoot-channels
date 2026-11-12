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
 * OpenClaw renders some failures as "⚠️ <explanation>" without any flag we can see. An agent
 * that starts a customer-facing answer with ⚠️ is treated the same way: that errs towards a
 * human taking over, which is the safe side.
 */
export function looksLikeHostNotice(text: string | undefined): boolean {
  return typeof text === "string" && /^\s*⚠️/u.test(text);
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
