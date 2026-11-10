import { AnalystFirmStatsJob, firmKey } from "./analyst-firm-stats.job";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-20T15:00:00Z");

/** Daily bars from `from` up to NOW, at ET midnight like the FMP adapter; close via `closeAt`. */
function bars(from: string, closeAt: (day: string) => number, highAt?: (day: string) => number) {
  const out: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> = [];
  for (let ms = Date.parse(`${from}T04:00:00Z`); ms < NOW; ms += DAY) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const c = closeAt(day);
    out.push({ t: ms, o: c, h: highAt?.(day) ?? c, l: c, c, v: 1 });
  }
  return out;
}

function make(grades: unknown[], targets: unknown[], aggs: unknown[]) {
  const fmp = {
    request: jest.fn(async (path: string) => (path.startsWith("grades") ? grades : path.includes("page=0") ? targets : [])),
  };
  const polygon = { getAggsRange: jest.fn().mockResolvedValue(aggs) };
  const job = new AnalystFirmStatsJob({} as never, { register: jest.fn() } as never, {} as never, fmp as never, polygon as never);
  return { job, fmp, polygon };
}

describe("AnalystFirmStatsJob.measureTicker", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
  afterEach(() => jest.useRealTimers());

  it("signs the 5-session move by direction, from the close BEFORE the call", async () => {
    // Close 100 through 2026-06-09, then 110 from the call day on.
    const { job } = make(
      [
        { date: "2026-06-10", gradingCompany: "Jefferies", action: "upgrade", newGrade: "Buy" },
        { date: "2026-06-10", gradingCompany: "UBS", action: "downgrade", newGrade: "Neutral" },
        { date: "2026-06-10", gradingCompany: "Citi", action: "maintain", newGrade: "Buy" },
        { date: "2020-01-01", gradingCompany: "Old Firm", action: "upgrade", newGrade: "Buy" }, // > 3y old
      ],
      [],
      bars("2026-05-01", (d) => (d < "2026-06-10" ? 100 : 110)),
    );
    const out = (await job.measureTicker("AAPL")) as { ratingCalls: Array<Record<string, unknown>>; gradeStances: unknown[] };
    expect(out.ratingCalls).toEqual([
      expect.objectContaining({ firm: "Jefferies", dir: 1, move: 10, bullish: true }),
      expect.objectContaining({ firm: "UBS", dir: -1, move: -10, bullish: false }),
    ]);
    expect(out.gradeStances).toHaveLength(3); // the 2020 grade is outside the window
  });

  it("scores only CLOSED target windows, by high for upside targets", async () => {
    const { job } = make(
      [],
      [
        { analystCompany: "Morgan Stanley", publishedDate: "2025-01-15T12:00:00Z", priceTarget: 150, priceWhenPosted: 100 },
        { analystCompany: "Goldman Sachs", publishedDate: "2025-01-15T12:00:00Z", priceTarget: 200, priceWhenPosted: 100 },
        { analystCompany: "Barclays", publishedDate: "2026-03-01T12:00:00Z", priceTarget: 120, priceWhenPosted: 100 }, // window open
        { analystCompany: "Bad Row", publishedDate: "2025-01-15", priceTarget: 0, priceWhenPosted: 100 },
      ],
      bars("2025-01-01", () => 100, (d) => (d === "2025-09-01" ? 160 : 100)),
    );
    const out = (await job.measureTicker("AAPL")) as { targetCalls: Array<Record<string, unknown>> };
    expect(out.targetCalls.map((t) => [t.firm, t.hit])).toEqual([["Morgan Stanley", true], ["Goldman Sachs", false]]);
  });

  it("returns null when FMP has no history for the ticker", async () => {
    const { job, polygon } = make([], [], []);
    await expect(job.measureTicker("ZZZZ")).resolves.toBeNull();
    expect(polygon.getAggsRange).not.toHaveBeenCalled();
  });
});

describe("firmKey", () => {
  it("normalises firm names so variants pool together", () => {
    expect(firmKey("Morgan Stanley")).toBe(firmKey("morgan  stanley"));
    expect(firmKey("Stifel, Nicolaus & Co.")).toBe("stifelnicolausandco");
  });
});
