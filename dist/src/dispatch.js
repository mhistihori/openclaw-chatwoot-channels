import { dispatchInboundDirectDm } from "openclaw/plugin-sdk/channel-inbound";
import { CHANNEL_ID } from "./channel.js";
import { formatPeerId } from "./target.js";
/**
 * OpenClaw renders its own failures as "⚠️ <explanation>" and delivers them like any other
 * reply, without a flag we can see. An agent that starts a customer-facing answer with ⚠️ is
 * also treated as a failure: that errs towards a human taking over, which is the safe side.
 */
export function looksLikeHostNotice(text) {
    return typeof text === "string" && /^\s*⚠️/u.test(text);
}
/**
 * Bridge from a filtered Chatwoot message to an OpenClaw agent turn.
 *
 * `dispatchInboundDirectDm` resolves the route (agent + session), records the
 * inbound message, runs the agent and calls `deliver` for every reply payload.
 * Each Chatwoot conversation is one direct peer, so it gets its own session.
 */
export function createRunAgent(api) {
    return async (job, deliver) => {
        let dispatchError;
        const pending = [];
        await dispatchInboundDirectDm({
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
                // `dispatchInboundDirectDm` strips the isError/isReasoning flags before calling us (verified
                // against 2026.11.3), so these casts only matter if a future host stops doing that.
                const flags = payload;
                // The host also routes its own notices through `deliver` (for example "couldn't sign in
                // to the AI service"). Customers must never see them: they become a handoff, and the
                // text goes to the human agent's private note instead.
                if (flags.isReasoning || flags.isCommentary || flags.isCompactionNotice)
                    return;
                if (flags.isError || looksLikeHostNotice(payload.text)) {
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
        // Surface failures to the handler so it can hand the conversation to a human.
        if (dispatchError !== undefined)
            throw dispatchError instanceof Error ? dispatchError : new Error(String(dispatchError));
    };
}
