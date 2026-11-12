import { describe, expect, it, vi } from "vitest";
import { handleWebhook, type RunAgent } from "../src/handler.js";
import { fakeClient, makeConfig, makeDeps, payload, signed, signedRaw } from "./helpers.js";

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

  it("sends nothing when the agent stays silent", async () => {
    const { deps } = await run(async () => {});
    expect(deps.client.calls).toEqual([]);
  });
});
