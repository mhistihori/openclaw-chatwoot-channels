/** Text between these tags is for the human agents, never for the customer. */
export const INTERNAL_OPEN = "[[INTERNAL]]";
export const INTERNAL_CLOSE = "[[/INTERNAL]]";

/** Whether a reply is currently inside an internal block. A block may span several reply payloads. */
export interface InternalState {
  open: boolean;
}

export interface SplitReply {
  /** What the customer may see. */
  customer: string;
  /** Internal text, one entry per block (or part of a block). */
  internal: string[];
}

function find(haystack: string, needle: string): number {
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

/**
 * Separate the customer-facing text from internal blocks. Fail-safe: a block that is never closed
 * stays internal to the end of the turn, so a forgotten closing tag cannot leak the rest of the
 * reply. A stray closing tag outside a block is removed.
 */
export function splitInternal(text: string, state: InternalState): SplitReply {
  let rest = text;
  let customer = "";
  const internal: string[] = [];

  while (rest !== "") {
    if (state.open) {
      const end = find(rest, INTERNAL_CLOSE);
      if (end < 0) {
        internal.push(rest);
        rest = "";
      } else {
        internal.push(rest.slice(0, end));
        rest = rest.slice(end + INTERNAL_CLOSE.length);
        state.open = false;
      }
    } else {
      const start = find(rest, INTERNAL_OPEN);
      if (start < 0) {
        customer += rest;
        rest = "";
      } else {
        customer += rest.slice(0, start);
        rest = rest.slice(start + INTERNAL_OPEN.length);
        state.open = true;
      }
    }
  }

  const stray = new RegExp(INTERNAL_CLOSE.replace(/[[\]/]/g, "\\$&"), "gi");
  return {
    customer: customer.replace(stray, "").replace(/\n{3,}/g, "\n\n").trim(),
    internal: internal.map((s) => s.trim()).filter((s) => s !== ""),
  };
}
