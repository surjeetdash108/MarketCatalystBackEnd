import { toWireDoc } from "./earnings-wire.service";

describe("toWireDoc", () => {
  const base = { ticker: "nvda", companyName: "NVIDIA Corporation", date: "2026-10-23", fiscalPeriod: "Q3", fiscalYear: 2026 };

  it("turns a beat into a positive earnings row with exact figures", () => {
    const d = toWireDoc({
      ...base,
      epsActual: 1.3, epsEstimate: 1.21,
      revenueActual: 57.0e9, revenueEstimate: 54.9e9,
      actualsUpdatedAt: "2026-10-23T20:05:00.000Z",
    });
    expect(d).not.toBeNull();
    expect(d!.ticker).toBe("NVDA");
    expect(d!.tag).toBe("earnings");
    expect(d!.sentiment).toBe("positive");
    expect(d!.headline).toContain("NVDA: NVIDIA Corporation reports Q3 FY2026 results — beat");
    expect(d!.headline).toContain("EPS $1.30 vs $1.21 est.");
    expect(d!.summary).toContain("revenue $57.00B vs $54.90B est.");
    expect(d!.summary).toContain("+7.4% surprise");
    expect(d!.publishedAt).toBe("2026-10-23T20:05:00.000Z");
    expect(d!.url).toBe("earnings://NVDA/2026-10-23");
    expect(d!.id).toBe("earnings_NVDA_2026-10-23");
  });

  it("flags a miss as negative and an in-band result as neutral", () => {
    expect(toWireDoc({ ...base, epsActual: 0.9, epsEstimate: 1.2 })!.sentiment).toBe("negative");
    expect(toWireDoc({ ...base, epsActual: 1.2, epsEstimate: 1.205 })!.sentiment).toBe("neutral");
  });

  it("has no verdict or sentiment when there is no estimate", () => {
    const d = toWireDoc({ ...base, epsActual: 0.42 });
    expect(d!.sentiment).toBeNull();
    expect(d!.headline).not.toMatch(/beat|miss|in line/);
    expect(d!.headline).toContain("EPS $0.42");
  });

  it("skips a row with no reported figure", () => {
    expect(toWireDoc({ ...base, epsEstimate: 1.2, revenueEstimate: 5e9 })).toBeNull();
    expect(toWireDoc({ ...base, ticker: "", epsActual: 1 })).toBeNull();
  });

  it("falls back to updatedAt, then to the report date, for the timestamp", () => {
    expect(toWireDoc({ ...base, epsActual: 1, updatedAt: "2026-10-24T01:00:00.000Z" })!.publishedAt).toBe("2026-10-24T01:00:00.000Z");
    expect(toWireDoc({ ...base, epsActual: 1 })!.publishedAt).toBe("2026-10-23T21:00:00.000Z");
  });

  it("formats a loss per share as a negative figure", () => {
    expect(toWireDoc({ ...base, epsActual: -0.12, epsEstimate: -0.2 })!.headline).toContain("EPS -$0.12 vs -$0.20 est.");
  });
});
