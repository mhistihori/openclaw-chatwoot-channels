import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatwootConfigError, checkSessionIsolation, inspectChatwootConfig, parseInboxIds, resolveChatwootConfig } from "../src/config.js";
import { createDedupeStore } from "../src/dedupe.js";
import { parseTarget } from "../src/target.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("dedupe", () => {
  it("claims a key once", () => {
    const d = createDedupeStore();
    expect(d.claim("a")).toBe(true);
    expect(d.claim("a")).toBe(false);
    expect(d.claim("b")).toBe(true);
  });

  it("forgets keys after the ttl", () => {
    let t = 0;
    const d = createDedupeStore({ ttlMs: 100, now: () => t });
    expect(d.claim("a")).toBe(true);
    t = 150;
    expect(d.claim("a")).toBe(true);
  });

  it("evicts the oldest key beyond maxEntries", () => {
    const d = createDedupeStore({ maxEntries: 2 });
    d.claim("a");
    d.claim("b");
    d.claim("c");
    expect(d.claim("a")).toBe(true); // evicted, so it can be claimed again
    expect(d.claim("c")).toBe(false);
  });

  it("survives a restart when a state dir is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-dedupe-"));
    dirs.push(dir);
    expect(createDedupeStore({ stateDir: dir }).claim("msg:1:7")).toBe(true);
    expect(createDedupeStore({ stateDir: dir }).claim("msg:1:7")).toBe(false);
  });
});

describe("config", () => {
  const base = { baseUrl: "https://chat.example.com/", accountId: "2", apiToken: "t", webhookSecret: "s" };
  const wrap = (c: Record<string, unknown>) => ({ channels: { chatwoot: c } });

  it("applies defaults and normalises values", () => {
    const c = resolveChatwootConfig(wrap(base));
    expect(c.baseUrl).toBe("https://chat.example.com");
    expect(c.accountId).toBe(2);
    expect(c.respondStatuses).toEqual(["pending"]);
    expect(c.webhookPath).toBe("/chatwoot/webhook");
    expect(c.handoff.marker).toBe("[[HANDOFF]]");
  });

  it("requires a webhook secret unless unsigned is explicitly allowed", () => {
    const { webhookSecret: _omit, ...noSecret } = base;
    expect(() => resolveChatwootConfig(wrap(noSecret))).toThrow(ChatwootConfigError);
    expect(resolveChatwootConfig(wrap({ ...noSecret, allowUnsignedWebhooks: true })).webhookSecret).toBeUndefined();
  });

  it.each([
    ["missing section", {}],
    ["bad url", wrap({ ...base, baseUrl: "not a url" })],
    ["non-http url", wrap({ ...base, baseUrl: "ftp://x" })],
    ["no token", wrap({ ...base, apiToken: " " })],
    ["bad account", wrap({ ...base, accountId: "abc" })],
    ["bad status", wrap({ ...base, respondStatuses: ["nope"] })],
    ["empty marker", wrap({ ...base, handoff: { marker: " " } })],
  ])("rejects %s", (_n, cfg) => {
    expect(() => resolveChatwootConfig(cfg)).toThrow(ChatwootConfigError);
  });

  it("inspects without throwing or leaking the token", () => {
    expect(inspectChatwootConfig({})).toEqual({ configured: false, tokenStatus: "missing" });
    expect(inspectChatwootConfig(wrap(base))).toEqual({ configured: true, tokenStatus: "available" });
  });
});

describe("allowedInboxIds", () => {
  it.each([
    [undefined, []],
    [null, []],
    [[], []],
    [[3, 5], [3, 5]],
    [["3", 5], [3, 5]],
    ["3", [3]],
    ["3,5", [3, 5]],
    [" 3 , 5 ,", [3, 5]],
    ["", []],
    ["   ", []],
  ])("reads %j as %j", (input, expected) => {
    expect(parseInboxIds(input)).toEqual(expected);
  });

  it.each(["3,abc", "0", "-2", "3;5", "1.5", [3, "x"], [0]])("rejects %j", (input) => {
    expect(() => parseInboxIds(input)).toThrow(ChatwootConfigError);
  });

  it("rejects values that are neither a list nor a string", () => {
    expect(() => parseInboxIds(3)).toThrow(ChatwootConfigError);
    expect(() => parseInboxIds({ id: 3 })).toThrow(ChatwootConfigError);
  });

  // OpenClaw leaves a reference to a missing or empty variable in place as literal text.
  // Reading that as "no list" would make the bot answer every inbox.
  it.each(["${CHATWOOT_ALLOWED_INBOX_IDS}", " ${CHATWOOT_ALLOWED_INBOX_IDS} ", "3,${OTHER}", "${A:-}x"])(
    "fails closed on an unresolved environment reference: %s",
    (input) => {
      expect(() => parseInboxIds(input)).toThrow(/environment reference/);
    },
  );

  it("is applied when resolving the whole section", () => {
    const base = { baseUrl: "https://chat.example.com", accountId: 1, apiToken: "t", webhookSecret: "s" };
    expect(resolveChatwootConfig({ channels: { chatwoot: { ...base, allowedInboxIds: "3,5" } } }).allowedInboxIds).toEqual([3, 5]);
    expect(() => resolveChatwootConfig({ channels: { chatwoot: { ...base, allowedInboxIds: "${CHATWOOT_ALLOWED_INBOX_IDS}" } } })).toThrow(
      ChatwootConfigError,
    );
  });
});

describe("session isolation", () => {
  it.each([
    [undefined, false, "main"],
    [{ session: {} }, false, "main"],
    [{ session: { dmScope: "main" } }, false, "main"],
    [{ session: { dmScope: "per-channel-peer" } }, true, "per-channel-peer"],
    [{ session: { dmScope: "per-account-channel-peer" } }, true, "per-account-channel-peer"],
    [{ session: { dmScope: "per-peer" } }, true, "per-peer"],
  ])("%j -> isolated=%s", (cfg, isolated, dmScope) => {
    expect(checkSessionIsolation(cfg)).toEqual({ isolated, dmScope });
  });
});

describe("target", () => {
  it("parses the accepted shapes", () => {
    expect(parseTarget("chatwoot:2-42")).toEqual({ accountId: 2, conversationId: 42 });
    expect(parseTarget("2-42")).toEqual({ accountId: 2, conversationId: 42 });
    expect(parseTarget("42")).toEqual({ accountId: undefined, conversationId: 42 });
    expect(parseTarget("abc")).toBeUndefined();
  });
});
