# openclaw-chatwoot-channels

An [OpenClaw](https://docs.openclaw.ai) channel plugin for [Chatwoot](https://www.chatwoot.com). A customer writes in a Chatwoot inbox, an OpenClaw agent answers, and when the bot cannot help the conversation is handed to a human agent.

Unlike a webhook-only integration, this is a real two-way channel: OpenClaw owns the session, the agent's replies are delivered back into the same Chatwoot conversation, and the plugin itself takes care of retry and handoff, so the agent does not need Chatwoot tools to answer.

> Status: early. Unit tests cover the webhook, handler, client and config. See [Verification](#verification) for what has and has not been exercised against a live Chatwoot.

## How it works

```
Customer ──► Chatwoot ──(webhook, signed)──► OpenClaw gateway ──► this plugin
                 ▲                                                    │
                 │                                       verify · filter · dedupe
                 │                                                    ▼
                 └──────── Chatwoot API ◄── reply / handoff ◄── agent turn (session per conversation)
```

1. Chatwoot posts `message_created` to `POST <gateway>/chatwoot/webhook`.
2. The plugin verifies `X-Chatwoot-Signature` (HMAC-SHA256 over `"<timestamp>.<raw body>"`, replay window 5 min).
3. It only accepts **incoming customer messages** in conversations whose status the bot may answer (default `pending`). Agent replies, private notes, bot messages, other accounts and other inboxes are ignored, so the bot never answers itself or talks over a human.
4. Webhooks are at-least-once, so each message is claimed once (message id and delivery id), optionally durable across restarts.
5. Turns run one at a time per conversation. Each Chatwoot conversation is its own OpenClaw session (`<accountId>-<conversationId>`).
6. Replies go back through the Chatwoot Messages API with retry and backoff, split to stay under channel limits.

### Handoff to a human

The conversation is set to `open` (which stops the bot), the customer gets a message, a private note explains why, and a `bot-handoff` label is added. It happens when:

- the customer asks for a person (phrases in `handoff.keywords`);
- the agent includes the marker `[[HANDOFF]]` in a reply (the marker is stripped before sending), so put that instruction in the agent's system prompt;
- the agent fails or does not finish within `replyTimeoutMs`. A reply that arrives after handoff is dropped.

Setting the status is the first step, so a failure in the courtesy message, note or label never leaves the bot running.

## Configuration

Install the plugin, then configure `channels.chatwoot` in `openclaw.json`:

```json5
{
  channels: {
    chatwoot: {
      baseUrl: "https://chat.example.com",
      accountId: 1,
      apiToken: "…",            // Chatwoot user or AgentBot access token
      webhookSecret: "…",       // required, see "Security"
      allowedInboxIds: [3],     // optional; empty means every inbox
      respondStatuses: ["pending"],
      replyTimeoutMs: 120000,
      stateDir: "/home/node/.openclaw/chatwoot", // durable dedupe; in-memory when unset
      handoff: {
        keywords: ["talk to a human", "bicara dengan manusia"],
        marker: "[[HANDOFF]]",
        message: "Baik, kami hubungkan Anda dengan tim kami.",
        note: "Bot menyerahkan percakapan ini. Alasan: {reason}.",
        label: "bot-handoff"
      }
    }
  }
}
```

In Chatwoot, create an **Agent Bot** (or an account webhook) with the outgoing URL `https://<gateway>/chatwoot/webhook`, attach the bot to the inbox so new conversations start as `pending`, and give the bot's agents a way to take over (status `open`).

## Requirements

- OpenClaw 2026.11.3 or newer.
- `session.dmScope` must separate customers (`per-channel-peer`, `per-account-channel-peer` or `per-peer`). OpenClaw's default, `main`, puts every direct message in one shared session, so the plugin refuses to start with it (override with `allowSharedSession: true` only if you mean it).
- The gateway must be reachable from Chatwoot at a **public hostname**. Chatwoot 4.x blocks webhook URLs that resolve to private addresses. Do not work around this in production with `SAFE_FETCH_ALLOW_PRIVATE_NETWORK`.

## Security

- `webhookSecret` is required. `allowUnsignedWebhooks: true` exists for local development only and logs a warning at startup; anyone who can reach an unsigned webhook can talk to your agent.
- Customer text is untrusted input to an agent. Keep the agent's tools minimal for this channel, and do not give it tools that act on other customers' data.
- Use a dedicated Chatwoot token for the bot, separate from any human's.
- The raw body is what is signed, so put no body-rewriting proxy between Chatwoot and the gateway.
- Internal OpenClaw failures (for example a missing model credential) are never shown to the customer. They trigger a handoff and the reason goes into a private note.
- `openclaw.json` holds the Chatwoot token and webhook secret in plaintext unless you use OpenClaw's SecretRefs. Prefer SecretRefs outside local development.

## Development

```bash
npm install
npm run check        # typecheck + unit tests
```

### Local stack (Docker)

```bash
cp .env.example .env     # optional: add ANTHROPIC_API_KEY or another provider key
scripts/dev-up.sh        # Chatwoot + Postgres + Redis + OpenClaw gateway with this plugin
scripts/smoke.sh         # a fake customer writes; watch for the reply or the handoff
```

`dev-up.sh` generates secrets into `.env` (gitignored), seeds a throwaway Chatwoot account, and writes the Chatwoot admin login to `.data/chatwoot-admin.txt`. Everything binds to `127.0.0.1`. Without a model key the agent turn fails, which exercises the handoff path.

With no provider key in `.env`, the dev stack points the agent at a local mock model (`docker/mock-llm`). Include `HANDOFFTEST` or `ERRORTEST` in the message to make it ask for a handoff or fail:

```bash
scripts/smoke.sh "Halo, status pesanan saya bagaimana?"
scripts/smoke.sh "HANDOFFTEST tolong bantu klaim garansi"
scripts/smoke.sh "ERRORTEST status pesanan"
scripts/restage.sh       # after editing the plugin: copy it in and restart only the gateway
```

## Verification

Run live against Chatwoot 4.19.1 and OpenClaw 2026.11.3 with a mock model; see [docs/verification.md](docs/verification.md) for exactly what was and was not exercised, and the findings that shaped the code.

## Not yet done

- Debouncing bursts of customer messages into one turn.
- Inbound media is passed to the agent as URL hints, not downloaded.
- Typing indicators and read receipts.
- A single plugin instance serves one Chatwoot account.

## License

MIT
