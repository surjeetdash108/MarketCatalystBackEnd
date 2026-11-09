import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
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

  describe("--service-config: settings already on the Cloud Run services count as set", () => {
    const LIVE = "market-catalyst-live";
    const WORKER = "market-catalyst-backend";
    const cfg = (services: object) => {
      const f = join(mkdtempSync(join(tmpdir(), "svc-")), "services.json");
      writeFileSync(f, JSON.stringify(services));
      return f;
    };

    it("a Secret Manager reference on the service satisfies STREAM_TICKET_SECRET without any local value", () => {
      const r = run(["--production", `--service-config=${cfg({ [LIVE]: { STREAM_TICKET_SECRET: { secret: "STREAM_TICKET_SECRET" } }, [WORKER]: {} })}`]);
      expect(r.out).toContain("✓ STREAM_TICKET_SECRET on market-catalyst-live: Secret Manager (STREAM_TICKET_SECRET)");
      expect(r.out).not.toMatch(/env STREAM_TICKET_SECRET/);
      expect(r.out).toContain("env STRIPE_SECRET_KEY is not set on market-catalyst-live, market-catalyst-backend");
    });

    it("a setting needed by two services must be on both", () => {
      const r = run(["--production", `--service-config=${cfg({ [LIVE]: { STRIPE_SECRET_KEY: { secret: "STRIPE_SECRET_KEY" } }, [WORKER]: {} })}`]);
      expect(r.out).toContain("env STRIPE_SECRET_KEY is not set on market-catalyst-backend (expected a Secret Manager reference)");
    });

    it("a placeholder plain value on the service does not count; a real one satisfies the code default", () => {
      const placeholder = run(["--production", `--service-config=${cfg({ [LIVE]: { EMAIL_REPLY_TO: { value: "support@example.com" } }, [WORKER]: { EMAIL_REPLY_TO: { value: "support@example.com" } } })}`]);
      expect(placeholder.out).toContain("env EMAIL_REPLY_TO is not set on market-catalyst-live, market-catalyst-backend");
      expect(placeholder.out).toMatch(/email\.service\.ts:\d+ default is a placeholder and EMAIL_REPLY_TO/);
      const real = run(["--production", `--service-config=${cfg({ [LIVE]: { EMAIL_REPLY_TO: { value: "help@mc-real.ai" } }, [WORKER]: { EMAIL_REPLY_TO: { value: "help@mc-real.ai" } } })}`]);
      expect(real.out).not.toMatch(/EMAIL_REPLY_TO is not set/);
      expect(real.out).not.toMatch(/default is a placeholder and EMAIL_REPLY_TO/);
    });

    it("everything on the services + real launch env + no copy placeholders would pass (only copy remains)", () => {
      const both = (v: object) => ({ [LIVE]: v, [WORKER]: v });
      const svc = both({
        STRIPE_SECRET_KEY: { secret: "STRIPE_SECRET_KEY" }, STRIPE_WEBHOOK_SECRET: { secret: "STRIPE_WEBHOOK_SECRET" },
        STRIPE_PORTAL_CONFIGURATION: { value: "bpc_real" }, STRIPE_RETENTION_COUPON_ID: { value: "coupon_real" },
        EMAIL_PROVIDER_API_KEY: { secret: "EMAIL_PROVIDER_API_KEY" }, EMAIL_FROM_ADDRESS: { value: "noreply@mc-real.ai" },
        EMAIL_REPLY_TO: { value: "help@mc-real.ai" }, EMAIL_FROM_NAME: { value: "MarketCatalyst" },
        STREAM_TICKET_SECRET: { secret: "STREAM_TICKET_SECRET" },
      });
      const r = run(["--production", `--service-config=${cfg(svc)}`], { LAUNCH_PROMO_PREFIX: "LAUNCH26", LAUNCH_PROMO_PERCENT: "20", ADMIN_EMAIL: "ops@mc-real.ai" });
      expect(r.out).not.toMatch(/env [A-Z_]+ is not set/);
      expect(r.out).not.toMatch(/default is a placeholder/);
      expect(r.code).toBe(1);
      expect(r.out).toContain("placeholder in shipped code/copy");
    });
  });
});
