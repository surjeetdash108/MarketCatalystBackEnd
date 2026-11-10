import {
  buildFacts,
  changeCell,
  epsVerdict,
  etIso,
  etTime,
  formatEps,
  formatMoney,
  gapText,
  moneyDecimals,
  overallVerdict,
  pickReaction,
  quarterLabel,
  revenueVerdict,
  shortCompanyName,
  type ArticleFacts,
  type FactsInput,
  type StatementRow,
} from "./earnings-article.facts";

// Public FMP rows as of Nov. 4, 2026.
const FIG_HISTORY = [
  { date: "2026-11-04", epsActual: 0.1, epsEstimated: 0.05422, revenueActual: 391415000, revenueEstimated: 376531900 },
  { date: "2026-08-05", epsActual: 0.08, epsEstimated: 0.04103, revenueActual: 370083000, revenueEstimated: 351555600 },
  { date: "2026-05-14", epsActual: 0.1, epsEstimated: 0.06333, revenueActual: 333439000, revenueEstimated: 316018600 },
  { date: "2026-02-18", epsActual: 0.08, epsEstimated: 0.07, revenueActual: 303776000, revenueEstimated: 293124000 },
  { date: "2025-11-05", epsActual: 0.1, epsEstimated: 0.04556, revenueActual: 274173000, revenueEstimated: 263936500 },
  { date: "2025-07-28", epsActual: 0.18, epsEstimated: 0.0809, revenueActual: 228199000, revenueEstimated: 248622100 },
];
const FIG_STATEMENTS: StatementRow[] = [
  { date: "2026-09-30", period: "Q3", fiscalYear: "2026", filingDate: "2026-11-04", reportedCurrency: "USD", revenue: 391415000, grossProfit: 314440000, operatingIncome: -119165000, netIncome: -81348000, epsDiluted: -0.15 },
  { date: "2026-06-30", period: "Q2", fiscalYear: "2026", filingDate: "2026-08-05", reportedCurrency: "USD", revenue: 370083000, grossProfit: 309611000, operatingIncome: -117289000, netIncome: -112152000, epsDiluted: -0.21 },
  { date: "2025-09-30", period: "Q3", fiscalYear: "2025", filingDate: "2025-11-05", reportedCurrency: "USD", revenue: 274173000, grossProfit: 190289000, operatingIncome: -1136780000, netIncome: -1097015000, epsDiluted: -2.23 },
];
const FIG_ESTIMATES = [
  { date: "2027-03-30", epsAvg: 0.10139, revenueAvg: 415279593, numAnalystsEps: 4, numAnalystsRevenue: 9 },
  { date: "2026-12-30", epsAvg: 0.052623, revenueAvg: 390601186, numAnalystsEps: 11, numAnalystsRevenue: 10 },
  { date: "2026-09-30", epsAvg: 0.054223, revenueAvg: 376531924, numAnalystsEps: 11, numAnalystsRevenue: 10 },
];

const CVS_HISTORY = [
  { date: "2027-02-09", epsActual: null, epsEstimated: 1.26, revenueActual: null, revenueEstimated: 106893100000 },
  { date: "2026-11-04", epsActual: 2.09, epsEstimated: 1.65, revenueActual: 108399000000, revenueEstimated: 104690400000 },
  { date: "2026-08-05", epsActual: 2.58, epsEstimated: 1.85, revenueActual: 106096000000, revenueEstimated: 100028300000 },
  { date: "2026-05-06", epsActual: 2.57, epsEstimated: 2.18, revenueActual: 100426000000, revenueEstimated: 94994100000 },
  { date: "2026-02-10", epsActual: 1.09, epsEstimated: 1, revenueActual: 105693000000, revenueEstimated: 103698100000 },
  { date: "2025-10-29", epsActual: 1.6, epsEstimated: 1.37, revenueActual: 102871000000, revenueEstimated: 98813111304 },
  { date: "2025-07-31", epsActual: 1.81, epsEstimated: 1.46, revenueActual: 98915000000, revenueEstimated: 94532680058 },
  { date: "2025-05-01", epsActual: 2.25, epsEstimated: 1.7, revenueActual: 94588000000, revenueEstimated: 93678681216 },
  { date: "2025-02-12", epsActual: 1.19, epsEstimated: 0.914, revenueActual: 97710000000, revenueEstimated: 97092668956 },
];
const CVS_STATEMENTS: StatementRow[] = [
  { date: "2026-09-30", period: "Q3", fiscalYear: "2026", filingDate: "2026-11-04", reportedCurrency: "USD", revenue: 108399000000, grossProfit: 14898000000, operatingIncome: 3566000000, netIncome: 2172000000, epsDiluted: 1.68 },
  { date: "2026-06-30", period: "Q2", fiscalYear: "2026", filingDate: "2026-08-05", reportedCurrency: "USD", revenue: 106096000000, epsDiluted: 2.31 },
  { date: "2025-09-30", period: "Q3", fiscalYear: "2025", filingDate: "2025-10-29", reportedCurrency: "USD", revenue: 102871000000, netIncome: -3975000000, epsDiluted: -3.13 },
];

