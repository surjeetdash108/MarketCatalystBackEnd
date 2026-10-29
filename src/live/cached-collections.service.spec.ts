import { CachedCollectionsService } from "./cached-collections.service";

/** A Firestore stub whose `get()` calls are counted and resolved by the test. */
function makeService() {
  const calls: Array<{
    name: string;
    resolve: (docs: Array<{ id: string }>) => void;
    reject: (err: Error) => void;
  }> = [];
  const firebase = {
    firestore: {
      collection: (name: string) => ({
        get: () =>
          new Promise((resolve, reject) => {
            calls.push({
              name,
              resolve: (docs) =>
                resolve({ docs: docs.map((d) => ({ id: d.id, data: () => ({}) })) }),
              reject,
            });
          }),
      }),
    },
  };
  const delisted = { filterRows: async <T>(rows: T[]) => rows };
  const svc = new CachedCollectionsService(firebase as never, delisted as never);
  return { svc, calls };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("CachedCollectionsService", () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ["setImmediate"] }));
  afterEach(() => jest.useRealTimers());

  it("shares one Firestore read between concurrent cold callers", async () => {
    const { svc, calls } = makeService();
    const a = svc.get(["companies"]);
    const b = svc.get(["companies"]);
    const c = svc.get(["companies", "market_movers"]);
    await flush();
    expect(calls.filter((x) => x.name === "companies")).toHaveLength(1);
    calls.forEach((x) => x.resolve([{ id: "AAPL" }]));
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra.companies).toEqual([{ id: "AAPL" }]);
    expect(rb.companies).toBe(ra.companies);
    expect(rc.companies).toBe(ra.companies);
  });

  it("serves stale data at once after expiry and refreshes in the background", async () => {
    const { svc, calls } = makeService();
    const first = svc.get(["companies"]);
    await flush();
    calls[0].resolve([{ id: "OLD" }]);
    await first;

    jest.advanceTimersByTime(6 * 60 * 1000); // past the 5-min FAST TTL
    const stale = await svc.get(["companies"]); // must not wait on Firestore
    expect(stale.companies).toEqual([{ id: "OLD" }]);
    expect(calls).toHaveLength(2);

    // A second caller during the refresh does not start another read.
    await svc.get(["companies"]);
    expect(calls).toHaveLength(2);

    calls[1].resolve([{ id: "NEW" }]);
    await flush();
    expect((await svc.get(["companies"])).companies).toEqual([{ id: "NEW" }]);
    expect(calls).toHaveLength(2);
  });

  it("keeps serving stale data when a refresh fails, and backs off retries", async () => {
    const { svc, calls } = makeService();
    const first = svc.get(["companies"]);
    await flush();
    calls[0].resolve([{ id: "OLD" }]);
    await first;

    jest.advanceTimersByTime(6 * 60 * 1000);
    await svc.get(["companies"]);
    calls[1].reject(new Error("firestore down"));
    await flush();

    // Still stale-but-served, and no immediate retry storm.
    expect((await svc.get(["companies"])).companies).toEqual([{ id: "OLD" }]);
    expect(calls).toHaveLength(2);

    jest.advanceTimersByTime(31 * 1000); // backoff elapsed
    await svc.get(["companies"]);
    expect(calls).toHaveLength(3);
  });

  it("returns an empty list when a cold read fails", async () => {
    const { svc, calls } = makeService();
    const p = svc.get(["companies"]);
    await flush();
    calls[0].reject(new Error("boom"));
    expect((await p).companies).toEqual([]);
  });
});
