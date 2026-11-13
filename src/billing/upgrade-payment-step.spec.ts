import { BillingService } from "./billing.service";
import { CONSENT_VERSION } from "./checkout/consent";

/**
 * A plan change is confirmed in a pop-up and paid with the card on file; a new
 * card and billing address are optional. The renewal consent is required.
 */
function serviceWith(providerName: "stripe" | "fake", kind: "upgrade" | "downgrade" | "scheduled") {
  const changePlan = jest.fn().mockResolvedValue({ status: "applied", invoiceId: "in_1", amountCharged: 1333, effectiveAt: "x" });
  const svc = Object.create(BillingService.prototype) as BillingService & Record<string, unknown>;
  const consents: unknown[] = [];
  Object.assign(svc, {
    clock: { now: () => 0, nowIso: () => "1970-01-01T00:00:00.000Z" },
    firebase: { firestore: { collection: () => ({ doc: () => ({ set: (d: unknown) => (consents.push(d), Promise.resolve()) }) }) } },
    assertChangeable: jest.fn().mockResolvedValue({
      provider: { name: providerName, changePlan, livemode: false },
      m: { subscriptionId: "sub_1", scheduledChange: null, planId: "starter", interval: "monthly" },
      target: { planId: "pro", interval: "monthly", amount: 5900, currency: "USD", lookupKey: "pro_monthly" },
      kind,
    }),
  });
  return { svc, changePlan, consents };
}

const BILLING = { name: "Pat Doe", address: { line1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701", country: "US" } };
const CONSENT = { accepted: true, version: CONSENT_VERSION };

describe("plan change (Stripe): card on file unless a new one is entered; consent required", () => {
  it.each(["upgrade", "scheduled"] as const)("a Stripe %s without a new card uses the card on file", async (kind) => {
    const { svc, changePlan } = serviceWith("stripe", kind);
    await svc.changePlan("u1", { planId: "pro", interval: "monthly", expectedAmountDue: 1333, prorationDate: 0, consent: CONSENT });
    expect(changePlan).toHaveBeenCalledWith(expect.objectContaining({ kind, paymentMethodId: null, billing: null }));
  });
  it("refuses a change without the full billing address, or without the renewal consent", async () => {
    const a = serviceWith("stripe", "upgrade");
    await expect(a.svc.changePlan("u1", { planId: "pro", interval: "monthly", expectedAmountDue: 1, prorationDate: 0, paymentMethodId: "pm_1", billing: { name: "Pat", address: { line1: "", city: "Austin", country: "US" } }, consent: CONSENT })).rejects.toMatchObject({ response: { code: "address_invalid" } });
    const b = serviceWith("stripe", "upgrade");
    await expect(b.svc.changePlan("u1", { planId: "pro", interval: "monthly", expectedAmountDue: 1, prorationDate: 0, paymentMethodId: "pm_1", billing: BILLING })).rejects.toMatchObject({ response: { code: "consent_required" } });
    expect(a.changePlan).not.toHaveBeenCalled();
    expect(b.changePlan).not.toHaveBeenCalled();
  });
  it("passes the entered card and billing address to the provider for every change, and records the consent", async () => {
    for (const kind of ["upgrade", "scheduled"] as const) {
      const c = serviceWith("stripe", kind);
      await c.svc.changePlan("u1", { planId: "pro", interval: "monthly", expectedAmountDue: 1333, prorationDate: 0, paymentMethodId: "pm_1", billing: BILLING, consent: CONSENT });
      expect(c.changePlan).toHaveBeenCalledWith(expect.objectContaining({ kind, paymentMethodId: "pm_1", billing: expect.objectContaining({ name: "Pat Doe", address: expect.objectContaining({ line1: "1 Main St", country: "US" }) }) }));
      expect(c.consents).toHaveLength(1);
      expect(c.consents[0]).toMatchObject({ uid: "u1", kind, version: CONSENT_VERSION, to: { planId: "pro", interval: "monthly" } });
    }
  });
  it("the fake provider (tests/staging) needs no card", async () => {
    const { svc, changePlan } = serviceWith("fake", "upgrade");
    await svc.changePlan("u1", { planId: "pro", interval: "monthly", expectedAmountDue: 1333, prorationDate: 0 });
    expect(changePlan).toHaveBeenCalled();
  });
});
