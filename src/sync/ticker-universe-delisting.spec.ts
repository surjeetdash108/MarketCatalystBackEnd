import { TickerUniverseJob } from "./ticker-universe.job";
import { DelistedTickersService } from "../common/delisted-tickers.service";
import type { FirebaseAdminService } from "../common/firebase-admin.provider";
import type { PolygonService } from "../vendors/polygon/polygon.service";

/**
 * Delisted symbols must leave the app (AACB showed its 19 Aug close as today's
 * price for two months) — but a short vendor pull must never hide live ones.
 */

type Write = { op: "set" | "delete"; path: string; data?: Record<string, unknown> };

function harness(opts: {
  delisted: Record<string, string | null>; // ticker → delistedAt; absent = no record
  /** Tickers with a `companies` doc; omitted = every ticker has one. */
  companies?: string[];
  onCommit?: (writes: number) => void;
}) {
  const writes: Write[] = [];
  const hasCompany = (id: string) => !opts.companies || opts.companies.includes(id);
  const db = {
    collection: (c: string) => ({ doc: (id: string) => ({ path: `${c}/${id}`, id }) }),
    getAll: (...refs: Array<{ path: string; id: string }>) =>
      Promise.resolve(
        refs.map((r) => ({ id: r.id, exists: r.path.startsWith("companies/") && hasCompany(r.id) })),
      ),
    batch: () => {
      let n = 0;
      return {
        set: (ref: { path: string }, data: Record<string, unknown>) =>
          (n++, writes.push({ op: "set", path: ref.path, data })),
        delete: (ref: { path: string }) =>
          (n++, writes.push({ op: "delete", path: ref.path })),
        commit: () => (opts.onCommit?.(n), Promise.resolve()),
      };
    },
  };
  const firebase = { firestore: db } as unknown as FirebaseAdminService;
  const polygon = {
    getDelisting: jest.fn((t: string) =>
      Promise.resolve(t in opts.delisted ? { delistedAt: opts.delisted[t] } : null),
    ),
  } as unknown as PolygonService;
  const delisted = { invalidate: jest.fn() } as unknown as DelistedTickersService;
  const job = new TickerUniverseJob(
    null as never, firebase, null as never, null as never, polygon, delisted,
  );
  /** `prev` were in last run's pull; `stale` dropped out before it (the backlog). */
  const mark = (prev: string[], fetched: string[], stale: string[] = []) =>
    (job as unknown as {
      markDelisted(
        p: Array<{ id: string; updatedAt: string | null }>,
        f: Set<string>,
      ): Promise<string[]>;
    }).markDelisted(
      [
        ...prev.map((id) => ({ id, updatedAt: LAST_PULL })),
        ...stale.map((id, i) => ({
          id,
          // Oldest first by index; spread across July → October.
          updatedAt: new Date(Date.parse("2026-07-26T12:00:00Z") + i * 3_600_000).toISOString(),
        })),
      ],
      new Set(fetched),
    );
  const restore = (relisted: string[]) =>
    (job as unknown as { restoreRelisted(r: string[]): Promise<void> }).restoreRelisted(relisted);
  return { mark, restore, writes, polygon, delisted };
}

const LAST_PULL = "2026-10-15T12:00:28.172Z";

