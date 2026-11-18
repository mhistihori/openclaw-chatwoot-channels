import { DEFAULT_HANDOFF_MARKER, resolveChatwootConfig } from "./config.js";
import { INTERNAL_CLOSE, INTERNAL_OPEN } from "./internal.js";

export interface FormattingHints {
  text_markup: string;
  rules: string[];
}

/**
 * The delivery contract OpenClaw adds to the agent's system prompt on every turn whose reply goes
 * to Chatwoot. It teaches the agent the plugin's own mechanics (how to hand over, how to keep
 * something from the customer) so they do not have to be copied into every agent's instructions.
 * Business rules (tone, prices, policy) stay in the agent's own prompt.
 */
export function buildFormattingHints(cfg: unknown): FormattingHints {
  let marker = DEFAULT_HANDOFF_MARKER;
  try {
    marker = resolveChatwootConfig(cfg).handoff.marker;
  } catch {
    // Not configured yet: the defaults are still correct for a first start.
  }
  return {
    text_markup: "plain_text",
    rules: [
      "Everything you write in your reply is sent to the customer in Chatwoot. Write nothing the customer must not read.",
      "Plain text only: no Markdown headings, tables or code blocks. Short lines and simple '- ' lists are fine.",
      `To hand this conversation to a human agent, put ${marker} in your reply. It is removed before the message is sent.`,
      `For the human team only (reports, costs, internal notes), wrap it in ${INTERNAL_OPEN} and ${INTERNAL_CLOSE}. It becomes a private note and is never shown to the customer. Always close the tag.`,
      "After using tools, always finish with a text answer for the customer.",
    ],
  };
}
