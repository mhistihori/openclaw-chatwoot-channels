/** Text between these tags is for the human agents, never for the customer. */
export const INTERNAL_OPEN = "[[INTERNAL]]";
export const INTERNAL_CLOSE = "[[/INTERNAL]]";
function find(haystack, needle) {
    return haystack.toLowerCase().indexOf(needle.toLowerCase());
}
/**
 * Separate the customer-facing text from internal blocks. Fail-safe: a block that is never closed
 * stays internal to the end of the turn, so a forgotten closing tag cannot leak the rest of the
 * reply. A stray closing tag outside a block is removed.
 */
export function splitInternal(text, state) {
    let rest = text;
    let customer = "";
    const internal = [];
    while (rest !== "") {
        if (state.open) {
            const end = find(rest, INTERNAL_CLOSE);
            if (end < 0) {
                internal.push(rest);
                rest = "";
            }
            else {
                internal.push(rest.slice(0, end));
                rest = rest.slice(end + INTERNAL_CLOSE.length);
                state.open = false;
            }
        }
        else {
            const start = find(rest, INTERNAL_OPEN);
            if (start < 0) {
                customer += rest;
                rest = "";
            }
            else {
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
