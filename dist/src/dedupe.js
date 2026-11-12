import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const FILE_NAME = "chatwoot-dedupe.jsonl";
export function createDedupeStore(opts = {}) {
    const ttl = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    const max = opts.maxEntries ?? 50_000;
    const now = opts.now ?? Date.now;
    const seen = new Map();
    let file;
    if (opts.stateDir) {
        mkdirSync(opts.stateDir, { recursive: true });
        file = join(opts.stateDir, FILE_NAME);
        if (existsSync(file)) {
            const cutoff = now() - ttl;
            for (const line of readFileSync(file, "utf8").split("\n")) {
                if (line === "")
                    continue;
                try {
                    const { k, t } = JSON.parse(line);
                    if (typeof k === "string" && typeof t === "number" && t >= cutoff)
                        seen.set(k, t);
                }
                catch {
                    // A torn last line after a crash is harmless; skip it.
                }
            }
        }
    }
    function prune(at) {
        const cutoff = at - ttl;
        for (const [k, t] of seen) {
            if (t < cutoff)
                seen.delete(k);
            else
                break; // Map keeps insertion order, so the rest are newer.
        }
        while (seen.size > max) {
            const oldest = seen.keys().next().value;
            if (oldest === undefined)
                break;
            seen.delete(oldest);
        }
    }
    return {
        claim(key) {
            const at = now();
            prune(at);
            if (seen.has(key))
                return false;
            seen.set(key, at);
            if (file)
                appendFileSync(file, `${JSON.stringify({ k: key, t: at })}\n`);
            return true;
        },
    };
}
