import { FakeFirestore } from "../../test/support/fake-firestore";
import type { FirebaseAdminService } from "../common/firebase-admin.provider";
import type { StockInFocusEntry, StockInFocusService } from "../stock-in-focus/stock-in-focus.service";
import type { CachedCollectionsService } from "./cached-collections.service";
import { SLOW_DATA_DEADLINE_MS, WmnSlidesService } from "./wmn-slides.service";

// Thu 26 Nov 2026, 18:00 UTC = 13:00 New York (afternoon, so only today's reporters count).
const NOW = new Date("2026-11-26T18:00:00Z");
const at = (secs: number) => new Date(NOW.getTime() + secs * 1000);

// 450 priced S&P members (enough for the weights), plus one big name that reports.
const companies = [
  ...Array.from({ length: 450 }, (_, i) => ({ ticker: `T${i}`, name: `Name ${i}`, marketCap: 1e10, pctChange: 0 })),
  { ticker: "BIG", name: "Big Co", marketCap: 900e9, pctChange: 0 },
];
const members = companies.map((c) => c.ticker);

const upgrade = { ticker: "BIG", recentGrades: [{ date: "2026-11-26", firm: "A", action: "upgrade", newGrade: "Buy" }] };

function build(opts: {
  /** Per-collection override: return a promise to control timing, or throw to fail. */
  cached?: (name: string) => Promise<unknown[]>;
  entry?: StockInFocusEntry | null | Error;
  fs?: FakeFirestore;
} = {}) {
  const fs = opts.fs ?? new FakeFirestore();
  fs.seed("config", "index_members", { sp500: members });
  const calls: string[] = [];
  const cached = {
    get: jest.fn(async (names: string[]) => {
      const name = names[0];
      calls.push(name);
      const rows = opts.cached
        ? await opts.cached(name)
        : ({ companies, market_breadth: [], macro_events: [], analyst_actions: [upgrade] } as Record<string, unknown[]>)[name] ?? [];
      return { [name]: rows };
    }),
  } as unknown as CachedCollectionsService;
  const sif = {
    latest: jest.fn(async () => {
      if (opts.entry instanceof Error) throw opts.entry;
      return opts.entry ?? null;
    }),
  } as unknown as StockInFocusService;
  const svc = new WmnSlidesService(cached, { firestore: fs } as unknown as FirebaseAdminService, sif);
  return { svc, fs, calls, cached };
}

describe("WmnSlidesService", () => {
  afterEach(() => jest.useRealTimers());

  it("reads earnings for yesterday and today straight from Firestore, never through the cached full calendar", async () => {
    const fs = new FakeFirestore();
    fs.seed("earnings_events", "e1", { ticker: "BIG", date: "2026-11-26", session: "AMC", epsEstimate: 2, epsActual: null });
    fs.seed("earnings_events", "old", { ticker: "T1", date: "2026-11-20", session: "AMC", epsEstimate: 1, epsActual: 1 });
    fs.seed("earnings_events", "future", { ticker: "T2", date: "2026-11-30", session: "AMC", epsEstimate: 1, epsActual: null });
    const { svc, calls } = build({ fs });
    const out = await svc.get(NOW);
    expect(out.earnings?.items.map((i) => i.ticker)).toEqual(["BIG"]);
    expect(out.earnings?.total).toBe(1);
    // The 12,000-document collection is not loaded for this.
    expect(calls).not.toContain("earnings_events");
    expect(calls).not.toContain("earnings_announcements");
  });

  it("shows no earnings slide when nobody reports on those days", async () => {
    const fs = new FakeFirestore();
    fs.seed("earnings_events", "old", { ticker: "T1", date: "2026-11-20", session: "AMC", epsEstimate: 1, epsActual: 1 });
    const { svc } = build({ fs });
    expect((await svc.get(NOW)).earnings).toBeNull();
  });

  it("does not wait on a collection that is still loading: that slide is left out, the rest is returned", async () => {
    jest.useFakeTimers();
    const { svc } = build({
      cached: async (name) => {
        if (name === "analyst_actions") return new Promise<unknown[]>(() => {}); // a cold load that never finishes here
        return name === "companies" ? companies : [];
      },
    });
    const p = svc.get(NOW);
    await jest.advanceTimersByTimeAsync(SLOW_DATA_DEADLINE_MS + 100);
    const out = await p;
    expect(out.analysts).toBeNull();
    expect(out.weights).not.toBeNull(); // everything else still made it
  });

  it("a partial response is reused only briefly, so the slide fills in once its data has loaded", async () => {
    jest.useFakeTimers();
    let ready = false;
    const { svc, cached } = build({
      cached: async (name) => {
        if (name === "analyst_actions") return ready ? [upgrade] : new Promise<unknown[]>(() => {});
        return name === "companies" ? companies : [];
      },
    });
    const first = svc.get(NOW);
    await jest.advanceTimersByTimeAsync(SLOW_DATA_DEADLINE_MS + 100);
    expect((await first).analysts).toBeNull();

    // Still inside the short partial window: the same answer, no rebuild.
    const callsBefore = (cached.get as jest.Mock).mock.calls.length;
    expect((await svc.get(at(10))).analysts).toBeNull();
    expect((cached.get as jest.Mock).mock.calls.length).toBe(callsBefore);

    // The data has loaded and the partial window has passed: it is rebuilt, and now complete.
    ready = true;
    expect((await svc.get(at(20))).analysts).not.toBeNull();
  });

  it("a complete response is reused for the full two minutes", async () => {
    const { svc, cached } = build();
    await svc.get(NOW);
    const callsAfterFirst = (cached.get as jest.Mock).mock.calls.length;
    await svc.get(at(60));
    expect((cached.get as jest.Mock).mock.calls.length).toBe(callsAfterFirst); // served from the composed cache
    await svc.get(at(130));
    expect((cached.get as jest.Mock).mock.calls.length).toBeGreaterThan(callsAfterFirst); // expired, rebuilt
  });

  it("a failed read leaves that slide empty and nothing else", async () => {
    const { svc } = build({
      cached: async (name) => {
        if (name === "macro_events") throw new Error("firestore unavailable");
        return name === "companies" ? companies : name === "analyst_actions" ? [upgrade] : [];
      },
    });
    const out = await svc.get(NOW);
    expect(out.catalysts).toEqual([]);
    expect(out.analysts).not.toBeNull();
    expect(out.weights).not.toBeNull();
  });

  it("attaches the latest Stock in Focus, and a failure there leaves only that slide empty", async () => {
    const entry: StockInFocusEntry = { day: "2026-11-26", ticker: "NVDA", headline: "h", note: "", createdAt: "x", updatedAt: "x" };
    expect((await build({ entry }).svc.get(NOW)).stockInFocus).toEqual(entry);
    const failed = await build({ entry: new Error("boom") }).svc.get(NOW);
    expect(failed.stockInFocus).toBeNull();
    expect(failed.analysts).not.toBeNull();
  });
});
