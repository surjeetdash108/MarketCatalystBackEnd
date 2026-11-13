import { FakeFirestore } from "../../../test/support/fake-firestore";
import { RetentionService } from "./retention.service";

function service(status: string) {
  const fs = new FakeFirestore();
  fs.seed("subscriptions", "u1", { subscriptionId: "sub_1", status, source: "stripe", planId: "pro", interval: "monthly", amount: 5900, currency: "USD" });
  fs.seed("customers", "u1", { email: "member@example.com" });
  const firebase = { firestore: fs as unknown, auth: { getUser: jest.fn() } };
  const access = { subscriptionsLive: jest.fn(async () => true) };
  return new RetentionService(firebase as never, access as never, null, {} as never, { now: () => new Date() } as never);
}

describe("RetentionService.offerFor", () => {
  it("offers nothing during a paid trial (nothing has been charged yet)", async () => {
    await expect(service("TRIALING").offerFor("u1")).resolves.toEqual({ eligible: false, reason: "in_trial" });
  });

  it("offers a discount to an active paying member", async () => {
    await expect(service("ACTIVE").offerFor("u1")).resolves.toMatchObject({ eligible: true });
  });
});
