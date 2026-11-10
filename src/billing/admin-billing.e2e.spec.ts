import { billingApp } from "../../test/support/billing-app";
import { DAY, T0 } from "../../test/support/billing-harness";
import { redact } from "../common/admin-audit.interceptor";

// Many HTTP round-trips per test; the 5 s default flakes under parallel load.
jest.setTimeout(30_000);

type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});

async function seedCustomers(app: App) {
  await app.admin.post("/api/admin/billing/promos", {
    code: "WELCOME10",
    percentOff: 10,
    duration: "repeating",
    durationInMonths: 3,
  });
  app.fs.seed("users", "s1", { name: "Sam Starter", email: "sam@example.com" });
  app.fs.seed("users", "p1", { name: "Pat Pro", email: "pat@example.com" });
  app.fs.seed("users", "e1", {
    name: "=cmd|' /C calc'!A0",
    email: "eve@example.com",
  });
  app.fs.seed("users", "f1", { name: "Free Fran", email: "fran@example.com" });
  await app.subscribe(
    "s1",
    "starter",
    "monthly",
    "success",
    undefined,
    "sam@example.com",
  );
  await app.subscribe(
    "p1",
    "pro",
    "annual",
    "success",
    "WELCOME10",
    "pat@example.com",
  );
  await app.subscribe(
    "e1",
    "elite",
    "monthly",
    "success",
    undefined,
    "eve@example.com",
  );
}

describe("admin: subscribers", () => {
  it("lists name, email, plan, interval, status, dates, cancel flag, promo, retention and MRR from payments", async () => {
    a = await billingApp();
    await seedCustomers(a);
    await a.as("e1").post("/api/billing/retention/accept");
    await a.as("s1").post("/api/billing/cancel");
    const body = (await a.admin.get("/api/admin/billing/subscribers")).body;
    const by = Object.fromEntries(
      body.subscribers.map((r: { uid: string }) => [r.uid, r]),
    );
    expect(by.s1).toMatchObject({
      name: "Sam Starter",
      email: "sam@example.com",
      planId: "starter",
      interval: "monthly",
      status: "ACTIVE",
      cancelAtPeriodEnd: true,
      mrrMinor: 3900,
      retentionUsed: false,
    });
    expect(by.p1).toMatchObject({
      planId: "pro",
      interval: "annual",
      promoCode: "WELCOME10",
      mrrMinor: Math.round(56640 / 12), // list rate; the one-off first-invoice discount is revenue, not MRR
    });
    expect(by.e1).toMatchObject({
      planId: "elite",
      retentionUsed: true,
      mrrMinor: 19900,
    });
    expect(by.f1).toMatchObject({
      planId: "free",
      status: "NONE",
      mrrMinor: 0,
    });
    expect(by.s1.startedAt).toBe(new Date(T0).toISOString());
    expect(by.s1.currentPeriodEnd).toBeTruthy();
    expect(body.totalMrrMinor).toBe(3900 + by.p1.mrrMinor + 19900);
  });

  it("after an upgrade, MRR is the new plan's rate, not the prorated charge or the old first invoice", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("up", "pro", "monthly");
    await a.advanceDays(1); // the upgrade happens after the first payment
    const p = (
      await u.post("/api/billing/change/preview", {
        planId: "elite",
        interval: "monthly",
      })
    ).body;
    await u.post("/api/billing/change", {
      planId: "elite",
      interval: "monthly",
      expectedAmountDue: p.amountDueNow,
      prorationDate: p.prorationDate,
    });
    const row = (
      await a.admin.get("/api/admin/billing/subscribers")
    ).body.subscribers.find((r: { uid: string }) => r.uid === "up");
    expect(row).toMatchObject({ planId: "elite", mrrMinor: 19900 });
  });

  it("legacy currentPlan=pro users (no paid subscription) are flagged Legacy Pro", async () => {
    a = await billingApp();
    a.fs.seed("users", "old", {
      name: "Old Pro",
      email: "old@example.com",
      currentPlan: "pro",
      subscriptionStatus: "ACTIVE",
    });
    a.fs.seed("users", "new", { name: "New", email: "new@example.com" });
    const rows = (await a.admin.get("/api/admin/billing/subscribers")).body
      .subscribers;
    expect(rows.find((r: { uid: string }) => r.uid === "old")).toMatchObject({
      legacyPro: true,
      mrrMinor: 0,
    });
    expect(rows.find((r: { uid: string }) => r.uid === "new")).toMatchObject({
      legacyPro: false,
    });
  });

  it("a user document claiming a paid plan without a mirror shows as Free with no MRR", async () => {
    a = await billingApp();
    a.fs.seed("users", "faker", {
      name: "F",
      email: "f@example.com",
      currentPlan: "elite",
      subscriptionStatus: "ACTIVE",
      subscriptionExpiryDate: "2099-01-01",
    });
    const row = (
      await a.admin.get("/api/admin/billing/subscribers")
    ).body.subscribers.find((r: { uid: string }) => r.uid === "faker");
    expect(row).toMatchObject({ planId: "free", mrrMinor: 0 });
  });

  it("searches and filters by plan, status, interval, cancel flag and promo", async () => {
    a = await billingApp();
    await seedCustomers(a);
    await a.as("s1").post("/api/billing/cancel");
    const uids = async (q: string) =>
      (
        await a.admin.get(`/api/admin/billing/subscribers?${q}`)
      ).body.subscribers
        .map((r: { uid: string }) => r.uid)
        .sort();
    expect(await uids("q=pat")).toEqual(["p1"]);
    expect(await uids("plan=elite")).toEqual(["e1"]);
    expect(await uids("interval=annual")).toEqual(["p1"]);
    expect(await uids("status=active")).toEqual(["e1", "p1", "s1"]);
    expect(await uids("cancelAtPeriodEnd=true")).toEqual(["s1"]);
    expect(await uids("promo=welcome10")).toEqual(["p1"]);
  });

  it("exports CSV, neutralising spreadsheet formulas", async () => {
    a = await billingApp();
    await seedCustomers(a);
    const r = await a.admin.get("/api/admin/billing/subscribers?format=csv");
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    const lines = r.text.trim().split("\n");
    expect(lines[0]).toBe(
      "uid,name,email,planId,interval,status,startedAt,currentPeriodEnd,cancelAtPeriodEnd,promoCode,retentionUsed,mrrMinor,staff,legacyPro,test",
    );
    expect(lines.length).toBe(5);
    expect(r.text).toContain("'=cmd|' /C calc'!A0");
  });

  it("per-user detail has invoices, plan history and entitlements", async () => {
    a = await billingApp();
    await seedCustomers(a);
    const d = (await a.admin.get("/api/admin/billing/subscribers/p1")).body;
    expect(d.invoices).toEqual([
      expect.objectContaining({
        planId: "pro",
        paymentStatus: "SUCCESS",
        amount: 56640 - 5664,
      }),
    ]);
    expect(d.history.map((h: { type: string }) => h.type)).toEqual([
      "subscribed",
    ]);
    expect(d.entitlements).toMatchObject({
      moneyFlow: true,
      strategyLab: false,
    });
  });
});

