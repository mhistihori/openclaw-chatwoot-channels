# Verification

What has actually been run, against what, and what has not.

Environment: Docker Desktop on Apple silicon, Chatwoot 4.19.1 (`chatwoot/chatwoot:latest` on 2026-11-12), OpenClaw 2026.11.3 (`ghcr.io/openclaw/openclaw:2026.11.3`), plugin loaded from a staged copy through `plugins.load.paths`. The model was a local OpenAI-compatible mock (`docker/mock-llm`), not a real provider.

## Verified end to end (live)

A throwaway customer writes through the Chatwoot public API (`scripts/smoke.sh`) into an API inbox that has an AgentBot attached.

| Scenario | Result |
| --- | --- |
| Normal question | Webhook delivered and verified, agent answered, reply appears in the conversation, status stays `pending`. |
| Agent includes `[[HANDOFF]]` | Marker stripped from the reply, customer gets the handoff message, private note says why, status becomes `open`. |
| Model returns HTTP 500 | Customer sees only the polite handoff message. The technical reason goes into the private note. Status `open`. |
| Customer asks for a human (`talk to a human`) | Agent is skipped entirely, handoff as above. |
| No model credentials at all | Same as a model failure: handoff, no internal error text shown to the customer. |
| Webhook probes | Bad signature, missing signature and a correctly signed but one-hour-old request all get 401. `GET` gets 405. |

**Multi-agent routing** (agents `main` and `support`, binding `{ agentId: "support", match: { channel: "chatwoot", accountId: "*" } }`): conversations created before the binding stayed on `main` (`agent:main:chatwoot:direct:1-4` ... `1-16`), conversations created after it were answered by `support` (`agent:support:chatwoot:direct:1-17`, `1-18`, `1-19`), confirmed with `openclaw sessions --agent <id>`. `openclaw agents list --bindings` shows the rule. Not tried: a binding on a specific `peer`, and a multi-agent config with no Chatwoot binding.

Also confirmed from the live system:

- Chatwoot signs AgentBot webhooks with `X-Chatwoot-Signature` / `X-Chatwoot-Timestamp` and sends `X-Chatwoot-Delivery`, matching what the plugin verifies.
- `conversation.id` in the webhook is the number used in the REST path (`/conversations/<id>/messages`), so no id translation is needed.
- Each conversation gets its own session: `agent:main:chatwoot:direct:<account>-<conversation>`.
- The channel account starts (`starting account`) and the gateway health monitor no longer restarts it in a loop.

## Findings that shaped the code

1. **Chatwoot refuses private webhook targets.** Version 4.19.1 rejects a webhook URL that resolves to a private address (`Hostname ... has no public ip addresses`). It then marks the conversation `open` with an activity message, so customers are not left hanging, but the bot never sees the message. The dev stack sets `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true`. **Do not set that in production**; put the gateway behind a public hostname instead.
2. **Post-acknowledgement work must be detached.** Starting the agent turn after the HTTP response is rejected by the gateway (`GatewayDrainingError`). The plugin uses the SDK's `runDetachedWebhookWork`.
3. **The default session scope shares one session between all customers.** OpenClaw's `session.dmScope` defaults to `main`, which would mix customers' context. The plugin refuses to start unless a per-peer scope is configured (override: `allowSharedSession`).
4. **Host notices arrive as ordinary replies.** The SDK strips the `isError` flag before calling `deliver`, and OpenClaw renders its own failures as `⚠️ ...`. Without a guard those reached the customer (observed once, then fixed). The plugin treats a reply that starts with `⚠️` as a failure and hands off.

## Install from a package

`openclaw plugins install git:...` failed on the first attempt with `package install requires compiled runtime output for TypeScript entry ./index.ts`. OpenClaw only runs TypeScript source for local paths and source checkouts; an installed package needs compiled JavaScript. The repo now builds to `dist/` (`npm run build`), declares it through `openclaw.runtimeExtensions` and `openclaw.runtimeSetupEntry`, and commits `dist/`.

Checked in a clean OpenClaw 2026.11.3 container, installing from a clone-like folder (source plus `dist/`): the compiled-output check passes, then the install asks for capability consent, so `--accept-capabilities` is required. With it, `plugins inspect chatwoot` reports `Source: ~/.openclaw/extensions/chatwoot/dist/index.js`, status enabled, capability `channel: chatwoot`. The dev stack now loads only `dist/` + manifest + `package.json` (no TypeScript), and the smoke test passes against that. Not run: the `git:` fetch itself (the repo had not been pushed).

## Unconfigured install and error replies

