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

### Giving the conversation back to the bot

The status is the switch: `pending` means the bot answers, `open` means a human does. When the human is done, either:

- press **Resolve**. When the customer writes again, Chatwoot reopens the conversation as `pending` (because the inbox has an active Agent Bot) and the bot answers; or
- use **Mark as pending** to hand it back right away without resolving.

Both were verified against Chatwoot 4.19.1. This relies on the Agent Bot being attached to the inbox; without it Chatwoot reopens conversations as `open` and the bot stays silent. Do not add `open` to `respondStatuses` to work around that: the bot would then also answer after a handoff and over a human who took over.

### What the bot knows about the human's replies

The plugin ignores messages that humans send when deciding whether to answer, but it remembers them. They are put in front of the customer's next message, so the bot sees what was promised or decided while it was not in charge:

```
[Human agent replies sent to this customer since your last answer. They were already delivered; do not repeat them, but stay consistent with them.]
- Winda: Halo, saya Winda. Garansi 1 tahun, klaim lewat nomor pesanan.
[New message from the customer]
Berapa lama proses klaimnya?
```

- It is part of that message, so it also stays in the session history for later turns. The replies are shown once, and only dropped after the bot's turn succeeded (after a failure they stay for the next attempt).
- Private notes, attachments and the bot's own messages are not included. Up to 20 replies per conversation, 1500 characters each, kept for 7 days. With `stateDir` set they survive a gateway restart; without it they live in memory.
- Turn it off with `includeHumanReplies: false`.
- The plugin recognises its own messages by announcing each text before sending it, because Chatwoot's webhook for a message can reach the gateway before the API response that carries the message id. This matters when the configured token belongs to a human user; with a bot token the sender type already tells them apart.

### Several quick messages, one answer

Customers often send a thought in pieces ("Kalau kirim ke Rembang 59252", then "Berapa ongkirnya"). The plugin waits `messageDebounceMs` (default 3 seconds) after the last message, then gives the agent all of them as one turn, so there is one answer instead of two. A burst is never held longer than 15 seconds, and at most 20 messages or 12,000 characters go into one turn. While the agent is still answering, newer messages wait and are merged into the next turn, instead of each getting its own stale answer. If a turn waits more than 5 minutes behind others and never starts, the conversation is handed to a human (reason "bot was too busy to answer in time") rather than left in silence, and the next message is handled normally. The cost is the wait: every reply starts up to `messageDebounceMs` later. Set it to `0` to answer every message separately (messages that arrive while a turn runs are still merged).

### Handoff to a human

The conversation is set to `open` (which stops the bot), the customer gets a message, a private note explains why, and a `bot-handoff` label is added. It happens when:

- the customer asks for a person (phrases in `handoff.keywords`);
- the agent includes the marker `[[HANDOFF]]` in a reply (the marker is stripped before sending), so put that instruction in the agent's system prompt;
- the agent fails or does not finish within `replyTimeoutMs`. A reply that arrives after handoff is dropped.

Setting the status is the first step, so a failure in the courtesy message, note or label never leaves the bot running.

## Install

OpenClaw only installs a plugin from git or npm when compiled JavaScript ships with it, so this repo commits `dist/`. Run on the gateway host:

```bash
openclaw plugins install git:github.com/mhistihori/openclaw-chatwoot-channels@main --accept-capabilities
```

You will be asked to confirm the source (add `--force` for a non-interactive install). `--accept-capabilities` grants the channel capability the plugin declares.

A freshly installed plugin has no configuration yet. That is a normal state: it stays idle and logs `channels.chatwoot is missing — webhook route not registered`. Add the configuration below, then apply it:

```bash
openclaw plugins reload chatwoot
```

Run that reload after every change to `channels.chatwoot` as well (webhook secret, inbox ids, ...): the webhook route reads its settings when the plugin loads. For local development use `openclaw plugins install --link <path>` instead, which runs the TypeScript source directly.

Installing a compiled copy from a clone-like folder was verified in a clean OpenClaw 2026.11.3 container (`plugins inspect chatwoot` reports `Source: .../dist/index.js`, enabled). The `git:` fetch itself was not run, because the repo had not been pushed when this was written.

### Releasing a change

`dist/` must match the source, or installs get stale code. Before every push:

```bash
npm run release:check   # rebuild dist/, then typecheck and run the unit tests
```

