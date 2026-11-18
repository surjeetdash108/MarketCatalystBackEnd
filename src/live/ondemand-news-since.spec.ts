import { OnDemandService } from "./ondemand.service";

/**
 * GET /live/news?since= should not re-read a ticker's whole stored history from
 * Firestore on every poll (NVDA: ~3,900 docs). Reads are counted per query shape.
 */
describe("OnDemandService.getNewsSince", () => {
  const T0 = Date.parse("2026-11-18T10:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const doc = (id: string, createdMs: number) => ({
    id,
    data: () => ({ ticker: "NVDA", headline: id, publishedAt: iso(createdMs), createdAt: iso(createdMs), updatedAt: iso(T0) }),
  });
  const stored = [doc("NVDA_a", T0 - 3_000_000), doc("NVDA_b", T0 - 2_000_000)];

  function harness(opts: { indexMissing?: boolean } = {}) {
    const calls = { full: 0, since: 0 };
    let sinceFilter: string | undefined;
    const firebase = {
      firestore: {
        collection: () => ({
          where: () => ({
            get: () => {
              calls.full++;
              return Promise.resolve({ docs: stored });
            },
            where: (_f: string, _op: string, value: string) => ({
              get: () => {
                calls.since++;
                sinceFilter = value;
                if (opts.indexMissing) {
                  return Promise.reject(Object.assign(new Error("9 FAILED_PRECONDITION: The query requires an index"), { code: 9 }));
                }
                return Promise.resolve({ docs: stored.filter((d) => Date.parse(d.data().createdAt) > Date.parse(value)) });
              },
            }),
          }),
        }),
      },
    };
    const svc = new OnDemandService(
      firebase as never, null as never, null as never, null as never, null, null,
      null as never, null as never, null as never, null as never, null as never,
    );
    return { svc, calls, getSinceFilter: () => sinceFilter };
  }

  let now = T0;
  beforeEach(() => {
    now = T0;
    jest.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  it("serves a poll from instance memory with no Firestore read", async () => {
    const { svc, calls } = harness();
    await svc.getNews("NVDA"); // first load: one full read
    expect(calls.full).toBe(1);
    now = T0 + 60_000; // still inside the 5-minute memory window
    const out = await svc.getNewsSince("NVDA", T0 - 1_000_000);
    expect(out).toEqual([]);
    expect(calls).toEqual({ full: 1, since: 0 });
  });

  it("after memory expires, queries only newer docs instead of re-reading everything", async () => {
    const { svc, calls, getSinceFilter } = harness();
    await svc.getNews("NVDA");
    now = T0 + 6 * 60_000; // memory expired, ticker still confirmed fresh (<15 min)
    const out = await svc.getNewsSince("NVDA", T0 - 2_500_000);
    expect(calls).toEqual({ full: 1, since: 1 });
    expect(getSinceFilter()).toBe(iso(T0 - 2_500_000));
    expect(out.map((a) => a.id)).toEqual(["NVDA_b"]);
  });

  it("shares one query between polls that send the same cursor within 30 s", async () => {
    const { svc, calls } = harness();
    await svc.getNews("NVDA");
    now = T0 + 6 * 60_000;
    await svc.getNewsSince("NVDA", T0 - 2_500_000);
    now += 10_000;
    await svc.getNewsSince("NVDA", T0 - 2_500_000);
    expect(calls.since).toBe(1);
  });

  it("falls back to the full read while the composite index is not deployed", async () => {
    const { svc, calls } = harness({ indexMissing: true });
    await svc.getNews("NVDA");
    now = T0 + 6 * 60_000;
    const out = await svc.getNewsSince("NVDA", T0 - 2_500_000);
    expect(calls).toEqual({ full: 2, since: 1 });
    expect(out.map((a) => a.id)).toEqual(["NVDA_b"]);
  });
});
