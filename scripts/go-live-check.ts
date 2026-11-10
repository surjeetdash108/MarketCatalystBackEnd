/**
 * Go-live readiness check — changes nothing (except the one test email).
 *
 *   npx ts-node --transpile-only scripts/go-live-check.ts --mode=test|live --email=you@company.com \
 *     [--project=market-catalyst-502415] [--app-url=https://app.marketcatalyst.ai] [--secrets-from-gcloud]
 *
 * --secrets-from-gcloud reads STRIPE_SECRET_KEY and EMAIL_PROVIDER_API_KEY from
 * Secret Manager into memory (never printed); otherwise they come from env.
 * Exit 0 = READY, 1 = something failed.
 */
import { execFileSync, spawnSync } from "child_process";
import { join } from "path";
import Stripe from "stripe";
import {
  formatChecks,
  runGoLiveChecks,
} from "../src/billing/go-live/go-live-check";
import { SendGridEmailSender } from "../src/billing/email/sendgrid-email-sender";
import { STRIPE_API_VERSION } from "../src/billing/provider/stripe/stripe-billing.provider";

const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n: string) => process.argv.includes(`--${n}`);
const project = arg("project") ?? "market-catalyst-502415";

function secret(name: string): string | null {
  if (flag("secrets-from-gcloud")) {
    try {
      return (
        execFileSync(
          "gcloud",
          [
            "secrets",
            "versions",
            "access",
            "latest",
            `--secret=${name}`,
            `--project=${project}`,
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim() || null
      );
    } catch {
      return null;
    }
  }
  const v = process.env[name];
  return v && !v.includes("PLACEHOLDER") ? v : null;
}

function serviceEnv(name: string): string | null {
  try {
    const json = execFileSync(
      "gcloud",
      [
        "run",
        "services",
        "describe",
        "market-catalyst-live",
        "--region=us-central1",
        `--project=${project}`,
        "--format=json",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const e = (
      JSON.parse(json).spec.template.spec.containers[0].env ?? []
    ).find((x: { name: string }) => x.name === name);
    return e?.value ?? null;
  } catch {
    return process.env[name] ?? null;
  }
}

async function main() {
  const mode = arg("mode") === "live" ? "live" : "test";
  const key = secret("STRIPE_SECRET_KEY");
  const emailKey = secret("EMAIL_PROVIDER_API_KEY");
  const checks = await runGoLiveChecks({
    mode,
    appUrl: arg("app-url") ?? "https://app.marketcatalyst.ai",
    placeholders: () => {
      const r = spawnSync(
        process.execPath,
        [
          join(__dirname, "check-placeholders.mjs"),
          "--production",
          "--cloud-run",
          `--project=${project}`,
        ],
        { encoding: "utf8" },
      );
      const out = `${r.stdout}${r.stderr}`;
      return {
        exitCode: r.status ?? 1,
        missingEnv: [...out.matchAll(/✗ env ([A-Z0-9_]+)/g)].map((m) => m[1]),
        problems: Number(/--production: (\d+) problem/.exec(out)?.[1] ?? 0),
      };
    },
    stripe: key ? new Stripe(key, { apiVersion: STRIPE_API_VERSION }) : null,
    stripeKeyPrefix: key ? key.slice(0, 8) : null,
    portalConfiguration:
      arg("portal") ?? serviceEnv("STRIPE_PORTAL_CONFIGURATION"),
    sendTestEmail: emailKey
      ? (to) =>
          new SendGridEmailSender(emailKey).send({
            tag: "verification_code",
            to,
            from: `${serviceEnv("EMAIL_FROM_NAME") ?? "MarketCatalyst"} <${serviceEnv("EMAIL_FROM_ADDRESS") ?? ""}>`,
            replyTo: serviceEnv("EMAIL_REPLY_TO") ?? "",
            subject: "MarketCatalyst go-live check",
            text: "This is a test email from scripts/go-live-check.ts. No action needed.",
          })
      : null,
    testEmailTo: arg("email") ?? null,
  });
  console.log(formatChecks(checks));
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