then commit the updated `dist/`. A test (`tests/packaging.test.ts`) rebuilds into a temp folder and fails if the committed `dist/` differs.

## Configuration

Then configure `channels.chatwoot` in `openclaw.json`:

```json5
{
  channels: {
    chatwoot: {
      baseUrl: "https://chat.example.com",
      // allowInsecureHttp: true,  // only for a plain http:// baseUrl on a private network, see below
      accountId: 1,
      apiToken: "…",            // Chatwoot user or AgentBot access token
      webhookSecret: "…",       // required, see "Security"
      allowedInboxIds: [3],     // or "3,5", or "${CHATWOOT_ALLOWED_INBOX_IDS}"; empty means every inbox
      respondStatuses: ["pending"],
      includeHumanReplies: true,   // show the bot what human agents wrote (default)
      replyTimeoutMs: 120000,
      messageDebounceMs: 3000,     // wait this long after the customer's last message; 0 = answer each separately
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

### Plain http on a private network

The API token is sent in a header on every request, so `baseUrl` should be `https://`. Plain `http://` is accepted without any setting only for this machine (`localhost`, `127.x.x.x`, `::1`). For any other host, for example `http://chatwoot:3000` between two containers, the plugin refuses to start until you set `allowInsecureHttp: true`. That says: the network between the gateway and Chatwoot is private and I trust it. The plugin then logs a warning at every start. Do not use it across the internet, and do not use it for a host you reach through a shared or public network. The plugin never follows redirects on API calls (an `http` to `https` redirect from a proxy is an error, so point `baseUrl` at the final address).

## Requirements

- OpenClaw 2026.11.3 or newer.
- `session.dmScope` must separate customers (`per-channel-peer`, `per-account-channel-peer` or `per-peer`). OpenClaw's default, `main`, puts every direct message in one shared session, so the plugin refuses to start with it (override with `allowSharedSession: true` only if you mean it).
- The gateway must be reachable from Chatwoot at a **public hostname**. Chatwoot 4.x blocks webhook URLs that resolve to private addresses. Do not work around this in production with `SAFE_FETCH_ALLOW_PRIVATE_NETWORK`.

## Settings from the environment

Any string in `openclaw.json` can read an environment variable with OpenClaw's own substitution, so secrets and per-environment values do not have to live in the file:

```json5
channels: {
  chatwoot: {
    baseUrl: "${CHATWOOT_BASE_URL}",
    accountId: "${CHATWOOT_ACCOUNT_ID}",
    apiToken: "${CHATWOOT_API_TOKEN}",
    webhookSecret: "${CHATWOOT_WEBHOOK_SECRET}",
    allowedInboxIds: "${CHATWOOT_ALLOWED_INBOX_IDS}"   // e.g. 3 or 3,5
  }
}
```

`allowedInboxIds` takes a list (`[3, 5]`) or a comma-separated string (`"3,5"`), so it can come from a variable. The plugin does not read any environment variable on its own; the config file always shows where each value comes from.

OpenClaw leaves a reference to a **missing or empty** variable in place as literal text. For an allowlist the plugin treats that as an error and refuses to start (`allowedInboxIds still contains an environment reference ...`), instead of reading it as "no list" and answering every inbox. If you want an explicit fallback, write `${CHATWOOT_ALLOWED_INBOX_IDS:-3}`. When the list is genuinely empty the plugin starts, but logs a warning that it answers every inbox in the account.

## Several agents: route Chatwoot to one of them

The plugin hands every conversation to OpenClaw's normal route resolver, so which agent answers is decided by `bindings`, the same as for any other channel. To let only agent `support` handle Chatwoot while your other agents keep their own channels:

```json5
{
  agents: {
    ownership: "explicit",
    entries: {
      main: { workspace: "~/.openclaw/workspace" },
      support: { workspace: "~/.openclaw/workspace-support" }
    }
  },
  bindings: [
    { agentId: "support", match: { channel: "chatwoot", accountId: "*" } }
  ]
}
```

Notes:

