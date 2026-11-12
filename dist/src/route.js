import { handleWebhook } from "./handler.js";
const MAX_BODY_BYTES = 1_000_000;
async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        if (size > MAX_BODY_BYTES)
            return undefined;
        chunks.push(buf);
    }
    return Buffer.concat(chunks).toString("utf8");
}
function send(res, status, body) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
}
function pickHeaders(req) {
    const out = {};
    for (const [k, v] of Object.entries(req.headers))
        out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    return out;
}
/** HTTP handler for the gateway route. The signature must be checked over the exact raw body. */
export function createWebhookRoute(deps) {
    return async (req, res) => {
        if (req.method !== "POST") {
            res.setHeader("allow", "POST");
            send(res, 405, { ok: false, action: "rejected", reason: "method_not_allowed" });
            return true;
        }
        const rawBody = await readBody(req);
        if (rawBody === undefined) {
            send(res, 413, { ok: false, action: "rejected", reason: "body_too_large" });
            return true;
        }
        const result = handleWebhook({ rawBody, headers: pickHeaders(req) }, deps);
        send(res, result.status, result.body);
        // The reply goes out through the Chatwoot API, not this HTTP response.
        void result.work;
        return true;
    };
}
