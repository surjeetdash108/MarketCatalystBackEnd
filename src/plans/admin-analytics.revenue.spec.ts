import { ConfigService } from "@nestjs/config";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { AdminAnalyticsService } from "./admin-analytics.service";
import { PlansService } from "./plans.service";
import { SubscriptionsService } from "./subscriptions.service";

/**
 * Revenue, MRR and subscription counts must come from `payments` (money the
 * Stripe webhook recorded), never from plan fields on the user document — a
 * user doc that says `currentPlan: "pro", subscriptionStatus: "ACTIVE"` with no
 * payment behind it is not a subscriber.
 */

type Row = Record<string, unknown>;
const NOW = Date.parse("2026-11-09T12:00:00Z");

function stubFirestore(collections: Record<string, Record<string, Row>>) {
  const snap = (name: string) => {
    const docs = Object.entries(collections[name] ?? {}).map(([id, d]) => ({
      id,
      data: () => d,
    }));
    return { docs, size: docs.length };
  };
  const query = (name: string) => ({
    get: () => Promise.resolve(snap(name)),
    limit: () => query(name),
    orderBy: () => query(name),
  });
  return { collection: (name: string) => query(name) };
}

function service(collections: Record<string, Record<string, Row>>, staffList: string[] = []) {
  const firebase = {
    firestore: stubFirestore(collections),
  } as unknown as FirebaseAdminService;
  const plans = {
    list: () =>
      Promise.resolve([
        { id: "free", name: "Free" },
        { id: "pro", name: "Pro" },
      ]),
  } as unknown as PlansService;
  const config = {
    get: (_k: string, d: string) => d,
  } as unknown as ConfigService;
  return new AdminAnalyticsService(
    firebase,
    plans,
    new SubscriptionsService(firebase, plans),
    config,
    { list: () => Promise.resolve(staffList) } as never,
  );
}

const payment = (p: Row): Row => ({
  userId: "u1",
  planId: "pro",
  amount: 5900,
  currency: "USD",
  paymentStatus: "SUCCESS",
  paymentDate: "2026-11-01",
  billingCycle: "monthly",
  subscriptionExpiryDate: "2026-12-01",
  ...p,
});

describe("AdminAnalyticsService.revenue", () => {
  beforeAll(() => jest.useFakeTimers({ now: NOW }));
  afterAll(() => jest.useRealTimers());

  it("does not count a user doc that claims a paid plan with no payment behind it", async () => {
    const r = await service({
      users: {
        u1: {
          email: "a@example.com",
          currentPlan: "pro",
          subscriptionStatus: "ACTIVE",
          subscriptionExpiryDate: "2099-12-31",
        },
      },
      payments: {},
    }).revenue();
    expect(r.activeSubscriptions).toBe(0);
    expect(r.freeUsers).toBe(1);
    expect(r.mrrMinor).toBe(0);
    expect(r.totalMinor).toBe(0);
  });

  it("counts active subscriptions and MRR from payments covering today, annual divided by 12", async () => {
    const r = await service({
      users: {
        u1: { email: "a@example.com" },
        u2: { email: "b@example.com" },
        u3: { email: "c@example.com" },
        u4: { email: "d@example.com" },
      },
      payments: {
        p1: payment({}),
        p2: payment({
          userId: "u2",
          amount: 56640,
          billingCycle: "annual",
          subscriptionExpiryDate: "2027-11-01",
        }),
        p3: payment({
          userId: "u3",
          paymentDate: "2026-09-01",
          subscriptionExpiryDate: "2026-10-01",
        }),
        p4: payment({ userId: "u4", paymentStatus: "FAILED" }),
      },
    }).revenue();
    expect(r.activeSubscriptions).toBe(2);
    expect(r.expiredSubscriptions).toBe(1);
    expect(r.freeUsers).toBe(1);
    expect(r.mrrMinor).toBe(5900 + 4720);
    expect(r.totalMinor).toBe(5900 + 56640 + 5900);
  });

  it("excludes staff from every count", async () => {
    const r = await service({
      users: {
        s: { email: "admin@marketcatalyst.ai" },
        u1: { email: "a@x.com" },
      },
      payments: { p: payment({ userId: "s" }) },
    }).revenue();
    expect(r.totalUsers).toBe(1);
    expect(r.activeSubscriptions).toBe(0);
  });

  it("staff on the allowlist are excluded from subscriber counts, MRR and revenue", async () => {
    const r = await service(
      {
        users: { u1: { email: "a@example.com" }, s1: { email: "ops-staff@example.com" } },
        payments: { p1: payment({}), p2: payment({ userId: "s1", amount: 19900 }) },
      },
      ["ops-staff@example.com"],
    ).revenue();
    expect(r.activeSubscriptions).toBe(1);
    expect(r.mrrMinor).toBe(5900);
    expect(r.totalMinor).toBe(5900);
  });
});
