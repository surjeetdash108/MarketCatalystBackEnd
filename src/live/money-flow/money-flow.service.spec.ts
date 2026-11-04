import { BOARD_TTL_MS } from "./money-flow.service";

describe("MoneyFlowService refresh cadence", () => {
  it("uses a refresh cadence of 15 seconds or less to avoid board ranking lag", () => {
    expect(BOARD_TTL_MS).toBeLessThanOrEqual(15_000);
  });
});


import { MoneyFlowService } from "./money-flow.service";

describe("MoneyFlowService bars: both feeds, reconciled per minute, grouped to 5 minutes", () => {
  const T0 = Date.parse("2026-11-03T14:30:00Z"); // 09:30 ET
  const m = (k: number, c: number, v: number) => ({ T: "X", t: T0 + k * 60_000, o: c, h: c, l: c, c, v });
  it("asks for both feeds and keeps the opening auction volume only FMP carries", async () => {
    const polygon = {
      getMinuteBarsByFeed: jest.fn(async () => ({
        polygon: [m(0, 10, 300), m(1, 10.1, 100), m(2, 10.2, 100), m(3, 10.3, 100), m(4, 10.4, 100)],
        fmp: [m(0, 10, 1_000), m(1, 10.1, 90), m(5, 10.5, 50)],
      })),
    };
    const svc = new MoneyFlowService(polygon as never, {} as never, {} as never);
    const bars: Map<string, Array<{ t: number; v: number }>> = await (svc as unknown as {
      loadBars(d: string, u: string[], now: number): Promise<Map<string, Array<{ t: number; v: number }>>>;
    }).loadBars("2026-11-03", ["X"], Date.now());
    expect(polygon.getMinuteBarsByFeed).toHaveBeenCalledWith("X", "2026-11-03", "2026-11-03");
    expect(bars.get("X")!.map((b) => [b.t, b.v])).toEqual([
      [T0, 1_000 + 100 + 100 + 100 + 100], // 09:30-09:34: auction volume from FMP, the rest Polygon's
      [T0 + 5 * 60_000, 50], // 09:35: only FMP has it yet
    ]);
  });
});
