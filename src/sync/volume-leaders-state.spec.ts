import { VolumeLeadersJob } from "./volume-leaders.job";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import type { FirebaseAdminService } from "../common/firebase-admin.provider";

jest.mock("../common/firestore-batch.util", () => ({
  chunkedBatchSet: jest.fn().mockResolvedValue(undefined),
}));
const stateWrites = chunkedBatchSet as jest.Mock;

/**
 * volume-leaders stores each ticker's RVOL on its state doc, the figure
 * market-movers now reads, so both boards show the same number.
 */
function harness(states: Record<string, { window: number[]; lastDate: string }>) {
  const published: Array<Record<string, unknown>> = [];
  const firestore = {
    collection: () => ({
      doc: (id: string) => ({ id, set: (d: Record<string, unknown>) => (published.push(d), Promise.resolve()) }),
    }),
    getAll: (...refs: Array<{ id: string }>) =>
      Promise.resolve(refs.map((r) => ({ id: r.id, data: () => states[r.id] }))),
  };
  const job = new VolumeLeadersJob({ firestore } as unknown as FirebaseAdminService, null as never, null as never, null as never);
  const apply = (date: string, bars: Array<{ T: string; v: number; o?: number; c?: number }>) =>
    (job as unknown as {
      applySession(d: string, b: typeof bars, o: { publish: boolean }): Promise<unknown>;
    }).applySession(date, bars, { publish: true });
  return { apply, published };
}

const written = () =>
  new Map((stateWrites.mock.calls.at(-1)![2] as Array<{ id: string; data: Record<string, unknown> }>).map((w) => [w.id, w.data]));

describe("VolumeLeadersJob state RVOL", () => {
  beforeEach(() => stateWrites.mockClear());

  it("stores rvol, volume and the prior average on every ticker's state", async () => {
    const { apply, published } = harness({
      BIG: { window: Array(20).fill(1_000_000), lastDate: "2026-10-13" },
      // Below the leaderboard's 50k average floor: not published, still stored.
      SMALL: { window: Array(20).fill(10_000), lastDate: "2026-10-13" },
    });
    await apply("2026-10-14", [{ T: "BIG", v: 3_000_000 }, { T: "SMALL", v: 40_000 }]);
    const w = written();
    expect(w.get("BIG")).toMatchObject({ rvol: 3, volume: 3_000_000, avgVolume: 1_000_000, lastDate: "2026-10-14" });
    expect(w.get("SMALL")).toMatchObject({ rvol: 4, volume: 40_000, avgVolume: 10_000 });
    const leaders = published[0].leaders as Array<{ ticker: string; rvol: number }>;
    expect(leaders.map((l) => l.ticker)).toEqual(["BIG"]);
    // Same figure on the board and on the state the movers read.
    expect(leaders[0].rvol).toBe(w.get("BIG")!.rvol);
  });

  it("stores nulls until the window has 10 prior sessions", async () => {
    const { apply } = harness({ NEW: { window: [500_000, 600_000], lastDate: "2026-10-13" } });
    await apply("2026-10-14", [{ T: "NEW", v: 900_000 }]);
    expect(written().get("NEW")).toMatchObject({ rvol: null, volume: null, avgVolume: null });
  });

  it("a re-run for the same session recomputes against the same prior window", async () => {
    const { apply } = harness({ BIG: { window: [...Array(20).fill(1_000_000), 2_000_000].slice(-20), lastDate: "2026-10-14" } });
    await apply("2026-10-14", [{ T: "BIG", v: 3_000_000 }]);
    // Prior window = the 19 entries before 14 Oct's, all 1,000,000.
    expect(written().get("BIG")).toMatchObject({ rvol: 3, avgVolume: 1_000_000 });
  });
});
