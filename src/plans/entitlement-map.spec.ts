import { existsSync, readFileSync } from "fs";
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

const UI_APP_ROOT = join(__dirname, "../../../MarketCatalystUI/app");
const UI_CATALOG_FILE = existsSync(join(UI_APP_ROOT, "iq/entitlements.tsx"))
  ? join(UI_APP_ROOT, "iq/entitlements.tsx")
  : join(UI_APP_ROOT, "admin/entitlement-catalog.ts");
const UI_GATE_FILE = join(UI_APP_ROOT, "iq/entitlement-gate.tsx");
const UI_FEATURE_MAP_FILE = join(UI_APP_ROOT, "iq/feature-map.generated.ts");

function catalogKeysInUi(): Set<string> {
  const src = readFileSync(UI_CATALOG_FILE, "utf8");
  return new Set([...src.matchAll(/\{ key: "([a-zA-Z]+)"/g)].map((m) => m[1]));
}

/**
 * Parses SCREEN_FEATURES out of the UI generated feature map file.
 */
function slugMappings(): Array<{ slug: string; key: string }> {
  if (!existsSync(UI_FEATURE_MAP_FILE)) {
    throw new Error(`UI feature map file missing: ${UI_FEATURE_MAP_FILE}`);
  }
  const src = readFileSync(UI_FEATURE_MAP_FILE, "utf8");
  const start = src.indexOf("SCREEN_FEATURES");
  if (start === -1) {
    throw new Error(`SCREEN_FEATURES not found in ${UI_FEATURE_MAP_FILE}`);
  }
  const block = src.slice(start, src.indexOf("} as const;", start));
  return [...block.matchAll(/"([a-zA-Z-]+)": "([a-zA-Z]+)"/g)]
    .map((m) => ({ slug: m[1], key: m[2] }));
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
    for (let i = 1; i < PLAN_DEFINITIONS.length; i++) {
      const [lower, higher] = [PLAN_DEFINITIONS[i - 1], PLAN_DEFINITIONS[i]];
      for (const e of ENTITLEMENTS) {
        // An upgrade must never remove a capability the customer already had.
        if (lower.featureFlags[e.key]) expect(higher.featureFlags[e.key]).toBe(true);
      }
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

describe("SCREEN_FEATURES", () => {
  it("the UI gate uses the generated map and does not define a hand-kept SLUG_ENTITLEMENT", () => {
    const src = readFileSync(UI_GATE_FILE, "utf8");
    expect(src.includes("SLUG_ENTITLEMENT")).toBe(false);
    expect(src.includes("SCREEN_FEATURES")).toBe(true);
  });

  it("exists in the UI and maps at least the core screens", () => {
    const slugs = new Set(slugMappings().map((m) => m.slug));
    for (const s of ["dashboard", "screener", "portfolio", "insider"]) {
      expect(slugs.has(s)).toBe(true);
    }
  });

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
