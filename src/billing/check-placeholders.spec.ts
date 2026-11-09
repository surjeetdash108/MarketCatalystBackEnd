import { execFileSync } from "child_process";
import { join } from "path";

const SCRIPT = join(__dirname, "../../scripts/check-placeholders.mjs");

function run(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

describe("scripts/check-placeholders.mjs", () => {
  it("lists the remaining placeholders and exits 0 without --production", () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Placeholders found: \d+/);
    expect(r.out).toContain("MarketCatalyst LLC [PLACEHOLDER]");
    expect(r.out).toContain("STRIPE_SECRET_KEY=__PLACEHOLDER__");
  });

  it("fails with --production while any placeholder would ship", () => {
    const r = run(["--production"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--production: \d+ problem\(s\)/);
    expect(r.out).toContain("env STRIPE_SECRET_KEY is missing or a placeholder");
    expect(r.out).toContain("placeholder in shipped code/copy");
  });

  it("env-backed defaults and required secrets stop failing once real values are set; copy placeholders still fail", () => {
    const real = {
      STRIPE_SECRET_KEY: "sk_test_real", STRIPE_WEBHOOK_SECRET: "whsec_real", STRIPE_PORTAL_CONFIGURATION: "bpc_real",
      STRIPE_RETENTION_COUPON_ID: "coupon_real", EMAIL_PROVIDER_API_KEY: "key_real", EMAIL_FROM_ADDRESS: "noreply@mc-real.ai",
      EMAIL_REPLY_TO: "help@mc-real.ai", EMAIL_FROM_NAME: "MarketCatalyst", STREAM_TICKET_SECRET: "x".repeat(40),
      LAUNCH_PROMO_PREFIX: "LAUNCH26", LAUNCH_PROMO_PERCENT: "20", ADMIN_EMAIL: "ops@mc-real.ai",
    };
    const r = run(["--production"], real);
    expect(r.out).not.toMatch(/env [A-Z_]+ is missing or a placeholder/);
    expect(r.out).not.toMatch(/EMAIL_REPLY_TO is not set to a real value/);
    expect(r.code).toBe(1); // legal copy placeholders remain until replaced
    expect(r.out).toContain("[ADDRESS PLACEHOLDER]");
  });
});
