import { billingApp, checkoutBody } from "../../test/support/billing-app";

jest.setTimeout(30_000);
type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});
const STAFF = "ops-staff@example.com";

async function withStaffList(app: App, emails: string[]) {
  for (const e of emails)
    expect(
      (await app.admin.post("/api/admin/staff-access", { email: e })).status,
    ).toBe(201);
}

describe("staff allowlist (config/staff_access)", () => {
  it("admin adds/removes entries (lowercased, exact); every change is audited; non-admins get 403", async () => {
    a = await billingApp();
    await withStaffList(a, ["Ops-Staff@Example.com"]);
    expect((await a.admin.get("/api/admin/staff-access")).body).toEqual({
      emails: [STAFF],
    });
    expect(a.fs.read("config", "staff_access")?.emails).toEqual([STAFF]);
    expect(
      (await a.admin.post("/api/admin/staff-access", { email: "not-an-email" }))
        .status,
    ).toBe(400);
    expect(
      (
        await a.admin.delete(
          `/api/admin/staff-access/${encodeURIComponent(STAFF)}`,
        )
      ).body,
    ).toEqual({ emails: [] });
    const audit = (
      await a.admin.get("/api/admin/billing/audit")
    ).body.audit.map(
      (x: { method: string; path: string; outcome: string }) =>
        `${x.method} ${x.path} ${x.outcome}`,
    );
    expect(audit).toEqual(
      expect.arrayContaining([
        "POST /api/admin/staff-access ok",
        "POST /api/admin/staff-access error",
        `DELETE /api/admin/staff-access/${encodeURIComponent(STAFF)} ok`,
      ]),
    );
    expect((await a.user("u1").get("/api/admin/staff-access")).status).toBe(
      403,
    );
  });
});

describe("staff claim sync", () => {
  it("verified listed email → staff claim (other claims kept); removed → claim cleared, refresh requested", async () => {
    a = await billingApp();
    await withStaffList(a, [STAFF]);
    a.user("s1", STAFF, { emailVerified: true, provider: "google.com" });
    a.auth.users.get("s1")!.customClaims = { plan: "pro", admin: false };
    expect((await a.as("s1").post("/api/account/sync-claims")).body).toEqual({
      staff: true,
      refreshToken: true,
    });
    expect(a.auth.users.get("s1")!.customClaims).toEqual({
      plan: "pro",
      admin: false,
      staff: true,
    });
    expect((await a.as("s1").post("/api/account/sync-claims")).body).toEqual({
      staff: true,
      refreshToken: false,
    });
    await a.admin.delete(
      `/api/admin/staff-access/${encodeURIComponent(STAFF)}`,
    );
    expect((await a.as("s1").post("/api/account/sync-claims")).body).toEqual({
      staff: false,
      refreshToken: true,
    });
    expect(a.auth.users.get("s1")!.customClaims).toEqual({
      plan: "pro",
      admin: false,
    });
  });

  it("an UNVERIFIED account using a staff email gets no claim and no plan", async () => {
    a = await billingApp({ env: { SUBSCRIPTIONS_ENABLED: "true" } });
    await withStaffList(a, [STAFF]);
    a.user("x1", STAFF, { emailVerified: false });
    expect((await a.as("x1").post("/api/account/sync-claims")).body).toEqual({
      staff: false,
      refreshToken: false,
    });
    const me = (await a.as("x1").get("/api/me/entitlements")).body;
    expect(me.planId).toBe("none");
    expect(me.staff).toBeUndefined();
    expect(me.entitlements.moneyFlow).toBe(false);
  });
});

describe("staff full access", () => {
  it.each([["true"], ["false"]])(
    "entitlements: plan 'staff' with every built feature (SUBSCRIPTIONS_ENABLED=%s)",
    async (flag) => {
      a = await billingApp({ env: { SUBSCRIPTIONS_ENABLED: flag } });
      await withStaffList(a, [STAFF]);
      a.user("s2", STAFF, { emailVerified: true });
      const me = (await a.as("s2").get("/api/me/entitlements")).body;
      expect(me).toMatchObject({
        staff: true,
        planId: "staff",
        planName: "Staff",
        subscriptionsEnabled: flag === "true",
        limits: { watchlistTickers: null },
      });
      expect(Object.values(me.entitlements).every(Boolean)).toBe(true);
      expect(me.entitlements.strategyLab).toBe(true);
      expect(me.entitlements.adminDashboard).toBeUndefined(); // staff-only admin keys are never granted
    },
  );

  it("staff never see checkout, plan changes or a retention offer, and are never billed", async () => {
    a = await billingApp({ env: { SUBSCRIPTIONS_ENABLED: "true" } });
    await withStaffList(a, [STAFF]);
    const u = a.user("s3", STAFF, { emailVerified: true });
    const co = await u.post(
      "/api/billing/checkout",
      checkoutBody("pro", "monthly"),
    );
    expect(co.status).toBe(409);
    expect(co.body.code).toBe("staff_access");
    expect(
      (
        await u.post("/api/billing/change/preview", {
          planId: "elite",
          interval: "monthly",
        })
      ).body.code,
    ).toBe("staff_access");
    expect((await u.get("/api/billing/retention")).body).toEqual({
      eligible: false,
      reason: "staff",
    });
    expect((await u.post("/api/billing/retention/accept")).body.code).toBe(
      "staff_access",
    );
    expect(a.fs.read("subscriptions", "s3")).toBeUndefined();
    expect(a.fs.read("checkout_sessions", "s3")).toBeUndefined();
  });

  it("admin: staff badge, staff filter, and excluded from subscriber counts and MRR", async () => {
    a = await billingApp();
    a.fs.seed("users", "c1", { name: "Customer", email: "c1@example.com" });
    a.fs.seed("users", "s4", { name: "Staffer", email: STAFF });
    await a.subscribe("c1", "pro", "monthly");
    await a.subscribe("s4", "elite", "monthly", "success", undefined, STAFF); // paid before joining staff
    let body = (await a.admin.get("/api/admin/billing/subscribers")).body;
    expect(body.totalMrrMinor).toBe(5900 + 19900);
    await withStaffList(a, [STAFF]);
    body = (await a.admin.get("/api/admin/billing/subscribers")).body;
    const s4 = body.subscribers.find((r: { uid: string }) => r.uid === "s4");
    expect(s4).toMatchObject({ staff: true, mrrMinor: 0 });
    expect(body.totalMrrMinor).toBe(5900);
    expect(body.subscriberCount).toBe(1);
    expect(body.staffCount).toBe(1);
    const only = async (q: string) =>
      (
        await a.admin.get(`/api/admin/billing/subscribers?${q}`)
      ).body.subscribers.map((r: { uid: string }) => r.uid);
    expect(await only("staff=true")).toEqual(["s4"]);
    expect(await only("staff=false")).toEqual(["c1"]);
  });
});
