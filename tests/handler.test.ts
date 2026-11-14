import { describe, expect, it, vi } from "vitest";
import { handleWebhook, type RunAgent } from "../src/handler.js";
import { createKeyedQueue } from "../src/queue.js";
import { fakeClient, humanPayload, makeConfig, makeDeps, payload, signed, signedRaw } from "./helpers.js";

const ops = (c: ReturnType<typeof fakeClient>) => c.calls.map((x) => x.op);

async function run(runAgent: RunAgent, body = payload(), opts: { client?: ReturnType<typeof fakeClient>; config?: ReturnType<typeof makeConfig> } = {}) {
  const deps = makeDeps(runAgent, opts.client, opts.config);
  const res = handleWebhook(signed(body), deps);
  await res.work;
  return { res, deps };
}

describe("handleWebhook", () => {
  it("answers the customer through the agent", async () => {
    const runAgent: RunAgent = async (job, deliver) => {
      expect(job.text).toBe("Halo, pesanan saya belum sampai");
      await deliver({ text: "Boleh minta nomor pesanannya?" });
    };
    const { res, deps } = await run(runAgent);
    expect(res.status).toBe(200);
    expect(res.body.action).toBe("accepted");
    expect(deps.client.calls).toEqual([{ op: "sendMessage", args: [42, "Boleh minta nomor pesanannya?"] }]);
  });

  it("drops a flood of messages in one conversation instead of queueing without limit", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const runAgent = vi.fn(async () => hold);
    const deps = makeDeps(runAgent);
    deps.queue = createKeyedQueue({ maxPerKey: 2 });
    const send = (id: number) => handleWebhook(signed(payload({ id })), deps);

    const first = send(1);
    const second = send(2);
    const third = send(3);
    expect([first.body.action, second.body.action]).toEqual(["accepted", "accepted"]);
    expect(third.status).toBe(200);
    expect(third.body).toMatchObject({ action: "dropped", reason: "conversation_busy" });
    expect(third.work).toBeUndefined();
    release();
    await Promise.all([first.work, second.work]);
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it("rejects a bad signature without running the agent", async () => {
    const runAgent = vi.fn();
    const deps = makeDeps(runAgent);
    const req = signed(payload());
    req.headers["x-chatwoot-signature"] = "sha256=" + "0".repeat(64);
    const res = handleWebhook(req, deps);
    expect(res.status).toBe(401);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects everything when no secret is configured and unsigned is not allowed", () => {
    const deps = makeDeps(vi.fn());
    deps.config = { ...deps.config, webhookSecret: undefined };
    expect(handleWebhook({ rawBody: JSON.stringify(payload()), headers: {} }, deps).status).toBe(401);
  });

  it("accepts unsigned webhooks only when explicitly allowed", async () => {
    const runAgent = vi.fn(async () => {});
    const deps = makeDeps(runAgent);
    deps.config = { ...deps.config, webhookSecret: undefined, allowUnsignedWebhooks: true };
    const res = handleWebhook({ rawBody: JSON.stringify(payload()), headers: {} }, deps);
    await res.work;
    expect(res.status).toBe(200);
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("returns 400 for a correctly signed body that is not JSON", () => {
    const deps = makeDeps(vi.fn());
    expect(handleWebhook(signedRaw("{not json"), deps).status).toBe(400);
  });

  it("ignores messages from humans and private notes", async () => {
    const runAgent = vi.fn();
    for (const over of [{ message_type: "outgoing" }, { private: true }, { sender: { id: 1, type: "user" } }]) {
      const { res } = await run(runAgent, payload(over));
      expect(res.body.action).toBe("ignored");
    }
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("does not process the same message twice", async () => {
    const runAgent = vi.fn(async () => {});
    const deps = makeDeps(runAgent);
    const first = handleWebhook(signed(payload()), deps);
    const second = handleWebhook(signed(payload()), deps);
    await Promise.all([first.work, second.work]);
    expect(second.body).toMatchObject({ action: "duplicate" });
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("dedupes by delivery id as well", async () => {
    const deps = makeDeps(vi.fn(async () => {}));
    const a = signed(payload({ id: 1 }));
    const b = signed(payload({ id: 2 }));
    a.headers["x-chatwoot-delivery"] = "d1";
    b.headers["x-chatwoot-delivery"] = "d1";
    handleWebhook(a, deps);
    expect(handleWebhook(b, deps).body).toMatchObject({ action: "duplicate", reason: "delivery" });
  });

  it("serialises turns within one conversation", async () => {
    const order: string[] = [];
    const runAgent: RunAgent = async (job) => {
      order.push(`start ${job.messageId}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end ${job.messageId}`);
    };
    const deps = makeDeps(runAgent);
    const a = handleWebhook(signed(payload({ id: 1 })), deps);
    const b = handleWebhook(signed(payload({ id: 2 })), deps);
    await Promise.all([a.work, b.work]);
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2"]);
  });
});

describe("handoff", () => {
  it("skips the agent when the customer asks for a human", async () => {
    const runAgent = vi.fn();
    const { deps } = await run(runAgent, payload({ content: "Tolong talk to a human ya" }));
    expect(runAgent).not.toHaveBeenCalled();
    expect(ops(deps.client)).toEqual(["setStatus", "sendMessage", "sendMessage", "addLabels"]);
    expect(deps.client.calls[0]).toEqual({ op: "setStatus", args: [42, "open"] });
    // Second sendMessage is the private note for the human agent.
    expect(deps.client.calls[2]?.args[2]).toEqual({ private: true });
  });

  it("hands off when the agent emits the marker, and strips it from the reply", async () => {
    const runAgent: RunAgent = async (_job, deliver) => {
      await deliver({ text: "Ini di luar yang bisa saya bantu. [[HANDOFF]]" });
    };
    const { deps } = await run(runAgent);
    expect(deps.client.calls[0]).toEqual({ op: "sendMessage", args: [42, "Ini di luar yang bisa saya bantu."] });
    expect(ops(deps.client)).toContain("setStatus");
  });

  it("hands off when the agent throws", async () => {
    const runAgent: RunAgent = async () => {
      throw new Error("model overloaded");
    };
    const { deps } = await run(runAgent);
    expect(deps.client.calls[0]).toEqual({ op: "setStatus", args: [42, "open"] });
    const note = deps.client.calls.find((c) => (c.args[2] as { private?: boolean } | undefined)?.private);
    expect(String(note?.args[1])).toContain("model overloaded");
  });

  it("hands off on timeout and drops a late reply", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let lateDelivery: Promise<void> | undefined;
    const runAgent: RunAgent = async (_job, deliver) => {
      await gate;
      lateDelivery = deliver({ text: "terlambat" });
      await lateDelivery;
    };
    const { deps } = await run(runAgent);
    expect(deps.client.calls[0]).toEqual({ op: "setStatus", args: [42, "open"] });
    const before = deps.client.calls.length;
    release();
    await lateDelivery;
    await new Promise((r) => setTimeout(r, 10));
    expect(deps.client.calls.length).toBe(before); // the late reply never reached the customer
  });

  it("still opens the conversation when the courtesy message fails", async () => {
    const client = fakeClient(["sendMessage"]);
    const runAgent: RunAgent = async () => {
      throw new Error("boom");
    };
    const { deps } = await run(runAgent, payload(), { client });
    expect(ops(deps.client)[0]).toBe("setStatus");
    expect(ops(deps.client)).toContain("addLabels");
  });

  it("logs loudly when setStatus itself fails", async () => {
    const client = fakeClient(["setStatus"]);
    const runAgent: RunAgent = async () => {
      throw new Error("boom");
    };
    const { deps } = await run(runAgent, payload(), { client });
    expect(deps.log.error).toHaveBeenCalledWith(expect.stringContaining("HANDOFF FAILED"));
  });

  it("respects custom handoff config", async () => {
    const config = makeConfig({ handoff: { message: "", note: "", label: "", keywords: ["cs"] } });
    const { deps } = await run(vi.fn(), payload({ content: "mau cs dong" }), { config });
    expect(ops(deps.client)).toEqual(["setStatus"]);
  });
});

describe("delivery", () => {
  it("splits long replies into several messages", async () => {
    const long = ("kalimat panjang. ".repeat(400)).trim();
    const runAgent: RunAgent = async (_j, deliver) => deliver({ text: long });
    const { deps } = await run(runAgent);
    const sent = deps.client.calls.filter((c) => c.op === "sendMessage");
    expect(sent.length).toBeGreaterThan(1);
    for (const c of sent) expect(String(c.args[1]).length).toBeLessThanOrEqual(4000);
  });

  it("appends media urls to the text", async () => {
    const runAgent: RunAgent = async (_j, deliver) => deliver({ text: "Ini fotonya", mediaUrls: ["https://x/a.png"] });
    const { deps } = await run(runAgent);
    expect(deps.client.calls[0]?.args[1]).toBe("Ini fotonya\nhttps://x/a.png");
  });

  it("hands the conversation to a human when the agent finishes without sending anything", async () => {
    const { deps } = await run(async () => {});
    expect(ops(deps.client)[0]).toBe("setStatus");
    expect(deps.client.calls.find((c) => c.op === "setStatus")?.args).toEqual([42, "open"]);
    expect(JSON.stringify(deps.client.calls)).toContain("agent produced no reply");
  });

  it("counts a media-only reply as an answer", async () => {
    const { deps } = await run(async (_j, deliver) => deliver({ mediaUrl: "https://example.com/a.png" }));
    expect(deps.client.calls.some((c) => c.op === "setStatus")).toBe(false);
    expect(deps.client.calls).toEqual([{ op: "sendMessage", args: [42, "https://example.com/a.png"] }]);
  });

  it("keeps the human replies for the next turn after an empty turn", async () => {
    const seen: string[] = [];
    let attempt = 0;
    const runAgent: RunAgent = async (job, deliver) => {
      seen.push(job.text);
      if (++attempt === 2) await deliver({ text: "ok" });
    };
    const deps = makeDeps(runAgent);
    handleWebhook(signed(humanPayload()), deps);
    await handleWebhook(signed(payload({ id: 1, content: "Pertama" })), deps).work; // empty, handed off
    await handleWebhook(signed(payload({ id: 2, content: "Kedua" })), deps).work;
    expect(seen[1]).toContain("- Winda:");
  });
});

describe("human replies as context", () => {
  it("records a human reply without running the agent or sending anything", () => {
    const runAgent = vi.fn();
    const deps = makeDeps(runAgent);
    const res = handleWebhook(signed(humanPayload()), deps);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, action: "recorded" });
    expect(runAgent).not.toHaveBeenCalled();
    expect(deps.client.calls).toEqual([]);
    expect(deps.humanContext.peek("1:42").map((e) => e.text)).toEqual([expect.stringContaining("Garansi 1 tahun")]);
  });

  it("records a repeated delivery only once", () => {
    const deps = makeDeps(vi.fn());
    handleWebhook(signed(humanPayload()), deps);
    expect(handleWebhook(signed(humanPayload()), deps).body.action).toBe("duplicate");
    expect(deps.humanContext.peek("1:42")).toHaveLength(1);
  });

  it("shows the bot what the human said with the customer's next message, then forgets it", async () => {
    const seen: string[] = [];
    const runAgent: RunAgent = async (job, deliver) => {
      seen.push(job.text);
      await deliver({ text: "ok" });
    };
    const deps = makeDeps(runAgent);
    handleWebhook(signed(humanPayload({ id: 2001 })), deps);
    handleWebhook(signed(humanPayload({ id: 2002, content: "Satu hal lagi: biaya kirim klaim gratis." })), deps);

    await handleWebhook(signed(payload({ id: 1, content: "Berapa lama klaimnya?" })), deps).work;
    await handleWebhook(signed(payload({ id: 2, content: "Terima kasih" })), deps).work;

    expect(seen[0]).toContain("- Winda: Halo, saya Winda. Garansi 1 tahun");
    expect(seen[0]).toContain("- Winda: Satu hal lagi: biaya kirim klaim gratis.");
    expect(seen[0]!.endsWith("[New message from the customer]\nBerapa lama klaimnya?")).toBe(true);
    expect(seen[1]).toBe("Terima kasih"); // already shown once
  });

  it("keeps the human replies when the bot's turn fails", async () => {
    let attempt = 0;
    const seen: string[] = [];
    const runAgent: RunAgent = async (job) => {
      seen.push(job.text);
      if (++attempt === 1) throw new Error("model overloaded");
    };
    const deps = makeDeps(runAgent);
    handleWebhook(signed(humanPayload()), deps);

    await handleWebhook(signed(payload({ id: 1, content: "Pertanyaan pertama" })), deps).work; // fails, hands off
    await handleWebhook(signed(payload({ id: 2, content: "Pertanyaan kedua" })), deps).work;

    expect(seen[0]).toContain("Winda");
    expect(seen[1]).toContain("Winda"); // still there for the next attempt
  });

  it("does not let a human's words trigger the customer-asks-for-a-human handoff", async () => {
    const runAgent = vi.fn(async (_job: unknown, deliver: (p: { text: string }) => Promise<void>) => deliver({ text: "ok" }));
    const deps = makeDeps(runAgent);
    handleWebhook(signed(humanPayload({ content: "Kalau perlu, talk to a human lain ya." })), deps);
    await handleWebhook(signed(payload({ id: 1, content: "Baik, terima kasih" })), deps).work;
    expect(runAgent).toHaveBeenCalledOnce();
    expect(deps.client.calls.some((c) => c.op === "setStatus")).toBe(false);
  });

  it("never mistakes the bot's own replies for a human agent, even when the webhook beats the API response", async () => {
    const runAgent: RunAgent = async (_j, deliver) => deliver({ text: "Jawaban bot" });
    const client = fakeClient();
    const deps = makeDeps(runAgent, client);
    // Chatwoot queues the webhook as soon as it stores the message, so it can arrive before the
    // API call that created the message has returned its id.
    const realSend = client.sendMessage;
    let echo: ReturnType<typeof handleWebhook> | undefined;
    client.sendMessage = async (conversationId, content, opts) => {
      echo = handleWebhook(signed(humanPayload({ id: 9001, content })), deps);
      return realSend(conversationId, content, opts);
    };

    await handleWebhook(signed(payload({ id: 1 })), deps).work;

    expect(echo?.body).toEqual({ ok: true, action: "ignored", reason: "own_message" });
    expect(deps.humanContext.peek("1:42")).toEqual([]);
  });

  it("also recognises its handoff message as its own", async () => {
    const client = fakeClient();
    const deps = makeDeps(vi.fn(), client);
    const realSend = client.sendMessage;
    const echoes: string[] = [];
    client.sendMessage = async (conversationId, content, opts) => {
      if (!opts?.private) echoes.push(handleWebhook(signed(humanPayload({ id: 9100 + echoes.length, content })), deps).body.reason ?? "");
      return realSend(conversationId, content, opts);
    };
    await handleWebhook(signed(payload({ id: 1, content: "talk to a human" })), deps).work;
    expect(echoes).toEqual(["own_message"]);
    expect(deps.humanContext.peek("1:42")).toEqual([]);
  });

  it("still records a real human who happens to write the same words later", async () => {
    const runAgent: RunAgent = async (_j, deliver) => deliver({ text: "Terima kasih" });
    const deps = makeDeps(runAgent);
    await handleWebhook(signed(payload({ id: 1 })), deps).work;
    handleWebhook(signed(humanPayload({ id: 8001, content: "Terima kasih" })), deps); // consumes the bot's announcement
    handleWebhook(signed(humanPayload({ id: 8002, content: "Terima kasih" })), deps); // a real human this time
    expect(deps.humanContext.peek("1:42").map((e) => e.id)).toEqual([8002]);
  });

  it("does nothing when the feature is off", () => {
    const deps = makeDeps(vi.fn(), fakeClient(), makeConfig({ includeHumanReplies: false }));
    const res = handleWebhook(signed(humanPayload()), deps);
    expect(res.body).toEqual({ ok: true, action: "ignored", reason: "human_replies_disabled" });
    expect(deps.humanContext.peek("1:42")).toEqual([]);
  });
});
