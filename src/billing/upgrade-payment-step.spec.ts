import { BillingService } from "./billing.service";

/**
 * An upgrade is paid like a first purchase — with the card the customer enters
 * in the payment step — never by silently charging a card on file.
 */
function serviceWith(providerName: "stripe" | "fake", kind: "upgrade" | "downgrade" | "scheduled") {
  const changePlan = jest.fn().mockResolvedValue({ status: "applied", invoiceId: "in_1", amountCharged: 1333, effectiveAt: "x" });
  const svc = Object.create(BillingService.prototype) as BillingService & Record<string, unknown>;
  Object.assign(svc, {
    clock: { now: () => 0 },
    assertChangeable: jest.fn().mockResolvedValue({
      provider: { name: providerName, changePlan },
      m: { subscriptionId: "sub_1", scheduledChange: null },
      target: { planId: "pro", interval: "monthly", amount: 5900, currency: "USD", lookupKey: "pro_monthly" },
      kind,
    }),
  });
  return { svc, changePlan };
}

describe("upgrade payment step (Stripe)", () => {
  it("refuses a Stripe upgrade without the card entered for it", async () => {
    const { svc, changePlan } = serviceWith("stripe", "upgrade");
    await expect(svc.changePlan("u1", { planId: "pro", interval: "monthly", expectedAmountDue: 1333, prorationDate: 0 })).rejects.toMatchObject({
      response: { code: "payment_method_required" },
    });
    expect(changePlan).not.toHaveBeenCalled();
  });
  it("passes the entered card to the provider for an upgrade only", async () => {
    const up = serviceWith("stripe", "upgrade");
    await up.svc.changePlan("u1", { planId: "pro", interval: "monthly", expectedAmountDue: 1333, prorationDate: 0, paymentMethodId: "pm_1" });
    expect(up.changePlan).toHaveBeenCalledWith(expect.objectContaining({ kind: "upgrade", paymentMethodId: "pm_1" }));
    const down = serviceWith("stripe", "downgrade");
    await down.svc.changePlan("u1", { planId: "pro", interval: "monthly", expectedCredit: 100, prorationDate: 0, paymentMethodId: "pm_1" });
    expect(down.changePlan).toHaveBeenCalledWith(expect.objectContaining({ kind: "downgrade", paymentMethodId: null }));
  });
  it("a $0 upgrade (e.g. during the free trial) needs no card", async () => {
    const { svc, changePlan } = serviceWith("stripe", "upgrade");
    await svc.changePlan("u1", { planId: "pro", interval: "monthly", expectedAmountDue: 0, prorationDate: 0 });
    expect(changePlan).toHaveBeenCalled();
  });
  it("the fake provider (tests/staging) needs no card", async () => {
    const { svc, changePlan } = serviceWith("fake", "upgrade");
    await svc.changePlan("u1", { planId: "pro", interval: "monthly", expectedAmountDue: 1333, prorationDate: 0 });
    expect(changePlan).toHaveBeenCalled();
  });
});
