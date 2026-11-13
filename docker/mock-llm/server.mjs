// A tiny OpenAI-compatible /v1/chat/completions server for local testing.
// It lets the dev stack exercise the full reply path without a real model or API key.
//
// Behaviour is keyed on the last user message:
//   contains "HANDOFFTEST"  -> a reply that ends with the handoff marker
//   contains "ERRORTEST"    -> HTTP 500 (the plugin must hand off, not show an error)
//   anything else           -> a short canned answer that echoes the question
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8080);

function textOf(m) {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("\n");
  return "";
}

// OpenClaw appends its own runtime-context block as a trailing user message, so the customer's
// words are the last user message that is not that block.
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const text = textOf(m);
    if (text.includes("OpenClaw runtime context")) continue;
    return text;
  }
  return "";
}

function answerFor(text) {
  if (text.includes("HANDOFFTEST")) return "Maaf, ini di luar yang bisa saya bantu. [[HANDOFF]]";
  // Report the human-agent context the plugin put in front of the customer's message, so tests can
  // see exactly what reached the model.
  if (text.includes("[Human agent replies")) {
    const lines = text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
    return `Mock agent: konteks agen manusia diterima (${lines.length}): ${lines.join(" | ").slice(0, 300)}`;
  }
  const q = text.replace(/\s+/g, " ").trim().slice(-120);
  return `Mock agent: terima kasih, pertanyaan Anda sudah kami terima ("${q}").`;
}

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/v1/models")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/health" ? { ok: true } : { object: "list", data: [{ id: "mock-1", object: "model" }] }));
    return;
  }
  if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      /* fall through with an empty body */
    }
    const messages = body.messages ?? [];
    const text = lastUserText(messages);
    // Trigger tokens are matched anywhere in the user turns: the host adds its own trailing
    // messages, and every smoke test starts a fresh conversation, so there is no stale history.
    const allUserText = messages.filter((m) => m?.role === "user").map(textOf).join("\n");
    console.log(`[mock-llm] stream=${Boolean(body.stream)} user="${text.slice(-80).replace(/\n/g, " ")}"`);

    if (allUserText.includes("ERRORTEST")) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "mock upstream failure", type: "server_error" } }));
      return;
    }

    const answer = allUserText.includes("HANDOFFTEST") ? answerFor("HANDOFFTEST") : answerFor(text);
    const id = `chatcmpl-mock-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: 10, completion_tokens: Math.ceil(answer.length / 4), total_tokens: 10 + Math.ceil(answer.length / 4) };

    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const send = (delta, finish) =>
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "mock-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      send({ role: "assistant", content: "" }, null);
      send({ content: answer }, null);
      send({}, "stop");
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "mock-1", choices: [], usage })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model: "mock-1",
        choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
        usage,
      }),
    );
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`[mock-llm] listening on ${PORT}`));
