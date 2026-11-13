#!/usr/bin/env node
// Renders .data/openclaw/openclaw.json for the dev stack from .env and .data/seed.json.
// Usage: node scripts/render-openclaw-config.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readEnv(file) {
  const out = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = readEnv(resolve(root, ".env"));
const seed = JSON.parse(readFileSync(resolve(root, ".data/seed.json"), "utf8"));

const webhookSecret = seed.webhook_secret || seed.bot_secret || undefined;
const port = env.OPENCLAW_PORT || "18789";

const chatwoot = {
  // The gateway container reaches Chatwoot over the compose network.
  baseUrl: "http://chatwoot-rails:3000",
  allowInsecureHttp: true, // plain http inside the compose network only
  accountId: seed.account_id,
  apiToken: seed.api_token,
  allowedInboxIds: [seed.inbox_id],
  stateDir: "/home/node/.openclaw/chatwoot",
  ...(webhookSecret ? { webhookSecret } : { allowUnsignedWebhooks: true }),
};

// With a real provider key in .env the gateway uses its default model. Without one we point
// the agent at the local mock model so the reply path can still be tested end to end.
const hasProviderKey = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"].some((k) => (env[k] ?? "").trim() !== "");
const mockModel = hasProviderKey
  ? {}
  : {
      agents: { defaults: { model: { primary: "mock/mock-1" } } },
      models: {
        mode: "merge",
        providers: {
          mock: {
            baseUrl: "http://mock-llm:8080/v1",
            apiKey: "mock",
            api: "openai-completions",
            timeoutSeconds: 60,
            models: [
              {
                id: "mock-1",
                name: "Mock model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32000,
                maxTokens: 1024,
              },
            ],
          },
        },
      },
    };

// Optional: answer Chatwoot with one specific agent while other agents keep their own channels.
// Set CHATWOOT_AGENT_ID in .env to try the multi-agent setup described in the README.
const agentId = (env.CHATWOOT_AGENT_ID ?? "").trim();
const multiAgent = agentId
  ? {
      agents: {
        ownership: "explicit",
        entries: {
          main: { workspace: "~/.openclaw/workspace" },
          [agentId]: { workspace: `~/.openclaw/workspace-${agentId}` },
        },
      },
      bindings: [{ agentId, comment: "Chatwoot customer support", match: { channel: "chatwoot", accountId: "*" } }],
    }
  : {};

// `agents` can come from both the mock model (defaults) and the multi-agent roster (entries).
const agents = { ...(mockModel.agents ?? {}), ...(multiAgent.agents ?? {}) };

const config = {
  ...(mockModel.models ? { models: mockModel.models } : {}),
  ...(Object.keys(agents).length > 0 ? { agents } : {}),
  ...(multiAgent.bindings ? { bindings: multiAgent.bindings } : {}),
  gateway: {
    mode: "local",
    bind: "lan",
    auth: { mode: "token", token: env.OPENCLAW_GATEWAY_TOKEN },
    controlUi: { allowedOrigins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`] },
  },
  // One agent session per customer. Without this OpenClaw defaults to a single shared session.
  session: { dmScope: "per-channel-peer" },
  plugins: {
    load: { paths: ["/plugin"] },
    entries: { chatwoot: { enabled: true } },
  },
  channels: { chatwoot },
};

const out = resolve(root, ".data/openclaw/openclaw.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(
  `wrote ${out} (${webhookSecret ? "signed webhooks" : "UNSIGNED webhooks: dev only"}; model: ${hasProviderKey ? "provider default" : "local mock"})`,
);
