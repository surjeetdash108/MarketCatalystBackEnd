import { mkdtempSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import type { Firestore } from "firebase-admin/firestore";
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
import { applyCatalog } from "./catalog-apply";
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

describe("catalog apply (scripts/apply-catalog.ts)", () => {
  const T = new Date("2026-11-10T12:00:00.000Z");
  const db = (fs: FakeFirestore) => fs as unknown as Firestore;
  const service = (fs: FakeFirestore) =>
    new PlansService({ firestore: fs } as unknown as FirebaseAdminService);
  // The production plans collection today (read-only snapshot, 2026-11-10).
  const seedV1 = (fs: FakeFirestore) => {
    fs.seed("plans", "free", {
      id: "free",
      amount: 0,
      active: true,
      sortOrder: 0,
    });
    fs.seed("plans", "plus", {
      id: "plus",
      amount: 2999,
      active: true,
      sortOrder: 1,
    });
    fs.seed("plans", "pro", {
      id: "pro",
      amount: 4999,
      active: true,
      sortOrder: 2,
      featureFlags: { optionsChain: true },
    });
  };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "catalog-"));
  });

  it("booting the app never writes the catalog (no onModuleInit seed)", () => {
    expect(
      (PlansService.prototype as unknown as Record<string, unknown>)
        .onModuleInit,
    ).toBeUndefined();
  });

  it("dry run lists the exact diff against v1 and writes nothing", async () => {
    const fs = new FakeFirestore();
    seedV1(fs);
    const r = await applyCatalog(db(fs), { dryRun: true, now: T });
    expect(r.backupFile).toBeNull();
    expect(r.changes.map((c) => `${c.op} ${c.id}`)).toEqual([
      "rewrite free",
      "create starter",
      "rewrite pro",
      "create elite",
      "retire plus",
    ]);
    const pro = r.changes.find((c) => c.id === "pro")!;
    expect(pro.fields).toEqual(
      expect.arrayContaining([
        { path: "amount", before: 4999, after: 5900 },
        { path: "prices.annual.amount", before: undefined, after: 56640 },
      ]),
    );
    expect(fs.read("plans", "pro").amount).toBe(4999);
    expect(fs.read("plans", "starter")).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("apply backs up the whole collection first, then writes; plus is retired", async () => {
    const fs = new FakeFirestore();
    seedV1(fs);
    const r = await applyCatalog(db(fs), {
      dryRun: false,
      backupDir: dir,
      now: T,
    });
    expect(r.backupFile).toBe(
      join(dir, "plans-backup-2026-11-10T12-00-00-000Z.json"),
    );
    const backup = JSON.parse(readFileSync(r.backupFile!, "utf8"));
    expect(Object.keys(backup.docs).sort()).toEqual(["free", "plus", "pro"]);
    expect(backup.docs.pro.amount).toBe(4999);
    expect(fs.read("plans", "pro")).toMatchObject({
      amount: 5900,
      catalogVersion: CATALOG_VERSION,
      prices: { annual: { amount: 56640 } },
    });
    expect(fs.read("plans", "plus")?.active).toBe(false);
  });

  it("is idempotent: a second run changes nothing and takes no backup", async () => {
    const fs = new FakeFirestore();
    seedV1(fs);
    await applyCatalog(db(fs), { dryRun: false, backupDir: dir, now: T });
    const before = JSON.stringify(fs.read("plans", "pro"));
    const again = await applyCatalog(db(fs), {
      dryRun: false,
      backupDir: dir,
      now: new Date(T.getTime() + 60_000),
    });
    expect(again.writes).toEqual([]);
    expect(again.changes.every((c) => c.op === "unchanged")).toBe(true);
    expect(again.backupFile).toBeNull();
    expect(JSON.stringify(fs.read("plans", "pro"))).toBe(before);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("refuses to write without a backup directory", async () => {
    const fs = new FakeFirestore();
    seedV1(fs);
    await expect(
      applyCatalog(db(fs), { dryRun: false, now: T }),
    ).rejects.toThrow(/backupDir/);
    expect(fs.read("plans", "pro").amount).toBe(4999);
  });

  it("keeps an operator's entitlement edit within the same catalog version, but never their price", async () => {
    const fs = new FakeFirestore();
    await applyCatalog(db(fs), { dryRun: false, backupDir: dir, now: T });
    const pro = fs.read("plans", "pro");
    fs.seed("plans", "pro", {
      ...pro,
      amount: 1,
      featureFlags: { ...(pro.featureFlags as object), screener: false },
    });
    await applyCatalog(db(fs), { dryRun: false, backupDir: dir, now: T });
    const after = fs.read("plans", "pro");
    expect((after.featureFlags as Record<string, boolean>).screener).toBe(
      false,
    );
    expect(after.amount).toBe(5900);
  });

  it("before the apply, readers get the registry catalog (not the v1 docs); after it, the stored docs", async () => {
    const fs = new FakeFirestore();
    seedV1(fs);
    const before = await service(fs).listActive();
    expect(before.map((p) => [p.id, p.amount])).toEqual([
      ["free", 0],
      ["starter", 3900],
      ["pro", 5900],
      ["elite", 19900],
    ]);
    await applyCatalog(db(fs), { dryRun: false, backupDir: dir, now: T });
    const pro = fs.read("plans", "pro");
    fs.seed("plans", "pro", { ...pro, description: "edited after apply" });
    const after = await service(fs).listActive();
    expect(after.map((p) => p.id)).toEqual(["free", "starter", "pro", "elite"]);
    expect(after.find((p) => p.id === "pro")?.description).toBe(
      "edited after apply",
    );
  });

  it("the admin preview is a dry run", async () => {
    const fs = new FakeFirestore();
    seedV1(fs);
    const r = await service(fs).previewCatalog();
    expect(r.changes.length).toBeGreaterThan(0);
    expect(fs.read("plans", "pro").amount).toBe(4999);
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