function figInput(over: Partial<FactsInput> = {}): FactsInput {
  return {
    company: { symbol: "FIG", name: "Figma, Inc." },
    report: FIG_HISTORY[0],
    history: FIG_HISTORY,
    statements: FIG_STATEMENTS,
    estimates: FIG_ESTIMATES,
    reaction: null,
    ...over,
  };
}

const facts = (input: FactsInput): ArticleFacts => {
  const f = buildFacts(input);
  if ("skip" in f) throw new Error(`skipped: ${f.skip}`);
  return f;
};

describe("beat / miss bands (skill §3)", () => {
  it("EPS: a cent either way decides, after rounding", () => {
    expect(epsVerdict(0.1, 0.05422)).toBe("beat");
    expect(epsVerdict(1.654, 1.65)).toBe("inline");
    expect(epsVerdict(1.63, 1.65)).toBe("miss");
    // Less negative than expected is a beat.
    expect(epsVerdict(-0.1, -0.2)).toBe("beat");
  });

  it("revenue: 0.25% either way decides", () => {
    expect(revenueVerdict(100.3, 100)).toBe("beat");
    expect(revenueVerdict(100.2, 100)).toBe("inline");
    expect(revenueVerdict(99.7, 100)).toBe("miss");
  });

  it("measures the gap against the unrounded estimate", () => {
    // $0.10 vs $0.05422 is an 84% beat — not the 100% a rounded $0.05 gives.
    expect(gapText("eps", 0.1, 0.05422)).toBe("Beat by 84%");
    expect(gapText("revenue", 391415000, 376531900)).toBe("Beat by 4.0%");
    expect(gapText("revenue", 99.7, 100)).toBe("Miss by 0.3%");
    expect(gapText("eps", 1.65, 1.65)).toBe("In line");
  });

  it("states a near-zero EPS estimate's gap in cents", () => {
    expect(gapText("eps", 0.05, 0.001)).toBe("Beat by $0.05");
  });

  it("missing estimate gives no verdict, never 'In line'", () => {
    expect(epsVerdict(2.09, null)).toBe("none");
    expect(gapText("eps", 2.09, null)).toBeNull();
    expect(overallVerdict("none", "none")).toBe("none");
    expect(overallVerdict("beat", "none")).toBe("beat");
  });

  it("one beat and one miss is mixed", () => {
    expect(overallVerdict("beat", "miss")).toBe("mixed");
    expect(overallVerdict("miss", "inline")).toBe("miss");
  });
});

