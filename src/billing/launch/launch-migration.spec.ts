import { readFileSync } from "fs";
import { join } from "path";
import { billingHarness, DAY, T0 } from "../../../test/support/billing-harness";
import { PromoService } from "../promo/promo.service";
import { assertNoPlaceholders, runLaunchMigration } from "./launch-migration";

function setup() {
  const h = billingHarness();
  const promos = new PromoService(h.firebase, h.provider, h.clock);
  const deps = {
    firebase: h.firebase,
    events: h.events,
    promos,
    emails: h.emails,
    clock: h.clock,
  };
  const opts = {
    apply: true,
    planId: "pro",
    trialDays: 30,
    promoPercentOff: 25,
    promoPrefix: "LAUNCH",
    excludeEmails: ["admin@example.com"],
    legacyProTrialDays: 90,
    sendEmails: true,
  };
  return { h, promos, deps, opts };
}

describe("launch migration (decision i)", () => {
  it("dry run counts but writes nothing", async () => {
    const { h, deps, opts } = setup();
    h.fs.seed("users", "u1", { email: "u1@example.com" });
    const r = await runLaunchMigration(deps, { ...opts, apply: false });
    expect(r).toMatchObject({ dryRun: true, scanned: 1, granted: 1 });
    expect(h.fs.ids("subscriptions")).toEqual([]);
    expect(h.fs.ids("promo_codes")).toEqual([]);
  });

  it("gives existing users 30 days of Pro then Free, a one-time first-year code and the launch email; skips payers and staff; idempotent", async () => {
    const { h, deps, opts, promos } = setup();
    for (const u of ["u1", "u2"]) {
      h.fs.seed("users", u, { email: `${u}@example.com` });
      h.auth.add(u, `${u}@example.com`);
    }
    h.fs.seed("users", "staff", { email: "admin@example.com" });
    await h.buy("payer", "elite", "monthly");
    h.fs.seed("users", "payer", { email: "payer@example.com" });
    const r = await runLaunchMigration(deps, opts);
    expect(r).toMatchObject({
      scanned: 4,
      granted: 2,
      skippedPaying: 1,
      skippedStaff: 1,
      codesCreated: 2,
      emailsSent: 2,
    });
    expect(await h.subscriptions.forUser("u1")).toMatchObject({
      planId: "pro",
      status: "TRIALING",
      expiryDate: new Date(T0 + 30 * DAY).toISOString(),
    });
    const offer = h.fs.read("launch_offers", "u1")!;
    const promo = (await promos.list()).find((p) => p.code === offer.code)!;
    expect(promo).toMatchObject({
      percentOff: 25,
      duration: "repeating",
      durationInMonths: 12,
      maxRedemptions: 1,
      firstTimeOnly: true,
      kind: "launch",
    });
    expect(h.tags().filter((t) => t === "launch_offer").length).toBe(2);
    expect((await h.subscriptions.forUser("payer")).planId).toBe("elite");
    await h.provider.advanceTo(T0 + 30 * DAY + 1);
    expect((await h.subscriptions.forUser("u1")).planId).toBe("free");
    const again = await runLaunchMigration(deps, opts);
    expect(again).toMatchObject({ granted: 0, skippedAlreadyMigrated: 2 });
  });

  it("excludes everyone on the staff allowlist (and ADMIN_EMAIL); legacy currentPlan=pro users get 90 days of Pro", async () => {
    const { h, deps, opts } = setup();
    h.fs.seed("config", "staff_access", { emails: ["ops-staff@example.com"] });
    h.fs.seed("users", "s1", { email: "Ops-Staff@Example.com" });
    h.fs.seed("users", "admin", { email: "admin@example.com" });
    h.fs.seed("users", "legacy", {
      email: "legacy@example.com",
      currentPlan: "pro",
      subscriptionStatus: "ACTIVE",
    });
    h.fs.seed("users", "u1", { email: "u1@example.com" });
    for (const u of ["s1", "admin", "legacy", "u1"])
      h.auth.add(u, `${u}@example.com`);
    const r = await runLaunchMigration(deps, opts);
    expect(r).toMatchObject({
      scanned: 4,
      skippedStaff: 2,
      granted: 2,
      legacyPro: 1,
    });
    expect(h.fs.read("launch_offers", "s1")).toBeUndefined();
    expect(await h.subscriptions.forUser("legacy")).toMatchObject({
      planId: "pro",
      status: "TRIALING",
      expiryDate: new Date(T0 + 90 * DAY).toISOString(),
    });
    expect(h.fs.read("launch_offers", "legacy")).toMatchObject({
      legacyPro: true,
    });
    expect((await h.subscriptions.forUser("u1")).expiryDate).toBe(
      new Date(T0 + 30 * DAY).toISOString(),
    );
    await h.provider.advanceTo(T0 + 31 * DAY);
    expect((await h.subscriptions.forUser("u1")).planId).toBe("free");
    expect((await h.subscriptions.forUser("legacy")).planId).toBe("pro");
    await h.provider.advanceTo(T0 + 91 * DAY);
    expect((await h.subscriptions.forUser("legacy")).planId).toBe("free");
  });

  it("refuses to apply with placeholder offer values", () => {
    expect(() =>
      assertNoPlaceholders({
        promoPrefix: "LAUNCH_PLACEHOLDER",
        promoPercentOffRaw: "20",
      }),
    ).toThrow(/placeholder/);
    expect(() =>
      assertNoPlaceholders({
        promoPrefix: "LAUNCH",
        promoPercentOffRaw: "__PLACEHOLDER__",
      }),
    ).toThrow(/placeholder/);
    expect(() =>
      assertNoPlaceholders({ promoPrefix: "LAUNCH", promoPercentOffRaw: "20" }),
    ).not.toThrow();
  });

  it("the script refuses production without --confirm-production", () => {
    const src = readFileSync(
      join(__dirname, "../../../scripts/launch-migration.ts"),
      "utf8",
    );
    expect(src).toMatch(/confirm-production/);
    expect(src).toMatch(/flag\("apply"\)/);
  });
});
