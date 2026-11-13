import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createBoundedLog, DEFAULT_MAX_READ_BYTES, readTailLines, writeLinesAtomic } from "./state-file.js";

/** Webhooks are delivered at least once, so every message is claimed before it is processed. */
export interface DedupeStore {
  /** Returns true the first time a key is seen, false for repeats. */
  claim(key: string): boolean;
}

export interface DedupeOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
  /** When set, claims are appended to `<stateDir>/chatwoot-dedupe.jsonl` and reloaded on start. */
  stateDir?: string;
  /** Largest the log may grow before it is rewritten from memory. Also the most read on start. */
  maxFileBytes?: number;
  /** Called (once) when the log cannot be read or written; dedupe then works from memory only. */
  onError?: (message: string) => void;
}

const FILE_NAME = "chatwoot-dedupe.jsonl";

export function createDedupeStore(opts: DedupeOptions = {}): DedupeStore {
  const ttl = opts.ttlMs ?? 24 * 60 * 60 * 1000;
  const max = opts.maxEntries ?? 50_000;
  const now = opts.now ?? Date.now;
  const seen = new Map<string, number>();
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_READ_BYTES;
  const encode = ([k, t]: [string, number]) => JSON.stringify({ k, t });
  let log: ReturnType<typeof createBoundedLog> | undefined;

  if (opts.stateDir) {
    try {
      mkdirSync(opts.stateDir, { recursive: true });
      const file = join(opts.stateDir, FILE_NAME);
      const cutoff = now() - ttl;
      if (existsSync(file)) {
        for (const line of readTailLines(file, maxBytes)) {
          try {
            const { k, t } = JSON.parse(line) as { k: string; t: number };
            if (typeof k === "string" && typeof t === "number" && t >= cutoff) seen.set(k, t);
          } catch {
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
    } catch (e) {
      opts.onError?.(`could not use dedupe log in ${opts.stateDir}: ${String(e)}; continuing from memory only`);
    }
  }

  function prune(at: number) {
    const cutoff = at - ttl;
    for (const [k, t] of seen) {
      if (t < cutoff) seen.delete(k);
      else break; // Map keeps insertion order, so the rest are newer.
    }
    while (seen.size > max) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  }

  return {
    claim(key) {
      const at = now();
      prune(at);
      if (seen.has(key)) return false;
      seen.set(key, at);
      log?.append(encode([key, at]));
      return true;
    },
  };
}
