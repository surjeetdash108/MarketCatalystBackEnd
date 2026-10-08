import {
  selectGrades,
  normaliseGradeAction,
  headlineTarget,
  headlineNamesFirm,
  resolveFirmTarget,
  headlinePreviousTarget,
  toCurrentShareBasis,
  alignPreviousToSplits,
  FmpAnalystRatingsAdapter,
} from "./analyst-ratings.adapter";
import type { FmpService } from "../vendors/fmp/fmp.service";

const row = (date: string, action: string) => ({ date, action });

describe("selectGrades", () => {
  it("keeps an initiation that sits behind a wall of maintains", () => {
    // The real prod failure: 8-row truncation meant the Initiations tab
    // matched zero rows across 460 tickers.
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => row(`2026-08-${30 - i}`, "maintain")),
      row("2026-05-01", "initialise"),
    ];
    const out = selectGrades(rows);
    expect(out.some(r => /init/i.test(r.action))).toBe(true);
  });

  it("caps the total rows kept", () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(`2026-01-${(i % 28) + 1}`, "maintain"));
    expect(selectGrades(rows).length).toBeLessThanOrEqual(20);
  });

  it("keeps upgrades and downgrades ahead of maintains", () => {
    const rows = [
      ...Array.from({ length: 25 }, (_, i) => row(`2026-08-${25 - i}`, "maintain")),
      row("2026-02-10", "upgrade"),
      row("2026-01-10", "downgrade"),
    ];
    const out = selectGrades(rows);
    expect(out.some(r => r.action === "upgrade")).toBe(true);
    expect(out.some(r => r.action === "downgrade")).toBe(true);
  });

  it("returns newest-first", () => {
    const out = selectGrades([row("2026-01-01", "upgrade"), row("2026-06-01", "maintain")]);
    expect(out[0].date).toBe("2026-06-01");
  });

  it("treats an unknown future action as an event, not a maintain", () => {
    const rows = [
      ...Array.from({ length: 25 }, (_, i) => row(`2026-08-${25 - i}`, "maintain")),
      row("2026-01-05", "resume coverage"),
    ];
    expect(selectGrades(rows).some(r => r.action === "resume coverage")).toBe(true);
  });

  it("handles empty input and null actions", () => {
    expect(selectGrades([])).toEqual([]);
    const out = selectGrades([{ date: "2026-01-01", action: null }]);
    expect(out).toHaveLength(1);
  });
});

describe("normaliseGradeAction", () => {
  it("labels an empty previousGrade with a real newGrade as an initiation", () => {
    // Real row: META / Exane BNP Paribas, "" -> "Outperform", action "".
    expect(normaliseGradeAction("", null, "Outperform")).toBe("initiate");
    expect(normaliseGradeAction("", "", "Outperform")).toBe("initiate");
  });
  it("leaves genuine actions untouched", () => {
    expect(normaliseGradeAction("upgrade", "Hold", "Buy")).toBe("upgrade");
    expect(normaliseGradeAction("maintain", "Buy", "Buy")).toBe("maintain");
  });
  it("does not invent an initiation when a previous grade exists", () => {
    expect(normaliseGradeAction("", "Hold", "Buy")).toBeNull();
  });
  it("nulls a blank action rather than storing an empty string", () => {
    expect(normaliseGradeAction("", "Hold", "")).toBeNull();
  });
});

describe("headlineTarget", () => {
  it("takes the figure the target moved TO, not FROM", () => {
    expect(headlineTarget("Amazon.com price target raised to $350 from $340 at TD Cowen")).toBe(350);
    expect(headlineTarget("BNY Mellon price target raised to $167 from $136 at Citi")).toBe(167);
    expect(headlineTarget("Beta Technologies (BETA) PT Lowered to $38 at Cantor Fitzgerald as 'Conservative on NT Ramp Up'")).toBe(38);
  });
  it("reads 'of $X' and '$X price target' phrasings, with thousands separators", () => {
    expect(headlineTarget("Goldman starts XYZ at Buy with price target of $45.50")).toBe(45.5);
    expect(headlineTarget("Booking initiated with $5,800 price target at Mizuho")).toBe(5800);
  });
  it("returns null when no figure, or when several targets are quoted", () => {
    expect(headlineTarget("Ametek Inc. (AME) PT Raised at RBC Capital Following 'High Quality 2Q26 Beat & Raise'")).toBeNull();
    expect(headlineTarget("Braze (BRZE) Reiterated at Market Outperform by Citizens")).toBeNull();
    expect(headlineTarget("XYZ target raised to $50 at UBS; Jefferies lifts target to $60")).toBeNull();
  });
});

