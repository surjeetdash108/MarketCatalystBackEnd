import * as fs from "fs";
import * as path from "path";

/**
 * apphosting.yaml is read by Firebase when a backend rolls out, not by anything
 * that runs in CI, so a mistake in it only shows up as a failed or wrong
 * rollout. These checks cover the mistakes this file has actually had:
 *   - `cpuMiB` is not a runConfig field (the field is `cpu`)
 *   - `PORT` is reserved by App Hosting and is rejected
 *   - FIRESTORE_DATABASE_ID missing: the app silently uses the (default) database,
 *     the stale pre-migration copy
 *   - ADMIN_GUARD_TRUST_IAM unset on a public service: /admin/* open to anyone
 * Text checks, not a YAML parse, so the spec needs no extra dependency.
 */
const text = fs.readFileSync(
  path.join(__dirname, "..", "apphosting.yaml"),
  "utf-8",
);
// Comment lines never count.
const code = text
  .split(/\r?\n/)
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");

const variables = [...code.matchAll(/^\s*-\s*variable:\s*(\S+)/gm)].map(
  (m) => m[1],
);
const valueOf = (name: string) =>
  code.match(
    new RegExp(`variable:\\s*${name}\\s*\\n\\s*value:\\s*"([^"]*)"`),
  )?.[1];
const runConfigKeys = (() => {
  const block = code.match(/^runConfig:\s*\n((?:[ \t]+\S.*\n?)+)/m)?.[1] ?? "";
  return [...block.matchAll(/^[ \t]+(\w+):/gm)].map((m) => m[1]);
})();

describe("apphosting.yaml", () => {
  it("only uses runConfig fields App Hosting knows", () => {
    const allowed = [
      "cpu",
      "memoryMiB",
      "concurrency",
      "minInstances",
      "maxInstances",
      "cpuAlwaysAllocated",
      "vpcAccess",
    ];
    expect(runConfigKeys.length).toBeGreaterThan(0);
    expect(runConfigKeys.filter((k) => !allowed.includes(k))).toEqual([]);
  });

  it("sets no environment variable App Hosting reserves", () => {
    const reserved = (v: string) =>
      v === "PORT" ||
      v.startsWith("K_") ||
      /^(X_FIREBASE_|X_GOOGLE_|CLOUD_RUN_)/.test(v);
    expect(variables.filter(reserved)).toEqual([]);
  });

  it("declares no variable twice", () => {
    expect(variables.filter((v, i) => variables.indexOf(v) !== i)).toEqual([]);
  });

  it("is the public live role, on the migrated Firestore database", () => {
    expect(valueOf("APP_ROLE")).toBe("live");
    expect(valueOf("FIRESTORE_DATABASE_ID")).toBe("mc-regional");
    expect(valueOf("FIREBASE_PROJECT_ID")).toBe("market-catalyst-502415");
  });

  it("does not trust Cloud Run IAM for the admin guard (the service is public)", () => {
    expect(valueOf("ADMIN_GUARD_TRUST_IAM")).toBe("false");
  });

  it("keeps NODE_ENV out of the build, so devDependencies install for `nest build`", () => {
    expect(code).toMatch(
      /variable:\s*NODE_ENV\s*\n\s*value:\s*"production"\s*\n\s*availability:\s*\["RUNTIME"\]/,
    );
  });

  it("starts the same command as package.json and the Dockerfile", () => {
    const run = code.match(/runCommand:\s*(.+)/)?.[1].trim();
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
    ) as { scripts: Record<string, string> };
    expect(run).toBe(pkg.scripts.start);
  });

  it("references every secret by its own name, never as a plain value", () => {
    const secrets = [
      ...code.matchAll(/variable:\s*(\S+)\s*\n\s*secret:\s*(\S+)/g),
    ];
    expect(secrets.length).toBeGreaterThan(0);
    for (const [, variable, secret] of secrets) expect(secret).toBe(variable);
    for (const v of variables.filter((n) => /(_KEY|_SECRET)$/.test(n))) {
      expect(valueOf(v)).toBeUndefined();
    }
  });
});
