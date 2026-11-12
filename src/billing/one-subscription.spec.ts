import { BillingService } from "./billing.service";
import { CONSENT_VERSION } from "./checkout/consent";

/**
 * One subscription per person: checkout asks the provider itself (the mirror
 * lags until the webhook arrives) and closes older unfinished checkouts.
 */
function service(live: string[]) {
  const createCheckout = jest.fn().mockResolvedValue({ id: "sub_new", url: "", status: "open", amountDueToday: 3900, currency: "USD", clientSecret: "x" });
  const closeOtherCheckouts = jest.fn().mockResolvedValue(undefined);
  const provider = { name: "stripe", livemode: false, liveSubscriptionIds: jest.fn().mockResolvedValue(live), createCheckout, closeOtherCheckouts };
  const svc = Object.create(BillingService.prototype) as BillingService & Record<string, unknown>;
  const doc = { set: jest.fn().mockResolvedValue(undefined), get: jest.fn().mockResolvedValue({ exists: false, data: () => undefined }) };
  Object.assign(svc, {
    access: { requireLive: jest.fn().mockResolvedValue(provider) },
    verification: { isVerified: jest.fn().mockResolvedValue(true) },
    config: { get: (_k: string, d?: unknown) => d },
    clock: { now: () => 0, nowIso: () => "1970-01-01T00:00:00.000Z" },
    firebase: { firestore: { collection: () => ({ doc: () => doc }) } },
    mirror: jest.fn().mockResolvedValue(null),
    customerId: jest.fn().mockResolvedValue("cus_1"),
    trialDaysFor: jest.fn().mockResolvedValue(0),
  });
  return { svc, createCheckout, closeOtherCheckouts };
}
const INPUT = {
  planId: "starter",
  interval: "monthly" as const,
  consent: { accepted: true, version: CONSENT_VERSION },
  billing: { name: "Pat Doe", address: { line1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701", country: "US" } },
};

describe("one subscription per person", () => {
  it("refuses a checkout when the provider already has a live subscription for the customer (before our webhook arrives)", async () => {
    const { svc, createCheckout } = service(["sub_live"]);
    await expect(svc.checkout("u1", "u1@example.com", INPUT)).rejects.toMatchObject({ response: { code: "already_subscribed" } });
    expect(createCheckout).not.toHaveBeenCalled();
  });
  it("a new checkout closes the customer's other unfinished checkouts, keeping itself", async () => {
    const { svc, closeOtherCheckouts } = service([]);
    await svc.checkout("u1", "u1@example.com", INPUT);
    expect(closeOtherCheckouts).toHaveBeenCalledWith("cus_1", "sub_new");
  });
});
