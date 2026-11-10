import { LandingTapeService } from "./landing-tape.service";
import type { TapeItem } from "./tape.service";

const tile = (over: Partial<TapeItem>): TapeItem => ({
  id: "SPX",
  kind: "index",
  label: "S&P 500",
  name: null,
  proxyTicker: "SPY",
  isProxy: false,
  note: null,
  source: "fmp",
  value: 7722.72,
  change: 0.73,
  pctChange: 0.73,
  open: null,
  dayHigh: null,
  dayLow: null,
  prevClose: 7666.45,
  ...over,
});

function build() {
  const polygon = { getAggsRange: jest.fn().mockResolvedValue([]) };
  const svc = new LandingTapeService(
    {} as any,
    polygon as any,
    {} as any,
    {} as any,
    {} as any,
  );
  const equityCell = (it: TapeItem | undefined, phase = "closed") =>
    (svc as any).equityCell("SPX", it, phase) as Promise<unknown>;
  return { equityCell, polygon };
}

describe("LandingTapeService fallback to the app tape (no multiplier)", () => {
  it("uses the app tape's live FMP tile as is", async () => {
    const { equityCell, polygon } = build();
    expect(await equityCell(tile({}))).toEqual({
      id: "SPX",
      value: 7722.72,
      pctChange: 0.73,
      prevClose: 7666.45,
      basis: "live",
      date: null,
    });
    expect(polygon.getAggsRange).not.toHaveBeenCalled();
  });

  it("gives up on a stale or empty FMP tile instead of rebuilding SPY × 10", async () => {
    const { equityCell, polygon } = build();
    expect(await equityCell(tile({ stale: true }))).toBeNull();
    expect(await equityCell(tile({ value: null, pctChange: null }))).toBeNull();
    expect(polygon.getAggsRange).not.toHaveBeenCalled();
  });

  it("keeps the old rebuild only for a keyless proxy tile", async () => {
    const { equityCell, polygon } = build();
    await equityCell(
      tile({ isProxy: true, value: 7696.4, pctChange: 0, prevClose: 7696.4 }),
    );
    expect(polygon.getAggsRange).toHaveBeenCalledWith(
      "SPY",
      expect.any(String),
      expect.any(String),
    );
  });
});
