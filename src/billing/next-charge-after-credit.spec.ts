import { BillingService } from "./billing.service";

/** "Renews on … for $X" is what the card is actually charged: after account credit. */
describe("next charge shown in Manage Plan", () => {
  it("uses the invoice's amount due (after credit), not its total", async () => {
    const svc = Object.create(BillingService.prototype) as BillingService & Record<string, unknown>;
    const up = { total: 37440, amountDue: 34320, currency: "USD", periodStart: "2027-11-12T00:00:00.000Z", discountAmount: 0, creditApplied: 3120 };
    const provider = { getUpcomingInvoice: jest.fn().mockResolvedValue(up), getCreditBalance: jest.fn().mockResolvedValue(3120) };
    Object.assign(svc, {
      access: { subscriptionsLive: jest.fn().mockResolvedValue(true), configuredProvider: provider, providerName: "stripe" },
      subscriptions: { forUser: jest.fn().mockResolvedValue({ planId: "starter", planName: "Starter", status: "ACTIVE", inGrace: false, graceEndsAt: null }) },
      mirror: jest.fn().mockResolvedValue({ subscriptionId: "sub_1", customerId: "cus_1", status: "ACTIVE", cancelAtPeriodEnd: false, interval: "annual", planId: "starter", currentPeriodEnd: "2027-11-12T00:00:00.000Z" }),
    });
    const s = await svc.summary("u1");
    expect(s.nextCharge).toMatchObject({ amount: 34320, creditApplied: 3120 });
    expect(s.creditBalance).toBe(3120);
  });
});