describe("headlineNamesFirm", () => {
  it("matches spelling variants through canonicalisation", () => {
    expect(headlineNamesFirm("price target raised to $350 at TD Cowen", "cowen")).toBe(true);
    expect(headlineNamesFirm("target cut to $90 at J.P. Morgan", "jpmorgan")).toBe(true);
    expect(headlineNamesFirm("PT raised to $275 at Robert W. Baird", "baird")).toBe(true);
  });
  it("rejects a headline about a different firm than FMP tagged (BRZE Citizens tagged Citigroup)", () => {
    expect(headlineNamesFirm("Braze (BRZE) Reiterated at Market Outperform by Citizens", "citi")).toBe(false);
    expect(headlineNamesFirm("Target raised to $80 at Morgan Stanley", "jpmorgan")).toBe(false);
  });
});

describe("resolveFirmTarget", () => {
  const posts = [
    { date: "2026-02-05", priceTarget: 245 },
    { date: "2026-05-01", priceTarget: 244 },
    { date: "2026-08-05", priceTarget: 275 },
  ];
  it("carries the standing target forward onto a later reiteration (AME/Baird, 61 days)", () => {
    expect(resolveFirmTarget(posts, "2026-10-05", "maintain")).toEqual({
      priceTarget: 275,
      date: "2026-08-05",
      previousPriceTarget: 244,
    });
  });
  it("never pins a target the firm posted AFTER the grade", () => {
    // Old rule picked the nearest (2026-05-01, a month later); the standing one is Feb's.
    expect(resolveFirmTarget(posts, "2026-03-30", "maintain")?.priceTarget).toBe(245);
  });
  it("accepts a post a day or two after the grade (news lag)", () => {
    expect(resolveFirmTarget([{ date: "2026-06-03", priceTarget: 10 }], "2026-06-01", "upgrade")?.priceTarget).toBe(10);
  });
  it("keeps the tight window for rating changes", () => {
    expect(resolveFirmTarget(posts, "2026-10-05", "downgrade")).toBeNull();
    expect(resolveFirmTarget(posts, "2026-09-10", "upgrade")?.priceTarget).toBe(275);
  });
  it("drops a reiteration's target once it is older than the maintain window", () => {
    expect(resolveFirmTarget(posts, "2027-03-01", "maintain")).toBeNull();
  });
  it("handles no posts and bad dates", () => {
    expect(resolveFirmTarget([], "2026-01-01", "maintain")).toBeNull();
    expect(resolveFirmTarget(posts, "not-a-date", "maintain")).toBeNull();
  });
});

describe("headlinePreviousTarget", () => {
  it("takes the figure the target moved FROM", () => {
    expect(headlinePreviousTarget("Carvana price target lowered to $80 from $93 at Barclays")).toBe(93);
    expect(headlinePreviousTarget("Carvana price target lowered to $83 from $91.50 at Stephens")).toBe(91.5);
    expect(headlinePreviousTarget("Booking price target raised to $5,800 from $5,500 at Mizuho")).toBe(5500);
  });
  it("returns null without a 'from', or when the 'from' is not on the stated target", () => {
    expect(headlinePreviousTarget("Carvana (CVNA) PT Lowered to $90 at Morgan Stanley")).toBeNull();
    expect(headlinePreviousTarget("Jefferies Reiterates Buy Rating on Carvana (CVNA)")).toBeNull();
    expect(headlinePreviousTarget("XYZ target raised to $50 from $45 at UBS; Jefferies lifts target to $60")).toBeNull();
  });
});

