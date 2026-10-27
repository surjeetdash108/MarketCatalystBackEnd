import * as fs from "fs";
import * as path from "path";
import { computeIndicators } from "./technical-indicators.job";

/**
 * BJRI, E2E Oct 26 (read 15:56 ET, basis = Fri Oct 23): public R2/R1/S1/S2
 * 59.72 / 58.12 / 55.25 / 53.98 from the official Oct 23 bar (Polygon open-close
 * H 58.46 L 55.59 C 56.51). The app showed 59.26 / 57.89 / 55.57 / 54.62: the
 * official CLOSE over a stored bar whose high/low were not the official ones.
 */
describe("pivot basis uses the official high/low/close of the basis session", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/pivots-bjri-oct23.json"), "utf-8"));
  const bars = fx.bars
    .filter((b: { barDate: string }) => b.barDate <= "2026-10-23")
    .map((b: { barDate: string }) => (b.barDate === "2026-10-23" ? { ...b, ...fx.stored_2026_10_23 } : b));
  const READ = new Date("2026-10-26T19:56:00Z"); // 15:56 ET Monday — Oct 23 is the last completed session
  const official = fx.official_2026_10_23;

  it("matches the public Oct 23-basis pivots", () => {
    const ind = computeIndicators(
      bars, new Map(), READ,
      new Map([["2026-10-23", official.close]]),
      new Map([["2026-10-23", { high: official.high, low: official.low, close: official.close }]]),
    )!;
    const d = ind.keyLevels.daily!;
    expect([d.r2, d.r1, d.s1, d.s2]).toEqual([59.72, 58.12, 55.25, 53.98]);
  });
});
