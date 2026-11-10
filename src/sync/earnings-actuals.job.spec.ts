import { EarningsActualsJob } from "./earnings-actuals.job";

const REPORT_DATE = "2026-11-03";

// SHOP-like: reported today, Q3-2025 is the comparable quarter.
const quarters = [
  { endDate: "2025-06-30", epsActualReported: 0.2, revenue: 2.0e9 },
  { endDate: "2025-09-30", epsActualReported: 0.25, revenue: 2.84e9 },
];

type Doc = Record<string, unknown>;

/** Just enough Firestore for the job: today's earnings_events + financials. */
function harness(
  stored: Doc[],
  vendor: Doc[],
  financials: Record<string, Doc>,
) {
  const sets: Array<{ id: string; patch: Doc }> = [];
  const getAll = jest.fn((...refs: Array<{ id: string }>) =>
    Promise.resolve(
      refs.map((r) => ({
        id: r.id,
        exists: r.id in financials,
        data: () => financials[r.id],
      })),
    ),
  );
  const firestore = {
    collection: (name: string) =>
      name === "earnings_events"
        ? {
            where: () => ({
              get: () =>
                Promise.resolve({
                  empty: stored.length === 0,
                  size: stored.length,
                  docs: stored.map((d) => ({
                    ref: { id: d.ticker as string },
                    data: () => d,
                  })),
                }),
            }),
          }
        : {
            doc: (id: string) => ({ id }),
            // The announcement step reads recent news for a ticker.
            where: () => ({ get: () => Promise.resolve({ docs: [] }) }),
          },
    getAll,
    batch: () => ({
      set: (ref: { id: string }, patch: Doc) =>
        sets.push({ id: ref.id, patch }),
      commit: jest.fn(),
    }),
  };
  const job = new EarningsActualsJob(
    { getUpcoming: () => Promise.resolve(vendor) } as never,
    { firestore } as never,
    { record: jest.fn() } as never,
    { register: jest.fn() } as never,
    { recordAnnouncement: jest.fn() } as never,
  );
  return { job, sets, getAll };
}

const row = (extra: Doc = {}): Doc => ({
  ticker: "SHOP",
  date: REPORT_DATE,
  epsActual: null,
  revenueActual: null,
  epsActualYearAgo: null,
  revenueYearAgo: null,
  ...extra,
});

const vendorRow = (extra: Doc = {}): Doc => ({
  ticker: "SHOP",
  date: REPORT_DATE,
  epsActual: 0.49,
  revenueActual: 3.68e9,
  ...extra,
});

describe("EarningsActualsJob year-ago fill", () => {
  it("writes the year-ago values in the same patch that first fills the actuals", async () => {
    const { job, sets } = harness([row()], [vendorRow()], {
      SHOP: { quarters },
    });
    await job.run();
    expect(sets).toHaveLength(1);
    expect(sets[0].patch).toMatchObject({
      epsActual: 0.49,
      revenueActual: 3.68e9,
      epsActualYearAgo: 0.25,
      revenueYearAgo: 2.84e9,
    });
  });

  it("repairs a row that already holds its actuals but has no year-ago values", async () => {
    const { job, sets } = harness(
      [row({ epsActual: 0.49, revenueActual: 3.68e9 })],
      [vendorRow()],
      { SHOP: { quarters } },
    );
    await job.run();
    expect(sets).toHaveLength(1);
    expect(sets[0].patch).toEqual({
      epsActualYearAgo: 0.25,
      revenueYearAgo: 2.84e9,
    });
  });

  it("repairs it even when the vendor no longer lists the row", async () => {
    const { job, sets } = harness([row({ epsActual: 0.49 })], [], {
      SHOP: { quarters },
    });
    await job.run();
    expect(sets).toHaveLength(1);
    expect(sets[0].patch).toEqual({
      epsActualYearAgo: 0.25,
      revenueYearAgo: 2.84e9,
    });
  });

  it("does not read financials or write anything while the row has no actual", async () => {
    const { job, sets, getAll } = harness(
      [row()],
      [vendorRow({ epsActual: null, revenueActual: null })],
      { SHOP: { quarters } },
    );
    await job.run();
    expect(getAll).not.toHaveBeenCalled();
    expect(sets).toHaveLength(0);
  });

  it("does not read financials or write anything when nothing changed", async () => {
    const { job, sets, getAll } = harness(
      [
        row({
          epsActual: 0.49,
          revenueActual: 3.68e9,
          epsActualYearAgo: 0.25,
          revenueYearAgo: 2.84e9,
        }),
      ],
      [vendorRow()],
      { SHOP: { quarters } },
    );
    await job.run();
    expect(getAll).not.toHaveBeenCalled();
    expect(sets).toHaveLength(0);
  });

  it("still stores the actuals, leaving year-ago blank, when there is no comparable quarter", async () => {
    const { job, sets } = harness([row()], [vendorRow()], {
      SHOP: {
        quarters: [{ endDate: "2024-03-31", epsActualReported: 1, revenue: 1 }],
      },
    });
    await job.run();
    expect(sets).toHaveLength(1);
    expect(sets[0].patch).toMatchObject({
      epsActual: 0.49,
      revenueActual: 3.68e9,
    });
    expect(sets[0].patch).not.toHaveProperty("epsActualYearAgo");
  });

  it("still stores the actuals when the ticker has no financials doc", async () => {
    const { job, sets } = harness([row()], [vendorRow()], {});
    await job.run();
    expect(sets).toHaveLength(1);
    expect(sets[0].patch).toMatchObject({ epsActual: 0.49 });
    expect(sets[0].patch).not.toHaveProperty("epsActualYearAgo");
  });
});
