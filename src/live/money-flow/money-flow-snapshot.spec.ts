import {
  SNAPSHOT_MAX_AGE_MS,
  SNAPSHOT_SCHEMA,
  decodeSnapshot,
  encodeSnapshot,
  sessionRunning,
  snapshotUsable,
} from "./money-flow-snapshot";
import { MoneyFlowService } from "./money-flow.service";
import type { MoneyFlowBoard } from "./money-flow.calc";

// Thu 2026-11-19 10:00 ET (session running) and Sat 2026-11-21 10:00 ET (closed).
const THU_10_ET = Date.parse("2026-11-19T15:00:00Z");
const SAT_10_ET = Date.parse("2026-11-21T15:00:00Z");
const MIN = 60_000;

function board(asOfMs: number, tag = "saved"): MoneyFlowBoard {
  return {
    asOf: new Date(asOfMs).toISOString(),
    sessionDate: "2026-11-19",
    gainers: [{ t: tag }],
    losers: [],
    sectors: [],
    universe: { total: 518, priced: 518, withBars: 518 },
  } as unknown as MoneyFlowBoard;
}

describe("money-flow snapshot encoding", () => {
  it("round-trips the board through gzip+base64 and records its build time and sizes", () => {
    const b = board(THU_10_ET);
    const doc = encodeSnapshot(b);
    expect(doc.schema).toBe(SNAPSHOT_SCHEMA);
    expect(doc.builtAt).toBe(THU_10_ET);
    expect(doc.sessionDate).toBe("2026-11-19");
    expect(doc.jsonBytes).toBe(Buffer.byteLength(JSON.stringify(b)));
    expect(decodeSnapshot(doc)).toEqual(b);
  });
});

describe("snapshotUsable: never show a frozen board while the session runs", () => {
  it("knows when the session is running (weekday 09:30–16:30 ET)", () => {
    expect(sessionRunning(THU_10_ET)).toBe(true);
    expect(sessionRunning(Date.parse("2026-11-19T14:00:00Z"))).toBe(false); // 09:00 ET
    expect(sessionRunning(Date.parse("2026-11-19T21:45:00Z"))).toBe(false); // 16:45 ET
    expect(sessionRunning(SAT_10_ET)).toBe(false);
  });
  it("in the session: serves a board up to 10 minutes old, not older", () => {
    expect(snapshotUsable(THU_10_ET - 2 * MIN, THU_10_ET)).toBe(true);
    expect(snapshotUsable(THU_10_ET - SNAPSHOT_MAX_AGE_MS, THU_10_ET)).toBe(
      true,
    );
    expect(
      snapshotUsable(THU_10_ET - SNAPSHOT_MAX_AGE_MS - MIN, THU_10_ET),
    ).toBe(false);
  });
  it("outside the session: the last build stands (Friday's board on Saturday), but not past 4 days", () => {
    const friFinal = Date.parse("2026-11-20T21:20:00Z"); // Fri 16:20 ET
    expect(snapshotUsable(friFinal, SAT_10_ET)).toBe(true);
    expect(snapshotUsable(friFinal - 5 * 24 * 60 * MIN, SAT_10_ET)).toBe(false);
    expect(snapshotUsable(Number.NaN, SAT_10_ET)).toBe(false);
  });
});

function fakeFirestore(stored: Record<string, unknown> | null) {
  const set = jest.fn(() => Promise.resolve(undefined));
  const get = jest.fn(() =>
    Promise.resolve({
      exists: stored != null,
      data: () => stored,
    }),
  );
  const doc = jest.fn(() => ({ get, set }));
  const collection = jest.fn(() => ({ doc }));
  return { firebase: { firestore: { collection } }, collection, doc, get, set };
}

describe("MoneyFlowService serves the saved board instead of building while a user waits", () => {
  afterEach(() => jest.useRealTimers());

  it("returns a fresh saved board without building", async () => {
    jest.useFakeTimers({ now: THU_10_ET });
    const fs = fakeFirestore(encodeSnapshot(board(THU_10_ET - MIN)) as never);
    const svc = new MoneyFlowService(
      {} as never,
      {} as never,
      fs.firebase as never,
    );
    const build = jest.spyOn(
      svc as unknown as { build(): Promise<MoneyFlowBoard> },
      "build",
    );
    const got = await svc.get();
    expect(got.gainers[0]).toEqual({ t: "saved" });
    expect(build).not.toHaveBeenCalled();
    expect(fs.collection).toHaveBeenCalledWith("money_flow");
    expect(fs.doc).toHaveBeenCalledWith("latest");
  });

  it("serves Friday's final board on Saturday without building", async () => {
    jest.useFakeTimers({ now: SAT_10_ET });
    const fs = fakeFirestore(
      encodeSnapshot(board(Date.parse("2026-11-20T21:20:00Z"))) as never,
    );
    const svc = new MoneyFlowService(
      {} as never,
      {} as never,
      fs.firebase as never,
    );
    const build = jest.spyOn(
      svc as unknown as { build(): Promise<MoneyFlowBoard> },
      "build",
    );
    await svc.get();
    expect(build).not.toHaveBeenCalled();
  });

  it("builds (last resort) when the saved board is stale during the session", async () => {
    jest.useFakeTimers({ now: THU_10_ET });
    const fs = fakeFirestore(
      encodeSnapshot(board(THU_10_ET - 30 * MIN)) as never,
    );
    const svc = new MoneyFlowService(
      {} as never,
      {} as never,
      fs.firebase as never,
    );
    jest
      .spyOn(svc as unknown as { build(): Promise<MoneyFlowBoard> }, "build")
      .mockResolvedValue(board(THU_10_ET, "built"));
    const got = await svc.get();
    expect(got.gainers[0]).toEqual({ t: "built" });
  });

  it("builds when nothing is saved or the read fails", async () => {
    jest.useFakeTimers({ now: THU_10_ET });
    const fs = fakeFirestore(null);
    fs.get.mockRejectedValueOnce(new Error("unavailable"));
    const svc = new MoneyFlowService(
      {} as never,
      {} as never,
      fs.firebase as never,
    );
    jest
      .spyOn(svc as unknown as { build(): Promise<MoneyFlowBoard> }, "build")
      .mockResolvedValue(board(THU_10_ET, "built"));
    await expect(svc.get()).resolves.toMatchObject({
      gainers: [{ t: "built" }],
    });
  });

  it("rebuildAndSave builds and writes the snapshot document", async () => {
    jest.useFakeTimers({ now: THU_10_ET });
    const fs = fakeFirestore(null);
    const svc = new MoneyFlowService(
      {} as never,
      {} as never,
      fs.firebase as never,
    );
    jest
      .spyOn(svc as unknown as { build(): Promise<MoneyFlowBoard> }, "build")
      .mockResolvedValue(board(THU_10_ET, "built"));
    const res = await svc.rebuildAndSave();
    expect(res).toMatchObject({
      sessionDate: "2026-11-19",
      builtAt: THU_10_ET,
    });
    expect(fs.set).toHaveBeenCalledTimes(1);
    const written = (fs.set.mock.calls[0] as unknown[])[0] as { gz: string };
    expect(decodeSnapshot(written).gainers[0]).toEqual({ t: "built" });
  });
});
