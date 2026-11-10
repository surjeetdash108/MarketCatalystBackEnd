import type Stripe from "stripe";
import { PLAN_DEFINITIONS } from "../../plans/plans.registry";
import { STRIPE_WEBHOOK_EVENTS } from "../provider/stripe/stripe-billing.provider";

/**
 * Go-live readiness (scripts/go-live-check.ts). Read-only: it changes nothing
 * except sending the one test email you ask for. Values are never printed —
 * only names, ids that are not secrets, and PASS/FAIL.
 */
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface GoLiveDeps {
  mode: "test" | "live";
  appUrl: string;
  /** Names of required settings missing on the services (from check-placeholders --cloud-run). */
  placeholders: () => {
    exitCode: number;
    missingEnv: string[];
    problems: number;
  };
  stripe: Stripe | null;
  stripeKeyPrefix: string | null;
  portalConfiguration: string | null;
  sendTestEmail: ((to: string) => Promise<void>) | null;
  testEmailTo: string | null;
  taxState?: string;
}

const catalogPrices = () =>
  PLAN_DEFINITIONS.flatMap((p) =>
    (["monthly", "annual"] as const).flatMap((i) => {
      const pr = p.prices[i];
      return pr
        ? [
            {
              lookupKey: pr.lookupKey,
              amount: pr.amount,
              currency: p.currency.toLowerCase(),
              interval: i === "monthly" ? "month" : "year",
            },
          ]
        : [];
    }),
  );

async function step(name: string, fn: () => Promise<string>): Promise<Check> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message };
  }
}
const fail = (m: string): never => {
  throw new Error(m);
};

export async function runGoLiveChecks(d: GoLiveDeps): Promise<Check[]> {
  const out: Check[] = [];
  const ph = d.placeholders();
  out.push({
    name: "Required variables set on the services",
    ok: ph.missingEnv.length === 0,
    detail: ph.missingEnv.length
      ? `missing: ${ph.missingEnv.join(", ")}`
      : "all present (names checked, values not read)",
  });
  out.push({
    name: "check-placeholders --production --cloud-run",
    ok: ph.exitCode === 0,
    detail: ph.exitCode === 0 ? "passes" : `${ph.problems} problem(s)`,
  });

  const s = d.stripe;
  if (!s) {
    out.push({
      name: "Stripe reachable",
      ok: false,
      detail:
        "STRIPE_SECRET_KEY not available (set it, or pass --secrets-from-gcloud)",
    });
  } else {
    out.push(
      await step(`Stripe reachable in ${d.mode} mode`, async () => {
        const want = d.mode === "live" ? "sk_live_" : "sk_test_";
        if (!d.stripeKeyPrefix?.startsWith(want))
          fail(`the key is not a ${d.mode}-mode secret key`);
        const bal = await s.balance.retrieve();
        if (bal.livemode !== (d.mode === "live"))
          fail(`Stripe reports livemode=${bal.livemode}`);
        return "ok";
      }),
    );
    out.push(
      await step("Seeded Prices match the catalog", async () => {
        const bad: string[] = [];
        for (const c of catalogPrices()) {
          const p = (
            await s.prices.list({
              lookup_keys: [c.lookupKey],
              active: true,
              limit: 1,
            })
          ).data[0];
          if (!p) bad.push(`${c.lookupKey}: missing`);
          else if (
            p.unit_amount !== c.amount ||
            p.currency !== c.currency ||
            p.recurring?.interval !== c.interval
          )
            bad.push(
              `${c.lookupKey}: ${p.unit_amount} ${p.currency}/${p.recurring?.interval} ≠ catalog ${c.amount} ${c.currency}/${c.interval}`,
            );
          else if (p.tax_behavior !== "exclusive")
            bad.push(
              `${c.lookupKey}: tax_behavior ${p.tax_behavior} (want exclusive)`,
            );
        }
        if (bad.length) fail(bad.join("; "));
        return `${catalogPrices().length} prices ok`;
      }),
    );
    out.push(
      await step("Webhook endpoint registered", async () => {
        const url = `${d.appUrl.replace(/\/$/, "")}/api/billing/webhook`;
        const eps = (await s.webhookEndpoints.list({ limit: 100 })).data.filter(
          (e) => e.url === url,
        );
        const ep = eps.find((e) => e.status === "enabled");
        if (!ep) fail(`no enabled endpoint for ${url}`);
        const missing = ep!.enabled_events.includes("*")
          ? []
          : STRIPE_WEBHOOK_EVENTS.filter(
              (e) => !ep!.enabled_events.includes(e as never),
            );
        if (missing.length)
          fail(`events not subscribed: ${missing.join(", ")}`);
        return `${url} (${ep!.id})`;
      }),
    );
    out.push(
      await step("Customer Portal configuration", async () => {
        if (!d.portalConfiguration) fail("STRIPE_PORTAL_CONFIGURATION not set");
        const c = await s.billingPortal.configurations.retrieve(
          d.portalConfiguration!,
        );
        if (!c.active) fail("configuration is not active");
        if (
          c.features.subscription_cancel?.enabled ||
          c.features.subscription_update?.enabled
        )
          fail(
            "portal allows cancelling/changing plans (must be card + invoices only, so cancellations go through the retention flow)",
          );
        return c.id;
      }),
    );
    out.push(
      await step(
        `Stripe Tax active with a ${d.taxState ?? "TX"} registration`,
        async () => {
          const st = await s.tax.settings.retrieve();
          if (st.status !== "active") fail(`Stripe Tax status: ${st.status}`);
          const regs = (
            await s.tax.registrations.list({ status: "active", limit: 100 })
          ).data;
          const ok = regs.some(
            (r) =>
              r.country === "US" &&
              (r.country_options as { us?: { state?: string } }).us?.state ===
                (d.taxState ?? "TX"),
          );
          if (!ok) fail(`no active US-${d.taxState ?? "TX"} registration`);
          return "active";
        },
      ),
    );
    out.push(
      await step("Payment method domain (Apple Pay / Google Pay)", async () => {
        const host = new URL(d.appUrl).hostname;
        const pmd = (
          await s.paymentMethodDomains.list({ domain_name: host, limit: 1 })
        ).data[0];
        if (!pmd || !pmd.enabled)
          fail(`${host} not registered (run scripts/stripe-seed.ts)`);
        return `${host} apple_pay=${pmd!.apple_pay?.status ?? "?"} google_pay=${pmd!.google_pay?.status ?? "?"}`;
      }),
    );
  }

  if (!d.testEmailTo)
    out.push({
      name: "Email provider sends",
      ok: false,
      detail: "pass --email=<address> to send a test email",
    });
  else if (!d.sendTestEmail)
    out.push({
      name: "Email provider sends",
      ok: false,
      detail: "EMAIL_PROVIDER=sendgrid / EMAIL_PROVIDER_API_KEY not available",
    });
  else
    out.push(
      await step("Email provider sends (SendGrid test email)", async () => {
        await d.sendTestEmail!(d.testEmailTo!);
        return "accepted by SendGrid — check the inbox";
      }),
    );
  return out;
}

export function formatChecks(checks: Check[]): string {
  const lines = checks.map(
    (c) => `${c.ok ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`,
  );
  const failed = checks.filter((c) => !c.ok).length;
  return [
    ...lines,
    "",
    failed
      ? `NOT READY: ${failed} check(s) failed`
      : "READY: all checks passed",
  ].join("\n");
}
