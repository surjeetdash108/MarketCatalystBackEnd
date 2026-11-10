import { MarketMoversJob } from "./market-movers.job";
import type { FirebaseAdminService } from "../common/firebase-admin.provider";

/**
 * Movers take RVOL from volume-leaders' per-ticker state, and only when that
 * state is for the latest session volume-leaders processed — never an old
 * ratio (137 of 200 movers on 14 Oct were reading RVOL from 1 Sep bars).
 */
function harness(latest: string | null, states: Record<string, Record<string, unknown>>) {
  const doc = (col: string, id: string) => ({ col, id });
  const firestore = {
    collection: (col: string) => ({
      doc: (id: string) => ({
        ...doc(col, id),
        get: () => Promise.resolve({ data: () => (col === "volume_leaders" && latest ? { date: latest } : undefined) }),
      }),
    }),
    getAll: (...refs: Array<{ id: string }>) =>
      Promise.resolve(refs.map((r) => ({ id: r.id, data: () => states[r.id] }))),
  };
  const job = new MarketMoversJob(
    null as never, null as never, { firestore } as unknown as FirebaseAdminService, null as never, null as never,
  );
  return (tickers: string[]) =>
    (job as unknown as { loadRvols(t: string[]): Promise<Map<string, number | null>> }).loadRvols(tickers);
}

describe("MarketMoversJob.loadRvols", () => {
  it("uses the stored RVOL stamped with the latest session", async () => {
    const load = harness("2026-10-14", {
      UNH: { lastDate: "2026-10-14", rvol: 1.41 },
      AEHL: { lastDate: "2026-10-14", rvol: 15.58 },
    });
    const out = await load(["UNH", "AEHL"]);
    expect(out.get("UNH")).toBe(1.41);
    expect(out.get("AEHL")).toBe(15.58);
  });

  it("gives null for a stale state instead of an old ratio", async () => {
    const load = harness("2026-10-14", { CRDU: { lastDate: "2026-09-01", rvol: 4.09 } });
    expect((await load(["CRDU"])).get("CRDU")).toBeNull();
  });

  it("gives null when there is no state or no ratio yet", async () => {
    const load = harness("2026-10-14", { NEWCO: { lastDate: "2026-10-14", rvol: null } });
    const out = await load(["NEWCO", "MISSING"]);
    expect(out.get("NEWCO")).toBeNull();
    expect(out.get("MISSING")).toBeNull();
  });

  it("gives null for everything before volume-leaders has ever run", async () => {
    const load = harness(null, { UNH: { lastDate: "2026-10-14", rvol: 1.41 } });
    expect((await load(["UNH"])).get("UNH")).toBeNull();
  });
});
