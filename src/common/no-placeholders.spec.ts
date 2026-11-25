import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

/** The release gate (scripts/no-placeholders.mjs) that runs as npm "prebuild". */
const SCRIPT = join(__dirname, "../../scripts/no-placeholders.mjs");
const run = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "nph-"));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  return spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
};

describe("release gate: no placeholders in shipped code", () => {
  it("fails on a placeholder or example.com address in src", () => {
    expect(run({ "src/email.ts": 'send("[LAUNCH EMAIL SUBJECT PLACEHOLDER]")' }).status).toBe(1);
    expect(run({ "src/a.ts": 'const to = "ops@example.com";' }).status).toBe(1);
  });
  it("ignores specs and input hints", () => {
    expect(run({ "src/a.spec.ts": "PLACEHOLDER", "src/b.ts": 'placeholder="you@example.com"' }).status).toBe(0);
  });
  it("this repo passes, and the build runs the gate first", () => {
    expect(spawnSync(process.execPath, [SCRIPT], { cwd: join(__dirname, "../.."), encoding: "utf8" }).status).toBe(0);
    expect(readFileSync(join(__dirname, "../../package.json"), "utf8")).toMatch(/"prebuild": "node scripts\/no-placeholders\.mjs"/);
  });
});
