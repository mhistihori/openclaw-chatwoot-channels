import { chunkText, type ChatwootClient } from "./chatwoot-client.js";
import type { DedupeStore } from "./dedupe.js";
import { formatWithHumanContext, type HumanContextStore } from "./human-context.js";
import type { OwnMessageTracker } from "./own-messages.js";
import { QueueExpiredError, type KeyedQueue } from "./queue.js";
import type { InboundJob, Logger, ReplyPayload, ResolvedChatwootConfig } from "./types.js";
import { classifyWebhook, parseBody, verifySignature } from "./webhook.js";

/** Runs one agent turn for a job and streams replies to `deliver`. Provided by the OpenClaw adapter. */
export type RunAgent = (job: InboundJob, deliver: (payload: ReplyPayload) => Promise<void>) => Promise<void>;

export interface HandlerDeps {
  config: ResolvedChatwootConfig;
  client: ChatwootClient;
  dedupe: DedupeStore;
  queue: KeyedQueue;
  /** What human agents said while the bot was not in charge. */
  humanContext: HumanContextStore;
  /** Messages this plugin sent itself, so they are never mistaken for a human agent's. */
  ownMessages: OwnMessageTracker;
  runAgent: RunAgent;
  log: Logger;
  now?: () => number;
  /**
   * Starts post-acknowledgement work. In the gateway this must be `runDetachedWebhookWork`,
   * otherwise work started after the HTTP response is rejected as outside any admitted request.
   */
  schedule?: (work: () => Promise<void>) => Promise<void>;
}

export interface WebhookRequest {
  rawBody: string;
  headers: Record<string, string | undefined>;
}

export interface WebhookResponse {
  status: number;
  body: { ok: boolean; action: string; reason?: string };
  /** Background processing. The HTTP response should not wait for it. */
  work?: Promise<void>;
}

function respond(status: number, action: string, reason?: string, work?: Promise<void>): WebhookResponse {
  return { status, body: { ok: status < 400, action, ...(reason ? { reason } : {}) }, ...(work ? { work } : {}) };
}

/**
 * Verify, filter and dedupe a Chatwoot webhook synchronously, then hand the real
 * work (agent turn, reply, handoff) back as `work` so the HTTP response is fast.
 */
export function handleWebhook(req: WebhookRequest, deps: HandlerDeps): WebhookResponse {
  const { config, log } = deps;
  const nowMs = (deps.now ?? Date.now)();

  if (config.webhookSecret) {
    const sig = verifySignature({
      secret: config.webhookSecret,
      rawBody: req.rawBody,
      signature: req.headers["x-chatwoot-signature"],
      timestamp: req.headers["x-chatwoot-timestamp"],
      nowMs,
      windowSeconds: config.replayWindowSeconds,
    });
    if (!sig.ok) {
      log.warn(`chatwoot: webhook rejected (${sig.reason})`);
      return respond(401, "rejected", sig.reason);
    }
  } else if (!config.allowUnsignedWebhooks) {
    return respond(401, "rejected", "no_secret_configured");
  }

  const payload = parseBody(req.rawBody);
  if (payload === undefined) return respond(400, "rejected", "invalid_json");

  const verdict = classifyWebhook(payload, config);
  if (verdict.kind === "ignore") return respond(200, "ignored", verdict.reason);

  const delivery = req.headers["x-chatwoot-delivery"];

  if (verdict.kind === "human_reply") {
    const r = verdict.reply;
    if (delivery && !deps.dedupe.claim(`delivery:${delivery}`)) return respond(200, "duplicate", "delivery");
    if (!deps.dedupe.claim(`msg:${r.accountId}:${r.messageId}`)) return respond(200, "duplicate", "message");
    if (deps.ownMessages.matches(r.conversationId, r.messageId, r.text)) return respond(200, "ignored", "own_message");
    deps.humanContext.add(`${r.accountId}:${r.conversationId}`, { id: r.messageId, name: r.senderName, text: r.text });
    return respond(200, "recorded");
  }

  const { job } = verdict;

  // Check the backlog first, before anything is written to disk: a flood from one customer (or a
  // slow model) must not grow memory or storage without limit. A dropped message is logged; the
  // customer can simply write again, and a human can always see the conversation in Chatwoot.
  const queueKey = `${job.accountId}:${job.conversationId}`;
  const admit = deps.queue.tryAdmit(queueKey);
  if (!admit.ok) {
    log.warn(`chatwoot: dropped message ${job.messageId} for conversation ${job.conversationId} (${admit.reason})`);
    return respond(200, "dropped", admit.reason);
  }

  if (delivery && !deps.dedupe.claim(`delivery:${delivery}`)) return respond(200, "duplicate", "delivery");
  if (!deps.dedupe.claim(`msg:${job.accountId}:${job.messageId}`)) return respond(200, "duplicate", "message");

  const schedule = deps.schedule ?? ((fn: () => Promise<void>) => fn());
  const work = schedule(() => deps.queue.run(queueKey, () => processJob(job, deps))).catch((e) =>
    e instanceof QueueExpiredError
      ? log.warn(`chatwoot: dropped message ${job.messageId} for conversation ${job.conversationId} (${e.message})`)
      : log.error(`chatwoot: unhandled error for conversation ${job.conversationId}: ${String(e)}`),
  );

  return respond(200, "accepted", undefined, work);
}

