import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    let file;
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
        if (file)
            appendFileSync(file, `${JSON.stringify(line)}\n`);
    }
    if (opts.stateDir) {
        mkdirSync(opts.stateDir, { recursive: true });
        file = join(opts.stateDir, FILE_NAME);
        if (existsSync(file)) {
            for (const raw of readFileSync(file, "utf8").split("\n")) {
                if (raw === "")
                    continue;
                try {
                    apply(JSON.parse(raw));
                }
                catch {
                    // A torn last line after a crash is harmless; skip it.
                }
            }
            // Rewrite compactly so the log does not grow without bound across restarts.
            for (const [k, list] of state) {
                const live = list.filter(alive);
                if (live.length > 0)
                    state.set(k, live);
                else
                    state.delete(k);
            }
            const tmp = `${file}.tmp`;
            const compact = [...state].flatMap(([k, list]) => list.map((e) => JSON.stringify({ op: "add", k, e })));
            writeFileSync(tmp, compact.length > 0 ? `${compact.join("\n")}\n` : "");
            renameSync(tmp, file);
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
