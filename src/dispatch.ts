import { dispatchInboundDirectDm } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { CHANNEL_ID } from "./channel.js";
import { judgeReply, type FailureTracker } from "./failures.js";
import type { RunAgent } from "./handler.js";
import { formatPeerId } from "./target.js";

/**
 * Bridge from a filtered Chatwoot message to an OpenClaw agent turn.
 *
 * `dispatchInboundDirectDm` resolves the route (agent + session), records the
 * inbound message, runs the agent and calls `deliver` for every reply payload.
 * Each Chatwoot conversation is one direct peer, so it gets its own session.
 *
 * Failures: the host reports its own errors as ordinary replies, and strips the flag that
 * would identify them before calling `deliver`. The `reply_payload_sending` hook registered in
 * index.ts still sees the raw payload, cancels the error and records it in `failures`; after
 * the turn we read that record and throw, so the handler hands the conversation to a human.
 */
export function createRunAgent(api: OpenClawPluginApi, failures: FailureTracker): RunAgent {
  return async (job, deliver) => {
    let dispatchError: unknown;
    const pending: Array<Promise<void>> = [];

    const { route } = await dispatchInboundDirectDm({
      cfg: api.config,
      channel: CHANNEL_ID,
      channelLabel: "Chatwoot",
      accountId: "default",
      peer: { kind: "direct", id: formatPeerId(job.accountId, job.conversationId) },
      senderId: job.contactId !== undefined ? String(job.contactId) : `conversation-${job.conversationId}`,
      senderAddress: `chatwoot:contact:${job.contactId ?? "unknown"}`,
      recipientAddress: `chatwoot:inbox:${job.inboxId ?? "unknown"}`,
      conversationLabel: `${job.contactName} (#${job.conversationId})`,
      rawBody: job.text,
      messageId: String(job.messageId),
      timestamp: job.timestampMs,
      // Admission already happened in our webhook guard: valid signature, right account and
      // inbox, and a conversation status the bot is allowed to answer.
      inboundAccessAuthorized: true,
      deliver: async (payload) => {
        // Second line of defence. The hook normally cancels errors before they get here, and
        // the host strips the flags, so in practice this only catches the "⚠️" prefix.
        const verdict = judgeReply(payload);
        if (verdict === "drop") return;
        if (verdict === "fail") {
          dispatchError ??= new Error(payload.text?.trim() || "agent reported an error");
          return;
        }
        const p = deliver({
          ...(payload.text !== undefined ? { text: payload.text } : {}),
          ...(payload.mediaUrl !== undefined ? { mediaUrl: payload.mediaUrl } : {}),
          ...(payload.mediaUrls !== undefined ? { mediaUrls: payload.mediaUrls } : {}),
        });
        pending.push(p.catch(() => undefined));
        await p;
      },
      onRecordError: (err) => api.logger.warn(`chatwoot: failed to record inbound session metadata: ${String(err)}`),
      onDispatchError: (err, info) => {
        dispatchError = err;
        api.logger.error(`chatwoot: agent dispatch failed (${info.kind}): ${String(err)}`);
      },
    });

    await Promise.all(pending);

    const cancelled = failures.take(route.sessionKey);
    if (cancelled !== undefined) dispatchError ??= new Error(cancelled);
    // Surface failures to the handler so it can hand the conversation to a human.
    if (dispatchError !== undefined) throw dispatchError instanceof Error ? dispatchError : new Error(String(dispatchError));
  };
}
