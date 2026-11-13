/** Conversation statuses used by Chatwoot. */
export type ChatwootStatus = "pending" | "open" | "resolved" | "snoozed";

/** Raw `channels.chatwoot` section as written by the operator. */
export interface ChatwootChannelConfig {
  baseUrl?: string;
  accountId?: number | string;
  /** Chatwoot user access token or AgentBot access token. */
  apiToken?: string;
  /** Secret used to verify `X-Chatwoot-Signature` (HMAC-SHA256). */
  webhookSecret?: string;
  /** Development only: accept webhooks without a signature. */
  allowUnsignedWebhooks?: boolean;
  webhookPath?: string;
  /** Only react to these inboxes. Empty or missing means all inboxes. */
  allowedInboxIds?: Array<number | string>;
  /** The bot only answers conversations in these statuses. Default: ["pending"]. */
  respondStatuses?: ChatwootStatus[];
  /** Give up on the agent after this long and hand off to a human. */
  replyTimeoutMs?: number;
  /** Reject webhooks whose timestamp is older than this. */
  replayWindowSeconds?: number;
  /** Directory for the durable dedupe log. In-memory only when missing. */
  stateDir?: string;
  /**
   * By default the plugin refuses to start unless OpenClaw gives every customer their own
   * session (`session.dmScope` other than "main"). Set true only if you really want all
   * customers to share one conversation context.
   */
  allowSharedSession?: boolean;
  /**
   * Remember what human agents write to a customer and show it to the bot with the customer's
   * next message, so the bot knows what was said while it was not in charge. Default: true.
   */
  includeHumanReplies?: boolean;
  handoff?: {
    /** Customer phrases that skip the agent and go straight to a human. */
    keywords?: string[];
    /** Token the agent can put in a reply to request a handoff. */
    marker?: string;
    /** Message shown to the customer on handoff. Empty string disables it. */
    message?: string;
    /** Private note left for the human agent. */
    note?: string;
    /** Label added to the conversation on handoff. Empty string disables it. */
    label?: string;
  };
}

export interface ResolvedHandoffConfig {
  keywords: string[];
  marker: string;
  message: string;
  note: string;
  label: string;
}

export interface ResolvedChatwootConfig {
  baseUrl: string;
  accountId: number;
  apiToken: string;
  webhookSecret: string | undefined;
  allowUnsignedWebhooks: boolean;
  webhookPath: string;
  allowedInboxIds: number[];
  respondStatuses: ChatwootStatus[];
  replyTimeoutMs: number;
  replayWindowSeconds: number;
  stateDir: string | undefined;
  allowSharedSession: boolean;
  includeHumanReplies: boolean;
  handoff: ResolvedHandoffConfig;
}

export interface InboundAttachment {
  type: string;
  url: string;
}

/** A customer message that passed every filter and is ready for the agent. */
export interface InboundJob {
  accountId: number;
  conversationId: number;
  inboxId: number | undefined;
  messageId: number;
  contactId: number | undefined;
  contactName: string;
  /** Text handed to the agent, including attachment hints. */
  text: string;
  timestampMs: number;
  attachments: InboundAttachment[];
}

/** A message a human agent sent to the customer. Never answered; only remembered as context. */
export interface HumanReply {
  accountId: number;
  conversationId: number;
  messageId: number;
  senderName: string;
  text: string;
  timestampMs: number;
}

/** What an agent reply looks like by the time it reaches `deliver`. */
export interface ReplyPayload {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}
