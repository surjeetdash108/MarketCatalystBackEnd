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
}) {
  const writes: Write[] = [];
  const db = {
    collection: (c: string) => ({ doc: (id: string) => ({ path: `${c}/${id}` }) }),
    batch: () => ({
      set: (ref: { path: string }, data: Record<string, unknown>) =>
        writes.push({ op: "set", path: ref.path, data }),
      delete: (ref: { path: string }) => writes.push({ op: "delete", path: ref.path }),
      commit: () => Promise.resolve(),
    }),
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
  const mark = (prev: string[], fetched: string[]) =>
    (job as unknown as {
      markDelisted(p: string[], f: Set<string>): Promise<string[]>;
    }).markDelisted(prev, new Set(fetched));
  return { mark, writes, polygon, delisted };
}

const many = (n: number, prefix = "T") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("TickerUniverseJob.markDelisted", () => {
  it("marks a confirmed drop-out inactive and removes it from companies", async () => {
    const { mark, writes, delisted } = harness({ delisted: { AACB: "2026-08-20" } });
    const live = many(100);
    const out = await mark([...live, "AACB"], live);

    expect(out).toEqual(["AACB"]);
    expect(writes).toEqual([
      { op: "set", path: "tickers/AACB", data: expect.objectContaining({ active: false, delistedAt: "2026-08-20" }) },
      { op: "delete", path: "companies/AACB" },
    ]);
    expect(delisted.invalidate).toHaveBeenCalled();
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