describe("split handling", () => {
  const splits = [{ date: "2026-05-08", ratio: 5 }];
  it("restates a pre-split target on today's share basis", () => {
    expect(toCurrentShareBasis(475, "2026-04-30", splits)).toBe(95);
    expect(toCurrentShareBasis(93, "2026-05-14", splits)).toBe(93);
    expect(toCurrentShareBasis(475, "2026-04-30", [])).toBe(475);
  });
  it("rescales a 'from' figure still quoted on the pre-split basis", () => {
    // Barclays "adjusted to $93 from $475" and Oppenheimer "to $90 from $450", both after CVNA's 5:1.
    expect(alignPreviousToSplits(475, 93, "2026-05-14", splits)).toBe(95);
    expect(alignPreviousToSplits(450, 90, "2026-09-30", splits)).toBe(90);
  });
  it("leaves a 'from' already on the post-split basis alone", () => {
    expect(alignPreviousToSplits(93, 94, "2026-07-21", splits)).toBe(93);
    expect(alignPreviousToSplits(475, 93, "2026-04-30", splits)).toBe(475); // split not yet executed
  });
});

describe("resolveFirmTarget previous target", () => {
  it("prefers the firm's stated 'from' over the feed's history (CVNA Barclays: $94 in feed, $93 stated)", () => {
    const posts = [
      { date: "2026-07-21", priceTarget: 94, previousTarget: 93 },
      { date: "2026-10-06", priceTarget: 80, previousTarget: 93 },
    ];
    expect(resolveFirmTarget(posts, "2026-10-06", "maintain")?.previousPriceTarget).toBe(93);
  });
  it("uses a stated 'from' carried by the other feed's copy of the same call", () => {
    const posts = [
      { date: "2026-10-06", priceTarget: 83, previousTarget: 91.5 },
      { date: "2026-10-07", priceTarget: 83, previousTarget: null },
    ];
    expect(resolveFirmTarget(posts, "2026-10-07", "maintain")).toEqual({
      priceTarget: 83,
      date: "2026-10-07",
      previousPriceTarget: 91.5,
    });
  });
  it("falls back to the firm's previous post, never a duplicate of the same call", () => {
    const posts = [
      { date: "2026-07-20", priceTarget: 102 },
      { date: "2026-07-29", priceTarget: 90 },
      { date: "2026-07-30", priceTarget: 90 },
    ];
    expect(resolveFirmTarget(posts, "2026-07-30", "downgrade")?.previousPriceTarget).toBe(102);
  });
  it("is null when the firm has no earlier post, or only one older than a year", () => {
    expect(resolveFirmTarget([{ date: "2026-07-30", priceTarget: 90 }], "2026-07-30", "maintain")?.previousPriceTarget).toBeNull();
    const stale = [
      { date: "2025-06-01", priceTarget: 70 },
      { date: "2026-07-30", priceTarget: 90 },
    ];
    expect(resolveFirmTarget(stale, "2026-07-30", "maintain")?.previousPriceTarget).toBeNull();
  });
});

describe("FmpAnalystRatingsAdapter per-firm targets", () => {
  const fmp = (over: Partial<Record<keyof FmpService, unknown>>) =>
    ({
      getAnalystConsensus: async () => ({ strongBuy: 1, buy: 1, hold: 0, sell: 0, strongSell: 0, consensus: "Buy" }),
      getPriceTargetConsensus: async () => null,
      getPriceTargetSummary: async () => null,
      getGrades: async () => [],
      getPriceTargets: async () => [],
      getGradeNews: async () => [],
      getSplits: async () => [],
      ...over,
    }) as unknown as FmpService;

  it("fills a firm absent from price-target-news from its grades-news headline (AMZN/TD Cowen)", async () => {
    const out = await new FmpAnalystRatingsAdapter(
      fmp({
        getGrades: async () => [
          { date: "2026-10-05", gradingCompany: "TD Cowen", previousGrade: "Buy", newGrade: "Buy", action: "maintain" },
        ],
        getGradeNews: async () => [
          { date: "2026-07-31", firm: "Cowen & Co.", title: "Amazon.com price target raised to $350 from $340 at TD Cowen" },
          { date: "2026-07-08", firm: "Cowen & Co.", title: "Amazon.com price target lowered to $340 from $350 at TD Cowen" },
        ],
      }),
    ).getConsensus("AMZN");
    expect(out?.recentGrades[0]).toMatchObject({ priceTarget: 350, priceTargetDate: "2026-07-31" });
  });

  it("ignores a mis-tagged headline instead of giving Citi another firm's number", async () => {
    const out = await new FmpAnalystRatingsAdapter(
      fmp({
        getGrades: async () => [
          { date: "2026-10-05", gradingCompany: "Citigroup", previousGrade: "Buy", newGrade: "Buy", action: "maintain" },
        ],
        getGradeNews: async () => [
          { date: "2026-09-09", firm: "Citigroup", title: "Braze price target raised to $40 by Citizens" },
        ],
      }),
    ).getConsensus("BRZE");
    expect(out?.recentGrades[0]).toMatchObject({ priceTarget: null, priceTargetDate: null });
  });
});