export function wantsHuman(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => k !== "" && lower.includes(k));
}

/** Hand the conversation to a human: tell the customer, leave a note, label it, set status to open. */
export async function handoff(job: InboundJob, reason: string, deps: HandlerDeps): Promise<void> {
  const { client, config, log } = deps;
  const h = config.handoff;
  const id = job.conversationId;

  // Set the status first: it is the step that actually stops the bot, so it must not be skipped
  // when a nicer-to-have step (message, note, label) fails.
  await client.setStatus(id, "open");

  const steps: Array<[string, () => Promise<unknown>]> = [];
  if (h.message !== "") steps.push(["message", () => sendOwn(deps, id, h.message)]);
  if (h.note !== "") steps.push(["note", () => client.sendMessage(id, h.note.replace("{reason}", reason), { private: true })]);
  if (h.label !== "") steps.push(["label", () => client.addLabels(id, [h.label])]);

  for (const [name, step] of steps) {
    try {
      await step();
    } catch (e) {
      log.warn(`chatwoot: handoff ${name} failed for conversation ${id}: ${String(e)}`);
    }
  }
  log.info(`chatwoot: conversation ${id} handed to human (${reason})`);
}

async function processJob(job: InboundJob, deps: HandlerDeps): Promise<void> {
  const { config, client, log } = deps;
  const id = job.conversationId;

  if (wantsHuman(job.text, config.handoff.keywords)) {
    await safeHandoff(job, "customer asked for a human", deps);
    return;
  }

  // What human agents wrote since the bot last answered goes in front of this message, so the
  // bot knows what was promised or decided while it was not in charge. The keyword check above
  // used the customer's own words only.
  const humanKey = `${job.accountId}:${id}`;
  const humanReplies = deps.humanContext.peek(humanKey);
  const agentJob: InboundJob = humanReplies.length > 0 ? { ...job, text: formatWithHumanContext(humanReplies, job.text) } : job;

  let handedOff = false;
  const marker = config.handoff.marker;

  const deliver = async (payload: ReplyPayload): Promise<void> => {
    if (handedOff) return; // A late reply must not talk over the human who took over.
    let text = payload.text ?? "";
    const wantsHandoff = text.includes(marker);
    if (wantsHandoff) text = text.split(marker).join("").trim();

    const media = [...(payload.mediaUrls ?? []), ...(payload.mediaUrl ? [payload.mediaUrl] : [])];
    const body = [text, ...media].filter((s) => s !== "").join("\n");
    if (body !== "") {
      for (const part of chunkText(body)) await sendOwn(deps, id, part);
    }
    if (wantsHandoff) {
      handedOff = true;
      await safeHandoff(job, "agent requested a human", deps);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      deps.runAgent(agentJob, deliver),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`agent did not finish within ${config.replyTimeoutMs}ms`)), config.replyTimeoutMs);
      }),
    ]);
    // Only now has the bot seen them. After a failed turn they stay for the next attempt.
    deps.humanContext.commit(humanKey, humanReplies);
  } catch (e) {
    log.error(`chatwoot: agent failed for conversation ${id}: ${String(e)}`);
    if (!handedOff) {
      handedOff = true;
      await safeHandoff(job, `bot error: ${e instanceof Error ? e.message : String(e)}`, deps);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Send a customer-visible message and remember it as the plugin's own, announcing it before it goes out. */
async function sendOwn(deps: HandlerDeps, conversationId: number, text: string): Promise<void> {
  deps.ownMessages.expect(conversationId, text);
  deps.ownMessages.add((await deps.client.sendMessage(conversationId, text)).id);
}

async function safeHandoff(job: InboundJob, reason: string, deps: HandlerDeps): Promise<void> {
  try {
    await handoff(job, reason, deps);
  } catch (e) {
    // Last line of defence: the customer is left waiting, so make it loud.
    deps.log.error(`chatwoot: HANDOFF FAILED for conversation ${job.conversationId} (${reason}): ${String(e)}`);
  }
}
