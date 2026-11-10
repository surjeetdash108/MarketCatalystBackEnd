import * as fs from "fs";
import * as path from "path";
import { OnDemandService } from "./ondemand.service";

/**
 * E2E Oct 26: LCUT's ex-dividend date read "N/A" at 15:02 CT and KR's Earnings,
 * Insider and SI statements were empty at 15:45 CT, while their stored docs
 * were complete (real captures below). A stale doc made the request wait for a
 * full vendor rebuild, which outran the UI's 20 s timeout. A stored doc is now
 * served at once and rebuilt in the background.
 */
describe("OnDemandService serves a stale stored doc while it rebuilds", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/stored-docs-lcut-kr.json"), "utf-8"));
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const never = () => new Promise<never>(() => undefined);

  function harness(docs: Record<string, unknown>) {
    const firebase = {
      firestore: {
        collection: (name: string) => ({
          doc: (key: string) => ({
            get: () => Promise.resolve({ exists: `${name}/${key}` in docs, data: () => docs[`${name}/${key}`] }),
            set: () => Promise.resolve(),
          }),
          where: () => ({ get: () => Promise.resolve({ docs: [] }) }),
        }),
      },
    };
    const polygon = { getDividendHistory: jest.fn(never), getFinancialStatements: jest.fn(never) };
    const fmp = { getSplits: jest.fn(never), enabled: true };
    const svc = new OnDemandService(
      firebase as never, polygon as never, null as never, null as never, null, null,
      null as never, fmp as never, null as never, null as never, null as never,
    );
    jest.spyOn(svc, "recordUsage").mockImplementation(() => undefined);
    return { svc, polygon };
  }

  it("LCUT dividend history: stored doc (ex-date 2026-10-30) comes back without waiting", async () => {
    const { svc, polygon } = harness({ "dividend_history/LCUT": { ...fx.LCUT_dividend_history, createdAt: twoDaysAgo } });
    const doc = await svc.getDividendHistory("LCUT");
    expect((doc!.history as Array<{ exDividendDate: string }>)[0].exDividendDate).toBe("2026-10-30");
    expect(polygon.getDividendHistory).toHaveBeenCalled(); // the rebuild still starts
  }, 3000);

  it("KR financials: stored doc (10 quarters) comes back without waiting", async () => {
    const { svc, polygon } = harness({ "financials/KR": { ...fx.KR_financials, createdAt: twoDaysAgo } });
    const doc = await svc.getFinancials("KR");
    expect((doc!.quarters as unknown[]).length).toBe(10);
    expect(polygon.getFinancialStatements).toHaveBeenCalled();
  }, 3000);
});
