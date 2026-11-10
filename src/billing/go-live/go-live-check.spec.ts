import type Stripe from "stripe";
import { PLAN_DEFINITIONS } from "../../plans/plans.registry";
import { STRIPE_WEBHOOK_EVENTS } from "../provider/stripe/stripe-billing.provider";
import {
  formatChecks,
  runGoLiveChecks,
  type GoLiveDeps,
} from "./go-live-check";

const prices = new Map(
  PLAN_DEFINITIONS.flatMap((p) =>
    (["monthly", "annual"] as const).flatMap((i) =>
      p.prices[i]
        ? [
            [
              p.prices[i]!.lookupKey,
              {
                unit_amount: p.prices[i]!.amount,
                currency: "usd",
                recurring: { interval: i === "monthly" ? "month" : "year" },
                tax_behavior: "exclusive",
              },
            ] as const,
          ]
        : [],
    ),
  ),
);
function stripeMock(over: Partial<Record<string, unknown>> = {}) {
  const m = {
    balance: { retrieve: () => Promise.resolve({ livemode: false }) },
    prices: {
      list: (q: { lookup_keys: string[] }) =>
        Promise.resolve({
          data: prices.has(q.lookup_keys[0])
            ? [prices.get(q.lookup_keys[0])]
            : [],
        }),
    },
    webhookEndpoints: {
      list: () =>
        Promise.resolve({
          data: [
            {
              id: "we_1",
              url: "https://app.example.com/api/billing/webhook",
              status: "enabled",
              enabled_events: STRIPE_WEBHOOK_EVENTS,
            },
          ],
        }),
    },
    billingPortal: {
      configurations: {
        retrieve: () =>
          Promise.resolve({
            id: "bpc_1",
            active: true,
            features: {
              subscription_cancel: { enabled: false },
              subscription_update: { enabled: false },
            },
          }),
      },
    },
    tax: {
      settings: { retrieve: () => Promise.resolve({ status: "active" }) },
      registrations: {
        list: () =>
          Promise.resolve({
            data: [{ country: "US", country_options: { us: { state: "TX" } } }],
          }),
      },
    },
    paymentMethodDomains: {
      list: () =>
        Promise.resolve({
          data: [
            {
              enabled: true,
              apple_pay: { status: "active" },
              google_pay: { status: "active" },
            },
          ],
        }),
    },
    ...over,
  };
  return m as unknown as Stripe;
}
const deps = (over: Partial<GoLiveDeps> = {}): GoLiveDeps => ({
  mode: "test",
  appUrl: "https://app.example.com",
  placeholders: () => ({ exitCode: 0, missingEnv: [], problems: 0 }),
  stripe: stripeMock(),
  stripeKeyPrefix: "sk_test_",
  portalConfiguration: "bpc_1",
  sendTestEmail: () => Promise.resolve(),
  testEmailTo: "ops@example.com",
  ...over,
});

describe("go-live readiness check", () => {
  it("all green → READY", async () => {
    const checks = await runGoLiveChecks(deps());
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "Required variables set on the services",
        "Seeded Prices match the catalog",
        "Webhook endpoint registered",
        "Email provider sends (SendGrid test email)",
      ]),
    );
    expect(formatChecks(checks)).toMatch(/READY: all checks passed$/);
  });

  it("missing variables are reported by name only", async () => {
    const out = formatChecks(
      await runGoLiveChecks(
        deps({
          placeholders: () => ({
            exitCode: 1,
            missingEnv: ["STRIPE_SECRET_KEY", "EMAIL_PROVIDER_API_KEY"],
            problems: 30,
          }),
        }),
      ),
    );
    expect(out).toMatch(
      /FAIL {2}Required variables set on the services — missing: STRIPE_SECRET_KEY, EMAIL_PROVIDER_API_KEY/,
    );
    expect(out).toMatch(
      /FAIL {2}check-placeholders --production --cloud-run — 30 problem/,
    );
    expect(out).toMatch(/NOT READY/);
  });

  it("wrong Stripe mode fails", async () => {
    const c = await runGoLiveChecks(
      deps({ mode: "live", stripeKeyPrefix: "sk_test_" }),
    );
    expect(c.find((x) => x.name.startsWith("Stripe reachable"))).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/not a live-mode secret key/),
    });
  });

  it("a Price that doesn't match the catalog fails", async () => {
    const s = stripeMock({
      prices: {
        list: () =>
          Promise.resolve({
            data: [
              {
                unit_amount: 1,
                currency: "usd",
                recurring: { interval: "month" },
                tax_behavior: "exclusive",
              },
            ],
          }),
      },
    });
    expect(
      (await runGoLiveChecks(deps({ stripe: s }))).find(
        (x) => x.name === "Seeded Prices match the catalog",
      )?.ok,
    ).toBe(false);
  });

  it("webhook missing events, a portal that allows cancelling, inactive Stripe Tax and no TX registration fail", async () => {
    const s = stripeMock({
      webhookEndpoints: {
        list: () =>
          Promise.resolve({
            data: [
              {
                id: "we_1",
                url: "https://app.example.com/api/billing/webhook",
                status: "enabled",
                enabled_events: ["invoice.paid"],
              },
            ],
          }),
      },
      billingPortal: {
        configurations: {
          retrieve: () =>
            Promise.resolve({
              id: "bpc_1",
              active: true,
              features: { subscription_cancel: { enabled: true } },
            }),
        },
      },
      tax: {
        settings: { retrieve: () => Promise.resolve({ status: "pending" }) },
        registrations: { list: () => Promise.resolve({ data: [] }) },
      },
    });
    const c = await runGoLiveChecks(deps({ stripe: s }));
    expect(
      c.find((x) => x.name === "Webhook endpoint registered")?.detail,
    ).toMatch(/events not subscribed/);
    expect(c.find((x) => x.name === "Customer Portal configuration")?.ok).toBe(
      false,
    );
    expect(c.find((x) => x.name.startsWith("Stripe Tax"))?.ok).toBe(false);
  });

  it("no Stripe key / no email address / SendGrid error fail clearly", async () => {
    const c = await runGoLiveChecks(deps({ stripe: null, testEmailTo: null }));
    expect(c.find((x) => x.name === "Stripe reachable")?.ok).toBe(false);
    expect(c.find((x) => x.name === "Email provider sends")?.detail).toMatch(
      /--email=/,
    );
    const e = await runGoLiveChecks(
      deps({
        sendTestEmail: () =>
          Promise.reject(new Error("SendGrid 401: bad auth")),
      }),
    );
    expect(e.find((x) => x.name.startsWith("Email provider"))).toMatchObject({
      ok: false,
      detail: "SendGrid 401: bad auth",
    });
  });
});
