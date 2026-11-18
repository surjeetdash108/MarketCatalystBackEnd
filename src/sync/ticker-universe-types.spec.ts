import { TickerUniverseJob } from "./ticker-universe.job";

// Logic #3: ETFs/ETNs/preferreds sat on Alpha Signals' "stock" screens because
// company docs carried no security type.
describe("ticker-universe stamps the security type onto existing company docs", () => {
  it("writes only existing docs whose type changed", async () => {
    const stored: Record<string, { type?: string }> = { UUP: {}, AAPL: { type: "CS" }, WVVIP: { type: "CS" } };
    const sets: Array<[string, unknown]> = [];
    const firestore = {
      collection: () => ({ doc: (id: string) => ({ id }) }),
      getAll: (...refs: Array<{ id: string }>) => Promise.resolve(refs.map((r) => ({
        exists: r.id in stored, ref: r, get: (k: string) => (stored[r.id] as Record<string, unknown> | undefined)?.[k],
      }))),
      batch: () => ({ set: (ref: { id: string }, v: unknown) => sets.push([ref.id, v]), commit: () => Promise.resolve() }),
    };
    const job = Object.create(TickerUniverseJob.prototype) as { firebase: unknown; logger: unknown; stampCompanyTypes: (t: unknown[]) => Promise<number> };
    job.firebase = { firestore };
    job.logger = { log: () => undefined };
    const n = await job.stampCompanyTypes([
      { ticker: "UUP", type: "ETV" }, { ticker: "AAPL", type: "CS" }, { ticker: "WVVIP", type: "PFD" }, { ticker: "NEWX", type: "CS" }, { ticker: "X", type: null },
    ]);
    expect(n).toBe(2);
    expect(sets).toEqual([["UUP", { type: "ETV" }], ["WVVIP", { type: "PFD" }]]);
  });
});
