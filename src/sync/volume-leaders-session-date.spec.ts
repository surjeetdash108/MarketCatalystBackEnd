import { VolumeLeadersJob } from "./volume-leaders.job";
import type { FirebaseAdminService } from "../common/firebase-admin.provider";

/**
 * The job fires at 20:30 ET, which is 00:30 UTC the next day. It named its
 * candidate sessions from the UTC date, so it asked for a session that had not
 * happened, took Polygon's 18 symbols as the day, and published an empty
 * leaderboard. Candidates must follow the New York date.
 */
function harness() {
  const getLatestGroupedDaily = jest.fn().mockResolvedValue({
    date: "2026-10-22",
    bars: [{ T: "AAA", v: 1 }],
  });
  const firestore = {
    collection: () => ({ doc: () => ({ get: () => Promise.resolve({ exists: true }) }) }),
  };
  const meta = { record: jest.fn().mockResolvedValue(undefined) };
  const job = new VolumeLeadersJob(
    { firestore } as unknown as FirebaseAdminService,
    meta as never,
    null as never,
    { getLatestGroupedDaily } as never,
  );
  jest
    .spyOn(job as unknown as { applySession: () => Promise<unknown> }, "applySession")
    .mockResolvedValue({ universe: 1, ranked: 0, published: 0 });
  return { job, getLatestGroupedDaily };
}

describe("VolumeLeadersJob session date", () => {
  afterEach(() => jest.useRealTimers());

  it("names the New York date, not tomorrow's UTC date, at the 20:30 ET run", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-23T00:30:17Z")); // Thu 22 Oct, 20:30 EDT
    const { job, getLatestGroupedDaily } = harness();
    await job.run();
    const [candidates, minBars] = getLatestGroupedDaily.mock.calls[0];
    expect(candidates[0]).toBe("2026-10-22");
    expect(candidates).not.toContain("2026-10-23");
    // A day with a handful of prints is not a session.
    expect(minBars).toBeGreaterThanOrEqual(1000);
  });

  it("holds across the winter (EST) offset too", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-12-04T01:30:00Z")); // Thu 3 Dec, 20:30 EST
    const { job, getLatestGroupedDaily } = harness();
    await job.run();
    expect(getLatestGroupedDaily.mock.calls[0][0][0]).toBe("2026-12-03");
  });
});
