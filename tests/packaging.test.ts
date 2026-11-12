import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  openclaw: { extensions: string[]; runtimeExtensions: string[]; setupEntry: string; runtimeSetupEntry: string };
};
const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8")) as { id: string; channels: string[] };

const tmp = mkdtempSync(join(tmpdir(), "cw-dist-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** All files under `base`, as paths relative to `base`. */
function listFiles(base: string, dir = base): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(base, p));
    else out.push(relative(base, p));
  }
  return out.sort();
}

// OpenClaw refuses `plugins install` from git or npm unless compiled JavaScript ships with the
// package ("package install requires compiled runtime output"). These tests keep that true.
describe("packaging", () => {
  it("declares compiled runtime entries that exist", () => {
    for (const rel of [...pkg.openclaw.runtimeExtensions, pkg.openclaw.runtimeSetupEntry]) {
      expect(existsSync(join(root, rel)), `${rel} is missing; run npm run build and commit dist/`).toBe(true);
    }
  });

  it("keeps the source entries next to the runtime entries", () => {
    expect(pkg.openclaw.extensions).toEqual(["./index.ts"]);
    expect(pkg.openclaw.setupEntry).toBe("./setup-entry.ts");
  });

  it("uses a manifest id that matches the channel", () => {
    expect(manifest.id).toBe("chatwoot");
    expect(manifest.channels).toEqual(["chatwoot"]);
  });

  it("ships a dist/ that matches the current source", () => {
    execFileSync("npx", ["tsc", "-p", "tsconfig.build.json", "--outDir", tmp], { cwd: root, stdio: "pipe" });
    const fresh = listFiles(tmp);
    const committed = listFiles(join(root, "dist"));
    expect(committed, "dist/ has different files than a fresh build; run npm run build").toEqual(fresh);
    for (const f of fresh) {
      expect(readFileSync(join(root, "dist", f), "utf8"), `dist/${f} is stale; run npm run build and commit dist/`).toBe(
        readFileSync(join(tmp, f), "utf8"),
      );
    }
  }, 120_000);
});
