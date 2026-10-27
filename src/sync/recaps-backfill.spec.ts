import * as fs from "fs";
import * as path from "path";
import { RecapsJob } from "./recaps.job";

/**
 * One-off repair, E2E Oct 26: the Oct 23 recap still showed the QQQ proxy as
 * "Nasdaq" at −0.01% (public Nasdaq Composite −0.21%). Real FMP ^IXIC rows.
 */
describe("RecapsJob.backfillNasdaq", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "../common/fixtures/nasdaq-oct23.json"), "utf-8"));
  it("patches the Oct 23 recap and leaves a date without an ^IXIC row alone", async () => {
    const sets: Array<{ id: string; data: { indices: Array<{ label: string; pctChange: number | null }> } }> = [];
    const doc = (id: string, data: unknown) => ({ data: () => data, ref: { set: (d: never) => (sets.push({ id, data: d }), Promise.resolve()) } });
    const docs = [
      doc("2026-10-23", { date: "2026-10-23", indices: [
        { id: "SPX", label: "S&P 500", value: 6800, pctChange: -0.1, isProxy: true, proxyTicker: "SPY" },
        { id: "NDX", label: "Nasdaq", value: 25639, pctChange: -0.01, isProxy: true, proxyTicker: "QQQ" },
      ] }),
      doc("2026-10-24", { date: "2026-10-24", indices: [] }),
    ];
    const firebase = { firestore: { collection: () => ({ where: () => ({ get: async () => ({ size: docs.length, docs }) }) }) } };
    const meta = { record: jest.fn() };
    const fmp = { request: jest.fn(async () => fx.IXIC) };
    const job = new RecapsJob(firebase as never, meta as never, { register: jest.fn() } as never, fmp as never);
    const r = await job.backfillNasdaq();
    expect(r).toEqual({ checked: 2, patched: 1, skipped: 1 });
    expect(sets[0].id).toBe("2026-10-23");
    expect(sets[0].data.indices.map((i) => [i.label, i.pctChange])).toEqual([["S&P 500", -0.1], ["Nasdaq", -0.21], ["Nasdaq-100", -0.01]]);
  });
});
