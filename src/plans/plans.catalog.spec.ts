import { readFileSync } from "fs";
import { join } from "path";
import { FakeFirestore } from "../../test/support/fake-firestore";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  CATALOG_VERSION,
  ENTITLEMENTS,
  PLAN_DEFINITIONS,
  catalogPrice,
  lowestPlanFor,
  planRank,
} from "./plans.registry";
import { PlansService } from "./plans.service";
import {
  uiCatalogSource,
  websiteCatalogJson,
} from "../../scripts/export-catalog";

/** The one catalog (doc Step 1, decision a) — exactly what the website sells. */
const EXPECTED = {
  free: { monthly: undefined, annual: undefined },
  starter: { monthly: 3900, annual: 37440 },
  pro: { monthly: 5900, annual: 56640 },
  elite: { monthly: 19900, annual: 179100 },
};

describe("plan catalog", () => {
  it("is exactly Free, Starter, Pro, Elite in that order", () => {
    expect(PLAN_DEFINITIONS.map((p) => p.id)).toEqual([
      "free",
      "starter",
      "pro",
      "elite",
    ]);
    expect(PLAN_DEFINITIONS.map((p) => planRank(p.id))).toEqual([0, 1, 2, 3]);
  });

  it.each(Object.entries(EXPECTED))(
    "%s has the website's monthly and annual prices",
    (id, want) => {
      expect(catalogPrice(id, "monthly")?.amount).toBe(want.monthly);
      expect(catalogPrice(id, "annual")?.amount).toBe(want.annual);
    },
  );

  it("annual prices are the advertised discounts (20% / 20% / 25%)", () => {
    const off = (id: string) =>
      1 -
      catalogPrice(id, "annual").amount /
        (catalogPrice(id, "monthly").amount * 12);
    expect(off("starter")).toBeCloseTo(0.2, 6);
    expect(off("pro")).toBeCloseTo(0.2, 6);
    expect(off("elite")).toBeCloseTo(0.25, 6);
  });

  it("has no trace of the retired plus plan or its $29.99/$49.99 prices", () => {
    expect(PLAN_DEFINITIONS.find((p) => p.id === "plus")).toBeUndefined();
    const amounts = PLAN_DEFINITIONS.flatMap((p) => [
      p.amount,
      ...Object.values(p.prices).map((x) => x.amount),
    ]);
    expect(amounts).not.toContain(2999);
    expect(amounts).not.toContain(4999);
  });

  it("gives every paid price a unique Stripe lookup key", () => {
    const keys = PLAN_DEFINITIONS.flatMap((p) =>
      Object.values(p.prices).map((x) => x.lookupKey),
    );
    expect(new Set(keys).size).toBe(6);
  });

  it("keeps the tier ladder cumulative across all four plans", () => {
    for (let i = 1; i < PLAN_DEFINITIONS.length; i++) {
      for (const e of ENTITLEMENTS) {
        if (PLAN_DEFINITIONS[i - 1].featureFlags[e.key]) {
          expect([
            PLAN_DEFINITIONS[i].id,
            e.key,
            PLAN_DEFINITIONS[i].featureFlags[e.key],
          ]).toEqual([PLAN_DEFINITIONS[i].id, e.key, true]);
        }
      }
    }
  });

  it("puts features on the plans the doc's Step 1 table says", () => {
    expect(lowestPlanFor("watchlist")?.id).toBe("free");
    expect(lowestPlanFor("chartsDaily")?.id).toBe("free");
    expect(lowestPlanFor("workspaces")?.id).toBe("starter");
    expect(lowestPlanFor("ownership")?.id).toBe("starter");
    expect(lowestPlanFor("aiAssistant")?.id).toBe("starter");
    expect(lowestPlanFor("moneyFlow")?.id).toBe("pro");
    expect(lowestPlanFor("optionsChain")?.id).toBe("pro");
    expect(lowestPlanFor("strategyLab")?.id).toBe("elite");
    expect(lowestPlanFor("backtesting")?.id).toBe("elite");
  });

  it("backtesting is built (not hidden) and only on Elite", () => {
    const bt = ENTITLEMENTS.find((e) => e.key === "backtesting");
    expect(bt.unbuilt).toBeFalsy();
    expect(
      PLAN_DEFINITIONS.filter((p) => p.featureFlags.backtesting).map(
        (p) => p.id,
      ),
    ).toEqual(["elite"]);
  });

  it("never grants an unbuilt feature on any plan", () => {
    for (const e of ENTITLEMENTS.filter((x) => x.unbuilt)) {
      for (const p of PLAN_DEFINITIONS)
        expect([p.id, e.key, p.featureFlags[e.key]]).toEqual([
          p.id,
          e.key,
          false,
        ]);
    }
  });

  it("labels the options chain as having simulated data", () => {
    expect(ENTITLEMENTS.find((e) => e.key === "optionsChain")?.note).toBe(
      "some data simulated",
    );
  });

  it("caps the Free watchlist at 5 tickers and paid plans at none", () => {
    expect(PLAN_DEFINITIONS.map((p) => p.limits.watchlistTickers)).toEqual([
      5,
      null,
      null,
      null,
    ]);
  });
});

describe("PlansService.seed", () => {
  const service = (fs: FakeFirestore) =>
    new PlansService({ firestore: fs } as unknown as FirebaseAdminService);

  it("rewrites plan docs from an older catalog (old $49.99 Pro) and deactivates plus", async () => {
    const fs = new FakeFirestore();
    fs.seed("plans", "pro", {
      id: "pro",
      amount: 4999,
      featureFlags: { optionsChain: true },
    });
    fs.seed("plans", "plus", { id: "plus", amount: 2999, active: true });
    const r = await service(fs).seed();
    expect(r.rewritten.sort()).toEqual(["elite", "free", "pro", "starter"]);
    expect(r.retired).toEqual(["plus"]);
    expect(fs.read("plans", "pro")).toMatchObject({
      amount: 5900,
      catalogVersion: CATALOG_VERSION,
      prices: { annual: { amount: 56640 } },
    });
    expect(fs.read("plans", "plus")?.active).toBe(false);
  });

  it("keeps an operator's entitlement edit within the same catalog version, but never their price", async () => {
    const fs = new FakeFirestore();
    const svc = service(fs);
    await svc.seed();
    const pro = fs.read("plans", "pro");
    fs.seed("plans", "pro", {
      ...pro,
      amount: 1,
      featureFlags: { ...(pro.featureFlags as object), screener: false },
    });
    await svc.seed();
    const after = fs.read("plans", "pro");
    expect((after.featureFlags as Record<string, boolean>).screener).toBe(
      false,
    );
    expect(after.amount).toBe(5900);
  });

  it("GET /plans data excludes retired plans", async () => {
    const fs = new FakeFirestore();
    fs.seed("plans", "plus", { id: "plus", active: true, sortOrder: 1 });
    const svc = service(fs);
    await svc.seed();
    expect((await svc.listActive()).map((p) => p.id)).toEqual([
      "free",
      "starter",
      "pro",
      "elite",
    ]);
  });
});

describe("catalog copies in other repos", () => {
  const root = join(__dirname, "../../..");
  it("the UI entitlement mirror is the generated one", () => {
    expect(
      readFileSync(
        join(root, "MarketCatalystUI/app/admin/entitlement-catalog.ts"),
        "utf8",
      ),
    ).toBe(uiCatalogSource());
  });
  it("the website's fallback price list is the generated one", () => {
    expect(
      readFileSync(
        join(root, "MarketCatalystWebsite/lib/pricing/catalog.json"),
        "utf8",
      ),
    ).toBe(websiteCatalogJson());
  });
});
