import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";
import { chunkText, createChatwootClient } from "../src/chatwoot-client.js";

function res(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status });
}

function client(fetchImpl: typeof fetch) {
  return createChatwootClient({
    baseUrl: "https://chat.example.com/",
    accountId: 3,
    apiToken: "tok",
    fetch: fetchImpl,
    sleep: async () => {},
    baseDelayMs: 1,
  });
}

describe("createChatwootClient", () => {
  it("posts an outgoing message with the token header", async () => {
    const f = vi.fn(async () => res(200, { id: 55 }));
    const out = await client(f as unknown as typeof fetch).sendMessage(42, "hai");
    expect(out).toEqual({ id: 55 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://chat.example.com/api/v1/accounts/3/conversations/42/messages");
    expect((init.headers as Record<string, string>)["api_access_token"]).toBe("tok");
    expect(JSON.parse(init.body as string)).toEqual({ content: "hai", message_type: "outgoing", private: false });
  });

  it("sends private notes", async () => {
    const f = vi.fn(async () => res(200, { id: 1 }));
    await client(f as unknown as typeof fetch).sendMessage(42, "catatan", { private: true });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).private).toBe(true);
  });

  it("toggles status and adds labels", async () => {
    const f = vi.fn(async () => res(200));
    const c = client(f as unknown as typeof fetch);
    await c.setStatus(42, "open");
    await c.addLabels(42, ["bot-handoff"]);
    const calls = f.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toMatch(/\/conversations\/42\/toggle_status$/);
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ status: "open" });
    expect(calls[1]![0]).toMatch(/\/conversations\/42\/labels$/);
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ labels: ["bot-handoff"] });
  });

  it("retries on 5xx and then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(502)).mockResolvedValueOnce(res(200, { id: 9 }));
    expect(await client(f as unknown as typeof fetch).sendMessage(1, "x")).toEqual({ id: 9 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("retries on network errors", async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(res(200, { id: 2 }));
    expect(await client(f as unknown as typeof fetch).sendMessage(1, "x")).toEqual({ id: 2 });
  });

  it("does not retry on 4xx", async () => {
    const f = vi.fn(async () => res(401, { error: "bad token" }));
    await expect(client(f as unknown as typeof fetch).sendMessage(1, "x")).rejects.toThrow(/401/);
    expect(f).toHaveBeenCalledOnce();
  });

  it("gives up after the last attempt", async () => {
    const f = vi.fn(async () => res(503));
    await expect(client(f as unknown as typeof fetch).sendMessage(1, "x")).rejects.toThrow(/503/);
    expect(f).toHaveBeenCalledTimes(3);
  });
});

describe("chunkText", () => {
  it("keeps short text whole", () => {
    expect(chunkText("hai")).toEqual(["hai"]);
  });

  it("prefers paragraph breaks", () => {
    const a = "a".repeat(30);
    const b = "b".repeat(30);
    expect(chunkText(`${a}\n\n${b}`, 40)).toEqual([a, b]);
  });

  it("hard-cuts text without any break points", () => {
    const parts = chunkText("x".repeat(25), 10);
    expect(parts.join("")).toBe("x".repeat(25));
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(10);
  });
});

describe("redirects", () => {
  const servers: Server[] = [];
  afterAll(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  const listen = (handler: Parameters<typeof createServer>[1]) =>
    new Promise<number>((resolve) => {
      const s = createServer(handler);
      servers.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port));
    });

  it.each([301, 302, 307, 308])("does not follow a %i, so the token never reaches the other host", async (status) => {
    const seen: Array<string | string[] | undefined> = [];
    const target = await listen((req, res) => {
      seen.push(req.headers["api_access_token"]);
      res.end("{}");
    });
    const front = await listen((_req, res) => {
      res.writeHead(status, { location: `http://127.0.0.1:${target}/stolen` });
      res.end();
    });
    const c = createChatwootClient({
      baseUrl: `http://127.0.0.1:${front}`,
      accountId: 1,
      apiToken: "secret-token",
      sleep: async () => {},
      baseDelayMs: 1,
      maxAttempts: 2,
    });
    await expect(c.sendMessage(1, "hi")).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});
