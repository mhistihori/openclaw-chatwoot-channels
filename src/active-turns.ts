import { DEFAULT_QUEUE_LIMITS } from "./queue.js";

/** Most agent turns that may be running at once, counting turns that timed out but have not stopped. */
export const DEFAULT_MAX_ACTIVE_TURNS = DEFAULT_QUEUE_LIMITS.maxConcurrent * 2;

/**
 * Counts agent turns that are really running. The host gives the plugin no way to cancel a turn,
 * so a turn that hit the reply timeout keeps running in the background after the conversation has
 * been handed to a human. The queue frees its slot at that point, so without this count a stream
 * of hung turns could pile up without limit. A turn is counted from the moment it starts until
 * its promise settles, whatever the handler did in the meantime, and a new turn is refused while
 * the limit is reached or the same conversation still has a turn running.
 */
export function createActiveTurns(maxActive: number = DEFAULT_MAX_ACTIVE_TURNS) {
  const active = new Set<string>();

  return {
    /** Start counting a turn for `key`, or say why it must not start. Call `end` once the turn's promise has settled. */
    tryBegin(key: string): { ok: true; end: () => void } | { ok: false; reason: "too_many_turns" | "turn_still_running" } {
      if (active.has(key)) return { ok: false, reason: "turn_still_running" };
      if (active.size >= maxActive) return { ok: false, reason: "too_many_turns" };
      active.add(key);
      let ended = false;
      return {
        ok: true,
        end: () => {
          if (ended) return;
          ended = true;
          active.delete(key);
        },
      };
    },
    count: () => active.size,
  };
}

export type ActiveTurns = ReturnType<typeof createActiveTurns>;
