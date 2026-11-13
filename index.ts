import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { CHANNEL_ID, chatwootPlugin } from "./src/channel.js";
import { createChatwootClient } from "./src/chatwoot-client.js";
import { checkSessionIsolation, resolveChatwootConfig } from "./src/config.js";
import { createDedupeStore } from "./src/dedupe.js";
import { createHumanContextStore } from "./src/human-context.js";
import { ownMessages } from "./src/own-messages.js";
import { createRunAgent } from "./src/dispatch.js";
import { createFailureTracker, judgeReply } from "./src/failures.js";
import { createKeyedQueue } from "./src/queue.js";
import { createWebhookRoute } from "./src/route.js";

export default defineChannelPluginEntry({
  id: "chatwoot",
  name: "Chatwoot",
  description: "Chatwoot channel plugin: two-way customer support conversations with handoff to human agents.",
  plugin: chatwootPlugin,

  registerFull(api) {
    let config;
    try {
      config = resolveChatwootConfig(api.config);
    } catch (e) {
      // Not configured yet is a normal state while the operator is still setting up.
      api.logger.warn(
        `${e instanceof Error ? e.message : String(e)} — webhook route not registered. ` +
          `Fix channels.chatwoot in openclaw.json, then run: openclaw plugins reload chatwoot`,
      );
      return;
    }

    const isolation = checkSessionIsolation(api.config);
    if (!isolation.isolated) {
      if (!config.allowSharedSession) {
        api.logger.error(
          `chatwoot: refusing to start. session.dmScope is "${isolation.dmScope}", so every customer would share one agent session ` +
            `and could see each other's context. Set session.dmScope to "per-channel-peer", or set channels.chatwoot.allowSharedSession: true to override.`,
        );
        return;
      }
      api.logger.warn("chatwoot: allowSharedSession is on. All customers share one agent session.");
    }

    if (config.allowUnsignedWebhooks) {
      api.logger.warn("chatwoot: allowUnsignedWebhooks is on. Anyone who can reach the webhook can talk to your agent. Development only.");
    }

    const client = createChatwootClient({
      baseUrl: config.baseUrl,
      accountId: config.accountId,
      apiToken: config.apiToken,
      logger: api.logger,
    });

    // Cancel replies that are really errors or internal notices before they reach a customer.
    // The hook sees the raw payload (with its flags); `deliver` in dispatch.ts does not.
    // It only ever acts on this channel.
    const failures = createFailureTracker();
    api.on("reply_payload_sending", (event) => {
      if (event.channel !== CHANNEL_ID) return;
      const verdict = judgeReply(event.payload);
      if (verdict === "send") return;
      if (verdict === "fail") failures.record(event.sessionKey, event.payload.text);
      return { cancel: true, reason: verdict === "fail" ? "agent error withheld from customer" : "internal notice" };
    });

    api.registerHttpRoute({
      path: config.webhookPath,
      auth: "plugin", // We verify X-Chatwoot-Signature ourselves.
      match: "exact",
      handler: createWebhookRoute({
        config,
        client,
        dedupe: createDedupeStore(config.stateDir ? { stateDir: config.stateDir } : {}),
        queue: createKeyedQueue(),
        humanContext: createHumanContextStore(config.stateDir ? { stateDir: config.stateDir } : {}),
        ownMessages,
        runAgent: createRunAgent(api, failures),
        log: api.logger,
        schedule: (work) => runDetachedWebhookWork(work),
      }),
    });
    api.logger.info(`chatwoot: webhook listening on ${config.webhookPath} (account ${config.accountId})`);
  },
});