describe("formats (skill §6)", () => {
  it("money and EPS", () => {
    expect(formatMoney(108399000000)).toBe("$108.4B");
    expect(formatMoney(1899000000)).toBe("$1.90B");
    expect(formatMoney(391415000)).toBe("$391.4M");
    expect(formatEps(-0.15)).toBe("-$0.15");
  });

  it("adds a decimal only when actual and estimate would print alike", () => {
    // $1.89B vs $1.89B at two decimals; three show the beat.
    expect(moneyDecimals(1894900000, 1890100000)).toBe(3);
    expect(moneyDecimals(1899000000, 1890000000)).toBeUndefined();
    expect(moneyDecimals(391415000, 376531900)).toBeUndefined();
  });

  it("change cells: arrows, unchanged, and sign flips without a percent", () => {
    expect(changeCell(391415000, 274173000, formatMoney)).toEqual({ text: "&#9650; 43%", cls: "pos" });
    expect(changeCell(0.1, 0.1, formatEps)).toEqual({ text: "Unchanged", cls: "" });
    expect(changeCell(0.1, -0.05, formatEps)).toEqual({ text: "&#9650; from -$0.05", cls: "pos" });
    expect(changeCell(1, null, formatEps)).toBeNull();
  });

  it("Eastern times and ISO offsets", () => {
    const ms = Date.parse("2026-11-04T21:40:27Z");
    expect(etTime(ms)).toBe("4:40 p.m. ET");
    expect(etIso(ms)).toBe("2026-11-04T16:40:27-05:00");
    expect(etIso(Date.parse("2026-07-01T14:00:00Z"))).toBe("2026-07-01T10:00:00-04:00");
  });

  it("short names", () => {
    expect(shortCompanyName("Figma, Inc.")).toBe("Figma");
    expect(shortCompanyName("CVS Health Corporation")).toBe("CVS Health");
    expect(shortCompanyName("The Walt Disney Company")).toBe("Walt Disney");
  });
});

describe("quarter label", () => {
  it("uses this quarter's statement when it was filed with the release", () => {
    expect(quarterLabel("2026-11-04", FIG_STATEMENTS)?.quarter).toBe("Q3 2026");
  });

  it("steps the previous quarter forward when this one is not filed yet", () => {
    const l = quarterLabel("2026-11-04", FIG_STATEMENTS.slice(1));
    expect(l?.quarter).toBe("Q3 2026");
    expect(l?.current).toBeNull();
  });

  it("rolls Q4 into Q1 of the next fiscal year and marks non-calendar years", () => {
    // A September fiscal year end: its Q4 ends late September.
    const l = quarterLabel("2027-01-29", [
      { date: "2026-09-26", period: "Q4", fiscalYear: "2026", filingDate: "2026-10-30" },
    ]);
    expect(l?.quarter).toBe("fiscal Q1 2027");
    expect(l?.words).toBe("fiscal first-quarter 2027");
  });
});

