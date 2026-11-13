import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createBoundedLog, DEFAULT_MAX_READ_BYTES, readTailLines, writeLinesAtomic } from "./state-file.js";
const FILE_NAME = "chatwoot-human-context.jsonl";
/**
 * What human agents said to a customer since the bot last answered. Replies are remembered
 * here, then shown to the bot with the customer's next message. They are dropped only after the
 * bot's turn succeeds, so a failed turn does not lose them.
 */
export function createHumanContextStore(opts = {}) {
    const now = opts.now ?? Date.now;
    const ttl = opts.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
    const maxPer = opts.maxPerConversation ?? 20;
    const maxConversations = opts.maxConversations ?? 2000;
    const maxChars = opts.maxCharsPerReply ?? 1500;
    const state = new Map();
    const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_READ_BYTES;
    let log;
    const alive = (e) => e.t >= now() - ttl;
    function apply(line) {
        if (line.op === "add") {
            const list = state.get(line.k) ?? [];
            if (!list.some((x) => x.id === line.e.id))
                list.push(line.e);
            while (list.length > maxPer)
                list.shift();
            state.set(line.k, list);
        }
        else {
            const left = (state.get(line.k) ?? []).filter((x) => !line.ids.includes(x.id));
            if (left.length > 0)
                state.set(line.k, left);
            else
                state.delete(line.k);
        }
        while (state.size > maxConversations) {
            const oldest = state.keys().next().value;
            if (oldest === undefined)
                break;
            state.delete(oldest);
        }
    }
    function persist(line) {
        log?.append(JSON.stringify(line));
    }
    const snapshot = () => [...state].flatMap(([k, list]) => list.filter(alive).map((e) => JSON.stringify({ op: "add", k, e })));
    if (opts.stateDir) {
        try {
            mkdirSync(opts.stateDir, { recursive: true });
            const file = join(opts.stateDir, FILE_NAME);
            if (existsSync(file)) {
                for (const raw of readTailLines(file, maxBytes)) {
                    try {
                        apply(JSON.parse(raw));
                    }
                    catch {
                        // A torn last line after a crash is harmless; skip it.
                    }
                }
                for (const [k, list] of state) {
                    const live = list.filter(alive);
                    if (live.length > 0)
                        state.set(k, live);
                    else
                        state.delete(k);
                }
            }
            // Rewrite compactly now, and again whenever the log outgrows what the state needs.
            const initial = snapshot();
            writeLinesAtomic(file, initial);
            log = createBoundedLog({
                file,
                maxLines: Math.max(10_000, maxPer * maxConversations),
                maxBytes,
                initialLines: initial.length,
                initialBytes: initial.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0),
                compact: snapshot,
                ...(opts.onError ? { onError: opts.onError } : {}),
            });
        }
        catch (e) {
            opts.onError?.(`could not use human-context log in ${opts.stateDir}: ${String(e)}; continuing from memory only`);
        }
    }
    return {
        add(key, entry) {
            const e = {
                id: entry.id,
                name: entry.name,
                text: entry.text.length > maxChars ? `${entry.text.slice(0, maxChars)}…` : entry.text,
                t: now(),
            };
            const line = { op: "add", k: key, e };
            apply(line);
            persist(line);
        },
        /** Replies waiting to be shown to the bot, oldest first. */
        peek(key) {
            return (state.get(key) ?? []).filter(alive);
        },
        /** Forget replies the bot has now seen. */
        commit(key, entries) {
            if (entries.length === 0)
                return;
            const line = { op: "drop", k: key, ids: entries.map((e) => e.id) };
            apply(line);
            persist(line);
        },
    };
}
/**
 * Put the human replies in front of the customer's new message. The result becomes the message
 * the bot sees, so it also stays in the session history for later turns.
 */
export function formatWithHumanContext(entries, customerText) {
    if (entries.length === 0)
        return customerText;
    const lines = entries.map((e) => `- ${e.name}: ${e.text.replace(/\s*\n\s*/g, " ")}`);
    return [
        "[Human agent replies sent to this customer since your last answer. They were already delivered; do not repeat them, but stay consistent with them.]",
        ...lines,
        "[New message from the customer]",
        customerText,
    ].join("\n");
}