const many = (n: number, prefix = "T") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("TickerUniverseJob.markDelisted", () => {
  it("marks a confirmed drop-out inactive and soft-deletes its companies doc", async () => {
    const { mark, writes, delisted } = harness({ delisted: { AACB: "2026-08-20" } });
    const live = many(100);
    const out = await mark([...live, "AACB"], live);

    expect(out).toEqual(["AACB"]);
    expect(writes).toEqual([
      { op: "set", path: "tickers/AACB", data: expect.objectContaining({ active: false, delistedAt: "2026-08-20" }) },
      { op: "set", path: "companies/AACB", data: expect.objectContaining({ delisted: true, delistedAt: "2026-08-20" }) },
    ]);
    expect(writes.some((w) => w.op === "delete")).toBe(false);
    expect(delisted.invalidate).toHaveBeenCalled();
  });

  it("never creates a companies doc for a delisted symbol that had none", async () => {
    const { mark, writes } = harness({ delisted: { ACHR_WS: "2026-09-15" }, companies: [] });
    const live = many(100);
    expect(await mark([...live, "ACHR_WS"], live)).toEqual(["ACHR_WS"]);
    expect(writes.map((w) => w.path)).toEqual(["tickers/ACHR_WS"]);
  });

  it("leaves a drop-out alone when Polygon has no delisting record", async () => {
    const { mark, writes } = harness({ delisted: {} });
    const live = many(100);
    expect(await mark([...live, "BLIP"], live)).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("marks nothing when the pull came back short", async () => {
    // 1,000 active last run, 900 this run: a partial pull, not 100 delistings.
    const { mark, writes, polygon } = harness({ delisted: Object.fromEntries(many(1000).map((t) => [t, "2026-10-01"])) });
    expect(await mark(many(1000), many(900))).toEqual([]);
    expect(writes).toEqual([]);
    expect(polygon.getDelisting).not.toHaveBeenCalled();
  });

  it("marks nothing when implausibly many symbols dropped at once", async () => {
    const prev = [...many(10_000), ...many(250, "X")];
    const { mark, writes } = harness({ delisted: Object.fromEntries(many(250, "X").map((t) => [t, "2026-10-01"])) });
    expect(await mark(prev, many(10_000))).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("clears a backlog larger than the cap: those symbols left before last run", async () => {
    // Prod when detection shipped: 13,604 active, 13,251 in the last pull, and
    // 353 stale since July. Judged as one run's drop-outs they tripped the cap
    // every day and nothing was ever marked.
    const live = many(13_251);
    const stale = [...many(352, "S"), "AACB"];
    const { mark, writes } = harness({
      delisted: Object.fromEntries(stale.map((t) => [t, "2026-08-20"])),
    });
    const out = await mark(live, live, stale);

    expect(out).toHaveLength(353);
    expect(out).toContain("AACB");
    expect(writes.filter((w) => w.path.startsWith("companies/") && w.data?.delisted === true)).toHaveLength(353);
  });

  it("still refuses a short pull even with a backlog present", async () => {
    const stale = many(10, "S");
    const { mark, writes, polygon } = harness({
      delisted: Object.fromEntries(stale.map((t) => [t, "2026-08-20"])),
    });
    expect(await mark(many(1000), many(900), stale)).toEqual([]);
    expect(writes).toEqual([]);
    expect(polygon.getDelisting).not.toHaveBeenCalled();
  });

  it("checks a bounded slice of the backlog per run, oldest first", async () => {
    const live = many(1000);
    const stale = many(600, "S"); // S0 oldest … S599 newest
    const { mark, polygon } = harness({
      delisted: Object.fromEntries(stale.map((t) => [t, "2026-08-20"])),
    });
    const out = await mark(live, live, stale);

    expect(out).toHaveLength(500);
    expect(out).toContain("S0");
    expect(out).not.toContain("S599");
    expect(polygon.getDelisting).toHaveBeenCalledTimes(500);
  });

  it("commits marks in batches under Firestore's 500-write cap", async () => {
    const live = many(1000);
    const stale = many(450, "S");
    const commits: number[] = [];
    const { mark, writes } = harness({
      delisted: Object.fromEntries(stale.map((t) => [t, "2026-08-20"])),
      onCommit: (n) => commits.push(n),
    });
    await mark(live, live, stale);

    expect(writes).toHaveLength(900);
    expect(commits.every((n) => n <= 500)).toBe(true);
    expect(commits.reduce((a, b) => a + b, 0)).toBe(900);
  });
});

describe("TickerUniverseJob.restoreRelisted", () => {
  it("lifts the soft-delete stamp off a relisted symbol's kept companies doc", async () => {
    const { restore, writes, delisted } = harness({ delisted: {}, companies: ["AACB"] });
    await restore(["AACB", "NODOC"]);

    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("companies/AACB");
    expect(Object.keys(writes[0].data ?? {}).sort()).toEqual(["delisted", "delistedAt"]);
    expect(delisted.invalidate).toHaveBeenCalled();
  });

  it("does nothing when nothing relisted", async () => {
    const { restore, writes, delisted } = harness({ delisted: {} });
    await restore([]);
    expect(writes).toEqual([]);
    expect(delisted.invalidate).not.toHaveBeenCalled();
  });
});

describe("DelistedTickersService.filterRows", () => {
  const svc = (ids: string[]) => {
    const firebase = {
      firestore: {
        collection: () => ({
          where: () => ({ select: () => ({ get: () => Promise.resolve({ docs: ids.map((id) => ({ id })) }) }) }),
        }),
      },
    } as unknown as FirebaseAdminService;
    return new DelistedTickersService(firebase);
  };

  it("drops delisted rows by ticker or symbol and keeps market-wide rows", async () => {
    const rows = [
      { ticker: "AAPL" }, { ticker: "AACB" }, { ticker: "aacb" },
      { symbol: "WBD" }, { id: "commercial-services" },
    ];
    expect(await svc(["AACB", "WBD"]).filterRows(rows)).toEqual([
      { ticker: "AAPL" }, { id: "commercial-services" },
    ]);
  });

  it("isDelisted is case-insensitive", async () => {
    expect(await svc(["AACB"]).isDelisted("aacb")).toBe(true);
    expect(await svc(["AACB"]).isDelisted("AAPL")).toBe(false);
  });
});