describe("admin: promo lifecycle and audit", () => {
  it("create (every option) → use → redemption list → deactivate → rejected; every write audited", async () => {
    a = await billingApp();
    const created = await a.admin.post("/api/admin/billing/promos", {
      code: "SPRING",
      amountOff: 1000,
      duration: "once",
      appliesToPlans: ["starter", "pro"],
      appliesToIntervals: ["monthly"],
      expiresAt: new Date(T0 + 30 * DAY).toISOString(),
      maxRedemptions: 5,
      firstTimeOnly: true,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      code: "SPRING",
      amountOff: 1000,
      appliesToPlans: ["starter", "pro"],
      appliesToIntervals: ["monthly"],
      maxRedemptions: 5,
      firstTimeOnly: true,
      createdBy: "admin@example.com",
    });
    const { checkout } = await a.subscribe(
      "buyer",
      "starter",
      "monthly",
      "success",
      "SPRING",
    );
    expect(checkout.body.amountDueToday).toBe(2900);
    const red = (
      await a.admin.get(
        `/api/admin/billing/promos/${created.body.id}/redemptions`,
      )
    ).body.redemptions;
    expect(red).toEqual([
      expect.objectContaining({ uid: "buyer", code: "SPRING" }),
    ]);
    expect(
      (
        await a.admin.post(
          `/api/admin/billing/promos/${created.body.id}/deactivate`,
        )
      ).body,
    ).toMatchObject({ active: false });
    expect(
      (
        await a.user("late").post("/api/billing/promo/preview", {
          code: "SPRING",
          planId: "starter",
          interval: "monthly",
        })
      ).body.code,
    ).toBe("promo_invalid");
    const audit = (await a.admin.get("/api/admin/billing/audit")).body.audit;
    expect(
      audit.map(
        (x: { method: string; path: string; outcome: string; actor: string }) =>
          `${x.actor} ${x.method} ${x.path} ${x.outcome}`,
      ),
    ).toEqual(
      expect.arrayContaining([
        "admin@example.com POST /api/admin/billing/promos ok",
        `admin@example.com POST /api/admin/billing/promos/${created.body.id}/deactivate ok`,
      ]),
    );
    expect(audit.every((x: { method: string }) => x.method !== "GET")).toBe(
      true,
    );
  });

  it("a failed admin write is audited as an error", async () => {
    a = await billingApp();
    await a.admin.post("/api/admin/billing/promos", {
      code: "X",
      percentOff: 10,
      duration: "once",
    });
    const audit = (await a.admin.get("/api/admin/billing/audit")).body.audit;
    expect(audit[0]).toMatchObject({
      outcome: "error",
      path: "/api/admin/billing/promos",
    });
  });

  it("audit bodies never contain secret-looking fields", () => {
    expect(
      redact({
        code: "A",
        apiKey: "sk",
        nested: { password: "p", card: "4242" },
      }),
    ).toEqual({
      code: "A",
      apiKey: "[REDACTED]",
      nested: { password: "[REDACTED]", card: "[REDACTED]" },
    });
  });

  it("non-admins get 403 on admin billing routes", async () => {
    a = await billingApp();
    expect(
      (await a.user("u1").get("/api/admin/billing/subscribers")).status,
    ).toBe(403);
  });
});

describe("admin: price change notice", () => {
  it("emails subscribers of that plan/interval, and requires 30 days' notice", async () => {
    a = await billingApp();
    await seedCustomers(a);
    const tooSoon = await a.admin.post(
      "/api/admin/billing/price-change-notice",
      {
        planId: "elite",
        interval: "monthly",
        newAmount: 21900,
        effectiveAt: new Date(T0 + 10 * DAY).toISOString(),
      },
    );
    expect(tooSoon.status).toBe(400);
    const ok = await a.admin.post("/api/admin/billing/price-change-notice", {
      planId: "elite",
      interval: "monthly",
      newAmount: 21900,
      effectiveAt: new Date(T0 + 31 * DAY).toISOString(),
    });
    expect(ok.body).toEqual({ sent: 1 });
    expect(
      a.sender.outbox.filter((m) => m.tag === "price_change").map((m) => m.to),
    ).toEqual(["eve@example.com"]);
  });
});
