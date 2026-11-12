import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { chatwootPlugin } from "./src/channel.js";
import { createChatwootClient } from "./src/chatwoot-client.js";
import { checkSessionIsolation, resolveChatwootConfig } from "./src/config.js";
import { createDedupeStore } from "./src/dedupe.js";
import { createRunAgent } from "./src/dispatch.js";
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
        }
        catch (e) {
            // Not configured yet is a normal state while the operator is still setting up.
            api.logger.warn(`${e instanceof Error ? e.message : String(e)} — webhook route not registered`);
            return;
        }
        const isolation = checkSessionIsolation(api.config);
        if (!isolation.isolated) {
            if (!config.allowSharedSession) {
                api.logger.error(`chatwoot: refusing to start. session.dmScope is "${isolation.dmScope}", so every customer would share one agent session ` +
                    `and could see each other's context. Set session.dmScope to "per-channel-peer", or set channels.chatwoot.allowSharedSession: true to override.`);
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
        api.registerHttpRoute({
            path: config.webhookPath,
            auth: "plugin", // We verify X-Chatwoot-Signature ourselves.
            match: "exact",
            handler: createWebhookRoute({
                config,
                client,
                dedupe: createDedupeStore(config.stateDir ? { stateDir: config.stateDir } : {}),
                queue: createKeyedQueue(),
                runAgent: createRunAgent(api),
                log: api.logger,
                schedule: (work) => runDetachedWebhookWork(work),
            }),
        });
        api.logger.info(`chatwoot: webhook listening on ${config.webhookPath} (account ${config.accountId})`);
    },
});
