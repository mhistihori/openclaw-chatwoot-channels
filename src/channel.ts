import { createChannelPluginBase, createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { chunkText, createChatwootClient } from "./chatwoot-client.js";
import { inspectChatwootConfig, resolveChatwootConfig } from "./config.js";
import { parseTarget } from "./target.js";
import type { ResolvedChatwootConfig } from "./types.js";

export const CHANNEL_ID = "chatwoot";

export interface ResolvedAccount {
  accountId: string | null;
  config: ResolvedChatwootConfig;
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedAccount {
  return { accountId: accountId ?? null, config: resolveChatwootConfig(cfg) };
}

/** Send a proactive message (for example from the agent's message tool) into a conversation. */
async function sendText(cfg: OpenClawConfig, to: string, text: string): Promise<{ messageId: string }> {
  const target = parseTarget(to);
  if (!target) throw new Error(`chatwoot: cannot parse target "${to}" (expected <accountId>-<conversationId>)`);
  const config = resolveChatwootConfig(cfg);
  if (target.accountId !== undefined && target.accountId !== config.accountId) {
    throw new Error(`chatwoot: target account ${target.accountId} does not match configured account ${config.accountId}`);
  }
  const client = createChatwootClient({
    baseUrl: config.baseUrl,
    accountId: config.accountId,
    apiToken: config.apiToken,
  });
  let lastId: number | undefined;
  for (const part of chunkText(text)) {
    lastId = (await client.sendMessage(target.conversationId, part)).id ?? lastId;
  }
  return { messageId: String(lastId ?? "") };
}

const accountConfig: NonNullable<ChannelPlugin<ResolvedAccount>["config"]> = {
  listAccountIds: () => ["default"],
  resolveAccount,
  inspectAccount(cfg) {
    const { configured, tokenStatus } = inspectChatwootConfig(cfg);
    return { enabled: configured, configured, tokenStatus };
  },
};

export const chatwootPlugin = createChatChannelPlugin<ResolvedAccount>({
  base: {
    ...createChannelPluginBase<ResolvedAccount>({
      id: CHANNEL_ID,
      meta: {
        label: "Chatwoot",
        selectionLabel: "Chatwoot (customer support inbox)",
        docsPath: "/channels/chatwoot",
        blurb: "Answer Chatwoot conversations with an OpenClaw agent and hand off to human agents.",
      },
      setup: {
        applyAccountConfig: ({ cfg, input }) => {
          const channels = (cfg.channels ?? {}) as Record<string, unknown>;
          const current = (channels[CHANNEL_ID] ?? {}) as Record<string, unknown>;
          return { ...cfg, channels: { ...channels, [CHANNEL_ID]: { ...current, ...input } } };
        },
      },
    }),
    // createChannelPluginBase leaves `config` optional; the chat plugin requires it.
    config: accountConfig,
    // Chatwoot pushes to our webhook, so there is no connection to open. The gateway still
    // expects a running account, otherwise its health monitor restarts the channel in a loop.
    gateway: {
      async startAccount(ctx) {
        ctx.setStatus({ ...ctx.getStatus(), accountId: ctx.accountId, running: true, lifecycle: "ready" });
        await new Promise<void>((resolve) => {
          if (ctx.abortSignal.aborted) resolve();
          else ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    },
  },

  outbound: {
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async (params) => sendText(params.cfg, params.to, params.text),
    },
  },
});
