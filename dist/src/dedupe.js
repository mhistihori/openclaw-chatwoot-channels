import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createBoundedLog, DEFAULT_MAX_READ_BYTES, readTailLines, writeLinesAtomic } from "./state-file.js";
const FILE_NAME = "chatwoot-dedupe.jsonl";
export function createDedupeStore(opts = {}) {
    const ttl = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    const max = opts.maxEntries ?? 50_000;
    const now = opts.now ?? Date.now;
    const seen = new Map();
    const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_READ_BYTES;
    const encode = ([k, t]) => JSON.stringify({ k, t });
    let log;
    if (opts.stateDir) {
        try {
            mkdirSync(opts.stateDir, { recursive: true });
            const file = join(opts.stateDir, FILE_NAME);
            const cutoff = now() - ttl;
            if (existsSync(file)) {
                for (const line of readTailLines(file, maxBytes)) {
                    try {
                        const { k, t } = JSON.parse(line);
                        if (typeof k === "string" && typeof t === "number" && t >= cutoff)
                            seen.set(k, t);
                    }
                    catch {
                        // A torn last line after a crash is harmless; skip it.
                    }
                }
                prune(now());
                // Start from a compact file, so a log that grew in an earlier run does not stay big.
                writeLinesAtomic(file, [...seen].map(encode));
            }
            log = createBoundedLog({
                file,
                // Room for twice the entries we keep, so compaction happens at most once per `max` claims.
                maxLines: max * 2,
                maxBytes,
                initialLines: seen.size,
                initialBytes: [...seen].reduce((n, e) => n + Buffer.byteLength(encode(e)) + 1, 0),
                compact: () => [...seen].map(encode),
                ...(opts.onError ? { onError: opts.onError } : {}),
            });
        }
        catch (e) {
            opts.onError?.(`could not use dedupe log in ${opts.stateDir}: ${String(e)}; continuing from memory only`);
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
            log?.append(encode([key, at]));
            return true;
        },
    };
}
