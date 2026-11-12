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

## Covered only by unit tests

76 tests (`npm test`) cover signature verification, replay window, filtering, dedupe (including persistence across a simulated restart), per-conversation ordering, handoff ordering and failure handling, reply timeout with a late reply, chunking, API retry/backoff, and config validation. These run against fakes.

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