- `accountId` is `default` for this plugin. Omitting it also works, but `"*"` makes the intent explicit. An omitted `accountId` matches only the default account.
- Without a binding in a multi-agent setup, OpenClaw cannot choose and reports `AGENT_SELECTION_REQUIRED`, so the customer's message will end in a handoff.
- Check it with `openclaw agents list --bindings`. Sessions then appear as `agent:support:chatwoot:direct:<account>-<conversation>`.
- Bindings only pick the agent; they are not access control. Tools are the thing to restrict: OpenClaw lets agents read each other's sessions by default (`tools.agentToAgent`, `tools.sessions.visibility`). For a customer-facing agent, narrow or disable that, and give it only the tools it needs.
- Changing a binding affects new conversations; an existing conversation keeps the session it already has under the old agent.
- Try it in the dev stack by setting `CHATWOOT_AGENT_ID=support` in `.env` and re-running `scripts/dev-up.sh`.

## Security

- `webhookSecret` is required. `allowUnsignedWebhooks: true` exists for local development only and logs a warning at startup; anyone who can reach an unsigned webhook can talk to your agent.
- Customer text is untrusted input to an agent. Keep the agent's tools minimal for this channel, and do not give it tools that act on other customers' data.
- Use a dedicated Chatwoot token for the bot, separate from any human's.
- The raw body is what is signed, so put no body-rewriting proxy between Chatwoot and the gateway.
- Internal OpenClaw failures (for example a missing model credential or a model outage) are never shown to the customer. A `reply_payload_sending` hook, active only for this channel, cancels error replies before delivery, and the conversation is handed to a human with the reason in a private note. Replies that start with `⚠️` are treated the same way. So are the runtime's plain-sentence fallbacks (for example "The tool run finished, but no final summary was produced", sent when the model stops after its tool calls), and any turn that ends without sending the customer anything: the conversation goes to a human with the reason "agent produced no reply" instead of being left in silence.
- The message queue is bounded, so a flood cannot exhaust the gateway: at most 5 jobs waiting or running per conversation, 200 in total, 8 agent turns at once, and a job that waited more than 5 minutes is dropped unrun. Over a limit, the message is dropped with a warning in the log (the webhook still answers 200, so Chatwoot does not retry) and the conversation stays visible to human agents. Put your own rate limit in front of the webhook as well. A turn that hits `replyTimeoutMs` hands the conversation to a human, but the host gives the plugin no way to cancel that turn, so it may still run to its end in the background.
- The files under `stateDir` are bounded too. The dedupe log keeps at most 50,000 recent message ids for 24 hours and the human-reply log at most 20 replies per conversation for 7 days; both are rewritten while running once they pass twice that size or 8 MB, and only the last 8 MB is read on start. The backlog check runs before anything is written, so a message that is dropped for flooding writes nothing. If the disk is full or read-only, the plugin logs one warning and keeps working from memory (a restart then forgets which messages it has already seen).
- The API client refuses plain `http://` to anything but this machine unless you set `allowInsecureHttp: true`, and never follows redirects, so the token cannot be sent unencrypted by accident or handed to another host. Use a dedicated token with only the access the bot needs.
- `openclaw.json` holds the Chatwoot token and webhook secret in plaintext unless you use OpenClaw's SecretRefs. Prefer SecretRefs outside local development.

## Publishing to ClawHub

Not published yet. The package is prepared for it (`files` whitelist, `openclaw.compat`, `openclaw.build`). A dry run against the current contents passes with 19 files (62 KB), and a tarball of that exact shape installs in a clean OpenClaw 2026.11.3 container (`plugins install npm-pack:...`).

```bash
npm i -g clawhub
clawhub login
npm run release:check                      # rebuild dist/, typecheck, tests
git tag v0.2.0 && git push --tags          # after pushing the commit that contains dist/
clawhub package publish . --dry-run \
  --source-repo mhistihori/openclaw-chatwoot-channels \
  --source-commit "$(git rev-parse HEAD)" --source-ref v0.2.0
```

Run it again without `--dry-run` to publish. New releases stay hidden from normal install surfaces until ClawHub's review and verification finish; add `--wait` to wait for the result. Users then install with `openclaw plugins install clawhub:<package>`.

The icon is `assets/icon.png` (512×512), drawn by `scripts/make-icon.py` (`python3 scripts/make-icon.py`; needs Pillow). It is original artwork, not the Chatwoot or OpenClaw logo. OpenClaw picks it up from that fixed path with no manifest field. The plugin registers no agent tools, so no `assets/activity.svg` is needed.

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

MIT. See [LICENSE](LICENSE).