describe("FmpAnalystRatingsAdapter previous targets", () => {
  const fmp = (over: Partial<Record<keyof FmpService, unknown>>) =>
    ({
      getAnalystConsensus: async () => ({ strongBuy: 1, buy: 1, hold: 0, sell: 0, strongSell: 0, consensus: "Buy" }),
      getPriceTargetConsensus: async () => null,
      getPriceTargetSummary: async () => null,
      getGrades: async () => [],
      getPriceTargets: async () => [],
      getGradeNews: async () => [],
      getSplits: async () => [],
      ...over,
    }) as unknown as FmpService;

  it("stores CVNA 2026-10-06 as Benzinga shows it: Barclays $93 → $80, Stephens $91.50 → $83", async () => {
    const out = await new FmpAnalystRatingsAdapter(
      fmp({
        getGrades: async () => [
          { date: "2026-10-06", gradingCompany: "Barclays", previousGrade: "Equal Weight", newGrade: "Equal Weight", action: "maintain" },
          { date: "2026-10-06", gradingCompany: "Stephens & Co.", previousGrade: "Overweight", newGrade: "Overweight", action: "maintain" },
        ],
        getPriceTargets: async () => [
          { date: "2026-10-06", firm: "Stephens", priceTarget: 83, title: "Carvana price target lowered to $83 from $91.50 at Stephens" },
          { date: "2026-10-06", firm: "Barclays", priceTarget: 80, title: "Carvana price target lowered to $80 from $93 at Barclays" },
          { date: "2026-07-21", firm: "Barclays", priceTarget: 94, title: "Carvana price target raised to $94 from $93 at Barclays" },
          { date: "2026-05-14", firm: "Barclays", priceTarget: 93, title: "Carvana target adjusted to $93 from $475 at Barclays" },
          { date: "2026-04-30", firm: "Barclays", priceTarget: 475, title: "Carvana price target raised to $475 from $430 at Barclays" },
        ],
        getSplits: async () => [{ date: "2026-05-08", ratio: 5 }],
      }),
    ).getConsensus("CVNA");
    expect(out?.recentGrades).toEqual([
      expect.objectContaining({ firm: "Barclays", priceTarget: 80, previousPriceTarget: 93 }),
      expect.objectContaining({ firm: "Stephens & Co.", priceTarget: 83, previousPriceTarget: 91.5 }),
    ]);
  });

  it("restates a pre-split standing target and its predecessor on the current basis", async () => {
    const out = await new FmpAnalystRatingsAdapter(
      fmp({
        getGrades: async () => [
          { date: "2026-06-01", gradingCompany: "Barclays", previousGrade: "Overweight", newGrade: "Overweight", action: "maintain" },
        ],
        getPriceTargets: async () => [
          { date: "2026-04-30", firm: "Barclays", priceTarget: 475, title: "Carvana price target raised to $475 from $430 at Barclays" },
        ],
        getSplits: async () => [{ date: "2026-05-08", ratio: 5 }],
      }),
    ).getConsensus("CVNA");
    expect(out?.recentGrades[0]).toMatchObject({ priceTarget: 95, previousPriceTarget: 86, priceTargetDate: "2026-04-30" });
  });

  it("ignores a price-target-news 'from' whose headline is about a different figure", async () => {
    const out = await new FmpAnalystRatingsAdapter(
      fmp({
        getGrades: async () => [
          { date: "2026-10-06", gradingCompany: "UBS", previousGrade: "Buy", newGrade: "Buy", action: "maintain" },
        ],
        getPriceTargets: async () => [
          { date: "2026-10-06", firm: "UBS", priceTarget: 83, title: "Carvana price target lowered to $85 from $104 at UBS" },
        ],
      }),
    ).getConsensus("CVNA");
    expect(out?.recentGrades[0]).toMatchObject({ priceTarget: 83, previousPriceTarget: null });
  });
});
