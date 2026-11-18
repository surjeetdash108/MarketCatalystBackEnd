import { constituentTickers, IndexMembersJob, INDEX_MEMBERS_DOC, SEED_PER_RUN } from "./index-members.job";

const rows = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ symbol: `${prefix}${i}` }));

describe("index-members job (Error 9: 'Top S&P 500' listed 340 names)", () => {
  it("canonical tickers from FMP rows", () => {
    expect(constituentTickers([{ symbol: "BRK-B" }, { symbol: "AAPL" }, { symbol: "AAPL" }, {}, null])).toEqual(["AAPL", "BRK.B"]);
  });

  function setup(existing: Set<string>, sp = rows(503, "S"), nd = rows(101, "N")) {
    const docs = new Map<string, unknown>();
    const firestore = {
      doc: (p: string) => ({ set: (v: unknown) => { docs.set(p, v); return Promise.resolve(); } }),
      collection: () => ({ doc: (id: string) => ({ id }) }),
      getAll: (...refs: Array<{ id: string }>) => Promise.resolve(refs.map((r) => ({ exists: existing.has(r.id) }))),
    };
    const fmp = { request: jest.fn((p: string) => Promise.resolve(p.startsWith("sp500") ? sp : nd)) };
    const ondemand = { getCompany: jest.fn(() => Promise.resolve({ ticker: "x" })) };
    const meta = { record: jest.fn(() => Promise.resolve()) };
    const job = new IndexMembersJob({ firestore } as never, meta as never, { register: jest.fn() } as never, fmp as never, ondemand as never);
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0; }) as never);
    return { job, docs, ondemand };
  }
  afterEach(() => jest.restoreAllMocks());

  it("stores both lists and builds missing members' company docs, a bounded number per run", async () => {
    const have = new Set(rows(371, "S").map((r) => r.symbol));
    const { job, docs, ondemand } = setup(have);
    const r = await job.run();
    expect(docs.get(INDEX_MEMBERS_DOC)).toMatchObject({ sp500: expect.any(Array), nasdaq100: expect.any(Array) });
    expect((docs.get(INDEX_MEMBERS_DOC) as { sp500: string[] }).sp500).toHaveLength(503);
    expect(r).toMatchObject({ sp500: 503, missing: 132 + 101, seeded: SEED_PER_RUN });
    expect(ondemand.getCompany).toHaveBeenCalledTimes(SEED_PER_RUN);
  });

  it("a thin vendor answer keeps yesterday's lists", async () => {
    const { job, docs } = setup(new Set(), rows(12, "S"));
    await expect(job.run()).rejects.toThrow(/implausible/);
    expect(docs.size).toBe(0);
  });
});