**Install before configuring.** With no `channels.chatwoot` the gateway reported `channel startup failed: chatwoot: channels.chatwoot is missing` (and `Plugin operation failed during activate` on an install). The plugin listed an account `default` regardless, so the gateway tried to start it. It now lists an account only when the channel is configured; unconfigured, it stays idle and logs a hint. Checked in the dev gateway: no startup error without config; after restoring the config, `openclaw plugins reload chatwoot` registered the route and started the account without restarting the gateway, and the smoke test passed.

**Error text reaching customers.** The host reports its own failures as ordinary replies. `dispatchInboundDirectDm` strips the `isError` flag before calling `deliver`, so a prefix check on `⚠️` was the only guard, and it missed an error without that prefix (`prepared model runtime publication was superseded ... run "openclaw doctor --fix"`) that reached a customer once. The plugin now also registers a `reply_payload_sending` hook, restricted to `channel === "chatwoot"`, which sees the raw payload. Observed for a model HTTP 500: the hook received `{ text, isError: true }` for the first error and an unflagged `⚠️ OpenClaw couldn't produce or deliver a reply` follow-up. Both are cancelled, the first one is recorded per session, and the handler hands off with it as the reason. The customer sees only the handoff message. Cancelling an error makes the host emit that generic follow-up, which is why the `⚠️` prefix check stays.

Not reproduced: the original `superseded` error appeared after repeated config changes and plugin reloads in quick succession and could not be triggered again (config hot-reload, and reloads right after a restart, both stayed healthy), so it is not confirmed that this exact text carries `isError`. What is verified is the mechanism for a controlled error and the prefix fallback. If a non-prefixed, unflagged error text ever reaches a customer, the next step is to move from `dispatchInboundDirectDm` to the lower-level `ChannelInboundTurnPlan` API and decide from the run outcome instead of the text.

## Returning a conversation to the bot, and human replies as context

Verified live (Chatwoot 4.19.1, Agent Bot attached to the inbox):

- Handoff (status `open`), human replies, then **Resolve**: when the customer writes again Chatwoot reopens it as `pending` and the bot answers. Reading the Chatwoot source: with an active bot a reopened conversation becomes `pending`, without one it becomes `open`.
- Same, using **Mark as pending** instead of Resolve: the next customer message is answered by the bot.
- With `respondStatuses: ["pending","open"]` the bot answers a customer's follow-up after a handoff (and would talk over a human who took over). With the default it stays silent.
- Human replies as context: after a handoff, two messages from a human agent, and a switch back to `pending`, the model received exactly those two replies in front of the customer's next message, and none of them on the message after that. A plain exchange with no human involved produced no human context at all.

A bug found by that last test and fixed: when the configured token belongs to a human user, Chatwoot reports the bot's own replies as messages from a human agent, and the first version (filtering by message id) recorded them as "human context". The webhook for a message reaches the gateway before the API response with its id does, so the id was never known in time. The plugin now announces each text before sending it and matches the webhook against that (unit test: a webhook that arrives inside the send call). With a bot token this is not needed, because the sender type already differs.

Not verified: a real bot token end to end (the dev stack uses an admin token), human replies carrying attachments (only text is recorded), and a gateway restart with replies pending (covered by unit tests of the store only).

## Covered only by unit tests

127 tests (`npm test`) cover signature verification, replay window, filtering, dedupe (including persistence across a simulated restart), per-conversation ordering, handoff ordering and failure handling, reply timeout with a late reply, chunking, API retry/backoff, and config validation. These run against fakes.

## Not verified

- A real model provider. Only the mock has been used.
- Channel types other than the API inbox (WhatsApp, web widget, email), including attachments and long replies on a live system.
- Retry against a failing Chatwoot API and dedupe persistence across a gateway restart, live. Unit tests only.
- Behaviour under load or with several simultaneous conversations.
- A deployment behind a reverse proxy with a public hostname and TLS.
- Whether Chatwoot's webhook timeout is hit by a slow agent. The plugin acknowledges immediately and works in the background, so it should not be, but this was not stress tested.
- `plugins install` from a package. The dev stack loads the plugin with `plugins.load.paths`, and the gateway reports that it cannot verify where such a plugin came from.

## Known limitations

- The `⚠️` heuristic can send a legitimate reply that starts with that emoji to a human. That errs on the safe side. A more precise fix is to move from `dispatchInboundDirectDm` to the lower-level `ChannelInboundTurnPlan` API, which hands over the raw payload with its flags.
- Secrets in `openclaw.json` are plaintext; the gateway warns about this. Use OpenClaw's SecretRefs outside local development.
- Bursts of customer messages are processed one turn at a time, not merged into one.
