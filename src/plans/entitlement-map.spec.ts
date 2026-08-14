import { readFileSync } from "fs";
import { join } from "path";
import { ENTITLEMENTS, PLAN_DEFINITIONS } from "./plans.registry";

/**
 * Guards the entitlement catalog against the failure that reached production:
 * `SLUG_ENTITLEMENT` in the frontend still pointed `stock` and `options` at
 * `advancedCharts` after that key was split into finer ones. The lookup returned
 * undefined, so BOTH screens were denied to every user including Pro — with no
 * error logged anywhere, because "no grant" and "unknown key" were
 * indistinguishable.
 *
 * These tests read the frontend source directly. The two repos deploy
 * separately, so a type import cannot catch the drift; a string check can.
 */

const UI_ROOT = join(__dirname, "../../../MarketCatalystUI/app/iq");

function readUi(file: string): string {
  return readFileSync(join(UI_ROOT, file), "utf8");
}

function catalogKeysInUi(): Set<string> {
  const src = readUi("entitlements.tsx");
  return new Set([...src.matchAll(/\{ key: "([a-zA-Z]+)"/g)].map((m) => m[1]));
}

function slugMappings(): Array<{ slug: string; key: string }> {
  const src = readUi("entitlement-gate.tsx");
  const start = src.indexOf("SLUG_ENTITLEMENT");
  const block = src.slice(start, src.indexOf("};", start));
  return [...block.matchAll(/"?([a-zA-Z-]+)"?: "([a-zA-Z]+)"/g)]
    .map((m) => ({ slug: m[1], key: m[2] }))
    .filter((m) => m.slug !== "SLUG_ENTITLEMENT");
}

describe("entitlement catalog", () => {
  it("has a unique key, label and description for every entry", () => {
    const keys = ENTITLEMENTS.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of ENTITLEMENTS) {
      expect(e.label.length).toBeGreaterThan(0);
      // A one-line, human-readable sentence — the admin toggle list is unusable
      // without it, which is why this is asserted rather than assumed.
      expect(e.description.length).toBeGreaterThan(15);
      expect(e.description.endsWith(".")).toBe(true);
      expect(e.group.length).toBeGreaterThan(0);
    }
  });

  it("never sells a staff capability on any plan", () => {
    const staff = ENTITLEMENTS.filter((e) => e.staffOnly).map((e) => e.key);
    expect(staff.length).toBeGreaterThan(0);
    for (const plan of PLAN_DEFINITIONS) {
      for (const key of staff) {
        expect(plan.featureFlags[key]).toBe(false);
      }
    }
  });

  it("keeps the tier ladder cumulative", () => {
    const [free, plus, pro] = PLAN_DEFINITIONS;
    for (const e of ENTITLEMENTS) {
      // An upgrade must never remove a capability the customer already had.
      if (free.featureFlags[e.key]) expect(plus.featureFlags[e.key]).toBe(true);
      if (plus.featureFlags[e.key]) expect(pro.featureFlags[e.key]).toBe(true);
    }
  });

  it("gives every plan a flag for every catalog key", () => {
    for (const plan of PLAN_DEFINITIONS) {
      for (const e of ENTITLEMENTS) {
        expect(typeof plan.featureFlags[e.key]).toBe("boolean");
      }
    }
  });
});

describe("frontend catalog mirror", () => {
  it("matches the backend key set exactly", () => {
    const ui = catalogKeysInUi();
    const backend = new Set(ENTITLEMENTS.map((e) => e.key));
    expect([...backend].filter((k) => !ui.has(k))).toEqual([]);
    expect([...ui].filter((k) => !backend.has(k))).toEqual([]);
  });
});

describe("SLUG_ENTITLEMENT", () => {
  it("maps every screen to a key that exists", () => {
    const valid = new Set(ENTITLEMENTS.map((e) => e.key));
    const bad = slugMappings().filter((m) => !valid.has(m.key));
    // Failing here means some screen is silently denied to EVERY user.
    expect(bad).toEqual([]);
  });

  it("never gates a screen on a staff-only or unbuilt key", () => {
    const staffOrUnbuilt = new Set(
      ENTITLEMENTS.filter((e) => e.staffOnly || e.unbuilt).map((e) => e.key),
    );
    // Gating a screen on an unbuilt key would paywall something that cannot
    // work even after paying.
    const bad = slugMappings().filter((m) => staffOrUnbuilt.has(m.key));
    expect(bad).toEqual([]);
  });
});