describe("buildFacts", () => {
  it("Figma Q3 2026: YoY and QoQ from FMP history, on one basis", () => {
    const f = facts(figInput());
    expect(f.quarter).toBe("Q3 2026");
    expect(f.overall).toBe("beat");
    expect(f.eps.gapText).toBe("Beat by 84%");
    expect(f.revenue.prior).toBe(370083000);
    expect(f.revenue.yearAgo).toBe(274173000);
    expect(f.revenue.yoyPct!.toFixed(1)).toBe("42.8");
    expect(f.revenue.qoqPct!.toFixed(1)).toBe("5.8");
    expect(f.eps.yoyPct).toBe(0);
    expect(f.eps.qoqPct!.toFixed(0)).toBe("25");
    expect(f.hasQoq && f.hasYoy).toBe(true);
  });

  it("Figma: GAAP loss from the filed statement, next-quarter consensus", () => {
    const f = facts(figInput());
    expect(f.gaap?.current.epsDiluted).toBe(-0.15);
    expect(f.gaap?.yearAgo?.date).toBe("2025-09-30");
    expect(f.next?.revenueAvg).toBe(390601186);
    expect(f.next?.analysts).toBe(11);
  });

  it("CVS Q3 2026: record, trend and next report date", () => {
    const f = facts({
      company: { symbol: "CVS", name: "CVS Health Corporation" },
      report: CVS_HISTORY[1],
      history: CVS_HISTORY,
      statements: CVS_STATEMENTS,
      estimates: [],
      reaction: null,
    });
    expect(f.eps.yoyPct!.toFixed(1)).toBe("30.6");
    expect(f.eps.qoqPct!.toFixed(1)).toBe("-19.0");
    expect(f.revenue.yoyPct!.toFixed(1)).toBe("5.4");
    expect(f.record).toEqual({ epsBeats: 8, epsOf: 8, revBeats: 8, revOf: 8 });
    expect(f.revenueTrend).toEqual([102871000000, 105693000000, 100426000000, 106096000000, 108399000000]);
    expect(f.next?.reportDate).toBe("2027-02-09");
  });

  it("drops a comparison whose row is not where that quarter should be", () => {
    // Without the 2026-02-18 report, index 4 is a quarter too old for year-ago.
    const history = FIG_HISTORY.filter((r) => r.date !== "2026-02-18");
    const f = facts(figInput({ history }));
    expect(f.revenue.yearAgo).toBeNull();
    expect(f.hasYoy).toBe(false);
    expect(f.hasQoq).toBe(true);
  });

  it("does not print a statement FMP has only partly filled", () => {
    // U-Haul's fresh Q2 FY27 statement: net income 0 while EPS is 0.71.
    const statements = [{ ...FIG_STATEMENTS[0], netIncome: 0 }, ...FIG_STATEMENTS.slice(1)];
    const f = facts(figInput({ statements }));
    expect(f.gaap).toBeNull();
    expect(f.quarter).toBe("Q3 2026");
  });

  it("names EPS plainly when FMP's actual is the GAAP figure", () => {
    // GRAIL: EPS actual -2.21 equals GAAP diluted EPS -2.21.
    const statements = [{ ...FIG_STATEMENTS[0], epsDiluted: 0.1, netIncome: 50_000_000 }, ...FIG_STATEMENTS.slice(1)];
    expect(facts(figInput({ statements })).epsBasis).toBe("gaap");
    expect(facts(figInput()).epsBasis).toBe("adjusted");
  });

  it("drops a share-class suffix from the issuer name", () => {
    const f = facts(figInput({ company: { symbol: "PTRN", name: "Pattern Group Inc. Series A Common Stock" } }));
    expect(f.company).toBe("Pattern Group Inc.");
    expect(f.shortName).toBe("Pattern");
  });

  it("skips reporters in another currency", () => {
    const statements = FIG_STATEMENTS.map((s) => ({ ...s, reportedCurrency: "TWD" }));
    expect(buildFacts(figInput({ statements }))).toEqual({ skip: "non-usd" });
  });

  it("skips without both actuals", () => {
    expect(buildFacts(figInput({ report: { ...FIG_HISTORY[0], revenueActual: null } }))).toEqual({ skip: "no-actuals" });
  });

  it("keeps a missing estimate missing", () => {
    const f = facts(figInput({ report: { ...FIG_HISTORY[0], epsEstimated: null } }));
    expect(f.eps.estimate).toBeNull();
    expect(f.eps.verdict).toBe("none");
    expect(f.overall).toBe("beat");
  });
});

describe("pickReaction", () => {
  const quote = { price: 22.13, changePercentage: 5.23, timestamp: Date.parse("2026-11-04T21:00:02Z") / 1000 };

  it("after hours: latest trade against the regular close", () => {
    const now = Date.parse("2026-11-04T21:45:00Z");
    const r = pickReaction(quote, { price: 20.59, at: Date.parse("2026-11-04T21:40:27Z") }, now);
    expect(r?.session).toBe("after-hours");
    expect(r?.pct.toFixed(1)).toBe("-7.0");
  });

  it("premarket before 9:30", () => {
    const now = Date.parse("2026-11-05T13:20:00Z"); // 8:20 a.m. ET
    const r = pickReaction(quote, { price: 23, at: now - 60_000 }, now);
    expect(r?.session).toBe("premarket");
  });

  it("no reaction from a stale extended-hours print", () => {
    const now = Date.parse("2026-11-04T23:45:00Z");
    expect(pickReaction(quote, { price: 20.59, at: Date.parse("2026-11-04T21:40:27Z") }, now)).toBeNull();
  });

  it("regular session uses the quote", () => {
    const now = Date.parse("2026-11-04T15:00:00Z"); // 10:00 a.m. ET
    const r = pickReaction({ ...quote, timestamp: now / 1000 - 30 }, null, now);
    expect(r?.session).toBe("regular");
    expect(r?.pct).toBe(5.23);
  });
});
