import { chunkText } from "./chatwoot-client.js";
import { classifyWebhook, parseBody, verifySignature } from "./webhook.js";
function respond(status, action, reason, work) {
    return { status, body: { ok: status < 400, action, ...(reason ? { reason } : {}) }, ...(work ? { work } : {}) };
}
/**
 * Verify, filter and dedupe a Chatwoot webhook synchronously, then hand the real
 * work (agent turn, reply, handoff) back as `work` so the HTTP response is fast.
 */
export function handleWebhook(req, deps) {
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
    }
    else if (!config.allowUnsignedWebhooks) {
        return respond(401, "rejected", "no_secret_configured");
    }
    const payload = parseBody(req.rawBody);
    if (payload === undefined)
        return respond(400, "rejected", "invalid_json");
    const verdict = classifyWebhook(payload, config);
    if (verdict.kind === "ignore")
        return respond(200, "ignored", verdict.reason);
    const { job } = verdict;
    const delivery = req.headers["x-chatwoot-delivery"];
    if (delivery && !deps.dedupe.claim(`delivery:${delivery}`))
        return respond(200, "duplicate", "delivery");
    if (!deps.dedupe.claim(`msg:${job.accountId}:${job.messageId}`))
        return respond(200, "duplicate", "message");
    const schedule = deps.schedule ?? ((fn) => fn());
    const work = schedule(() => deps.queue.run(`${job.accountId}:${job.conversationId}`, () => processJob(job, deps))).catch((e) => log.error(`chatwoot: unhandled error for conversation ${job.conversationId}: ${String(e)}`));
    return respond(200, "accepted", undefined, work);
}
export function wantsHuman(text, keywords) {
    const lower = text.toLowerCase();
    return keywords.some((k) => k !== "" && lower.includes(k));
}
/** Hand the conversation to a human: tell the customer, leave a note, label it, set status to open. */
export async function handoff(job, reason, deps) {
    const { client, config, log } = deps;
    const h = config.handoff;
    const id = job.conversationId;
    // Set the status first: it is the step that actually stops the bot, so it must not be skipped
    // when a nicer-to-have step (message, note, label) fails.
    await client.setStatus(id, "open");
    const steps = [];
    if (h.message !== "")
        steps.push(["message", () => client.sendMessage(id, h.message)]);
    if (h.note !== "")
        steps.push(["note", () => client.sendMessage(id, h.note.replace("{reason}", reason), { private: true })]);
    if (h.label !== "")
        steps.push(["label", () => client.addLabels(id, [h.label])]);
    for (const [name, step] of steps) {
        try {
            await step();
        }
        catch (e) {
            log.warn(`chatwoot: handoff ${name} failed for conversation ${id}: ${String(e)}`);
        }
    }
    log.info(`chatwoot: conversation ${id} handed to human (${reason})`);
}
async function processJob(job, deps) {
    const { config, client, log } = deps;
    const id = job.conversationId;
    if (wantsHuman(job.text, config.handoff.keywords)) {
        await safeHandoff(job, "customer asked for a human", deps);
        return;
    }
    let handedOff = false;
    const marker = config.handoff.marker;
    const deliver = async (payload) => {
        if (handedOff)
            return; // A late reply must not talk over the human who took over.
        let text = payload.text ?? "";
        const wantsHandoff = text.includes(marker);
        if (wantsHandoff)
            text = text.split(marker).join("").trim();
        const media = [...(payload.mediaUrls ?? []), ...(payload.mediaUrl ? [payload.mediaUrl] : [])];
        const body = [text, ...media].filter((s) => s !== "").join("\n");
        if (body !== "") {
            for (const part of chunkText(body))
                await client.sendMessage(id, part);
        }
        if (wantsHandoff) {
            handedOff = true;
            await safeHandoff(job, "agent requested a human", deps);
        }
    };
    let timer;
    try {
        await Promise.race([
            deps.runAgent(job, deliver),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`agent did not finish within ${config.replyTimeoutMs}ms`)), config.replyTimeoutMs);
            }),
        ]);
    }
    catch (e) {
        log.error(`chatwoot: agent failed for conversation ${id}: ${String(e)}`);
        if (!handedOff) {
            handedOff = true;
            await safeHandoff(job, `bot error: ${e instanceof Error ? e.message : String(e)}`, deps);
        }
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
async function safeHandoff(job, reason, deps) {
    try {
        await handoff(job, reason, deps);
    }
    catch (e) {
        // Last line of defence: the customer is left waiting, so make it loud.
        deps.log.error(`chatwoot: HANDOFF FAILED for conversation ${job.conversationId} (${reason}): ${String(e)}`);
    }
}
