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
  canonicalFirm,
  headlineFirm,
  headlineTargetDirection,
  dedupeGrades,
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
  it("never carries an older target onto a later call (E2E A5: 41 stale '(as of …)' targets)", () => {
    expect(resolveFirmTarget(posts, "2026-10-05")).toBeNull();
    expect(resolveFirmTarget(posts, "2026-03-30")).toBeNull();
  });
  it("takes the post made with the call, with its previous target and direction", () => {
    expect(resolveFirmTarget(posts, "2026-08-06")).toEqual({
      priceTarget: 275, date: "2026-08-05", previousPriceTarget: 244, direction: "raise",
    });
  });
  it("accepts a post a day before (after-close note) or a few days after (news lag)", () => {
    expect(resolveFirmTarget([{ date: "2026-08-31", priceTarget: 135 }], "2026-09-01")?.priceTarget).toBe(135);
    expect(resolveFirmTarget([{ date: "2026-06-03", priceTarget: 10 }], "2026-06-01")?.priceTarget).toBe(10);
    expect(resolveFirmTarget([{ date: "2026-06-05", priceTarget: 10 }], "2026-06-01")).toBeNull();
    expect(resolveFirmTarget([{ date: "2026-05-30", priceTarget: 10 }], "2026-06-01")).toBeNull();
  });
  it("keeps back-to-back calls on their own rows (ABT / Wells Fargo $119 on 10-22, $120 on 10-23)", () => {
    const wf = [
      { date: "2026-10-22", priceTarget: 119, previousTarget: 112 },
      { date: "2026-10-23", priceTarget: 120, previousTarget: 119 },
    ];
    expect(resolveFirmTarget(wf, "2026-10-22")?.priceTarget).toBe(119);
    expect(resolveFirmTarget(wf, "2026-10-23")?.priceTarget).toBe(120);
  });
  it("uses the headline's direction when no previous figure is known", () => {
    expect(resolveFirmTarget([{ date: "2026-03-06", priceTarget: 24, direction: "raise" }], "2026-03-06")?.direction).toBe("raise");
  });
  it("handles no posts and bad dates", () => {
    expect(resolveFirmTarget([], "2026-01-01")).toBeNull();
    expect(resolveFirmTarget(posts, "not-a-date")).toBeNull();
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
    expect(resolveFirmTarget(posts, "2026-10-06")?.previousPriceTarget).toBe(93);
  });
  it("uses a stated 'from' carried by the other feed's copy of the same call", () => {
    const posts = [
      { date: "2026-10-06", priceTarget: 83, previousTarget: 91.5 },
      { date: "2026-10-07", priceTarget: 83, previousTarget: null },
    ];
    expect(resolveFirmTarget(posts, "2026-10-07")).toEqual({
      priceTarget: 83,
      date: "2026-10-07",
      previousPriceTarget: 91.5,
      direction: "cut",
    });
  });
  it("falls back to the firm's previous post, never a duplicate of the same call", () => {
    const posts = [
      { date: "2026-07-20", priceTarget: 102 },
      { date: "2026-07-29", priceTarget: 90 },
      { date: "2026-07-30", priceTarget: 90 },
    ];
    expect(resolveFirmTarget(posts, "2026-07-30")?.previousPriceTarget).toBe(102);
  });
  it("is null when the firm has no earlier post, or only one older than a year", () => {
    expect(resolveFirmTarget([{ date: "2026-07-30", priceTarget: 90 }], "2026-07-30")?.previousPriceTarget).toBeNull();
    const stale = [
      { date: "2025-06-01", priceTarget: 70 },
      { date: "2026-07-30", priceTarget: 90 },
    ];
    expect(resolveFirmTarget(stale, "2026-07-30")?.previousPriceTarget).toBeNull();
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
          { date: "2026-07-31", gradingCompany: "TD Cowen", previousGrade: "Buy", newGrade: "Buy", action: "maintain" },
        ],
        getGradeNews: async () => [
          { date: "2026-07-31", firm: "Cowen & Co.", title: "Amazon.com price target raised to $350 from $340 at TD Cowen" },
          { date: "2026-07-08", firm: "Cowen & Co.", title: "Amazon.com price target lowered to $340 from $350 at TD Cowen" },
        ],
      }),
    ).getConsensus("AMZN");
    expect(out?.recentGrades[0]).toMatchObject({ priceTarget: 350, priceTargetDate: "2026-07-31", previousPriceTarget: 340, priceTargetChange: "raise" });
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
          // The call the target was posted with (a later reiteration carries the
          // standing $95 with no "previous" — see resolveFirmTarget).
          { date: "2026-04-30", gradingCompany: "Barclays", previousGrade: "Overweight", newGrade: "Overweight", action: "maintain" },
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

  it("prefers grades-historical row 0 for consensus tallies", async () => {
    const out = await new FmpAnalystRatingsAdapter(
      fmp({
        getAnalystConsensus: async () => ({ strongBuy: 10, buy: 50, hold: 20, sell: 5, strongSell: 2, consensus: "Buy" }),
        getGradesHistorical: async () => [
          { symbol: "CRM", strongBuy: 6, buy: 34, hold: 15, sell: 0, strongSell: 2, consensus: "Buy" },
        ],
      }),
    ).getConsensus("CRM");
    expect(out).toMatchObject({
      strongBuy: 6,
      buy: 34,
      hold: 15,
      sell: 0,
      strongSell: 2,
      consensus: "Buy",
    });
  });

  it("merges initiations from grade-news and price-target-news into recentGrades", async () => {
    const out = await new FmpAnalystRatingsAdapter(
      fmp({
        getGrades: async () => [
          { date: "2026-10-15", gradingCompany: "KeyBanc", previousGrade: "Buy", newGrade: "Buy", action: "maintain" },
        ],
        getGradeNews: async () => [
          {
            date: "2026-10-21",
            firm: "CICC",
            newGrade: "Outperform",
            action: "initialise",
            title: "Costco initiated with an Outperform at CICC",
          },
        ],
        getPriceTargets: async () => [
          {
            date: "2026-10-21",
            firm: "CICC",
            priceTarget: 1050,
            title: "Costco initiated with an Outperform at CICC",
          },
        ],
      }),
    ).getConsensus("COST");
    expect(out?.recentGrades).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          firm: "CICC",
          action: "initiate",
          priceTarget: 1050,
          date: "2026-10-21",
        }),
      ]),
    );
  });
});

describe("E2E Oct 2026 analyst-action fixes", () => {
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
  const grade = (date: string, firm: string, prev: string | null, next: string, action: string) =>
    ({ date, gradingCompany: firm, previousGrade: prev, newGrade: next, action });

  it("folds the firm spellings that failed to join", () => {
    expect(canonicalFirm("Roth MKM")).toBe(canonicalFirm("Roth Capital"));
    expect(canonicalFirm("Freedom Broker")).toBe(canonicalFirm("Freedom Capital Markets"));
    expect(canonicalFirm("BMO Capital")).toBe(canonicalFirm("BMO Capital Markets"));
    expect(canonicalFirm("B of A Securities")).toBe(canonicalFirm("Bank of America Securities"));
    expect(canonicalFirm("Sidoti & Co.")).toBe(canonicalFirm("Sidoti"));
    expect(canonicalFirm("Capital One")).not.toBe(canonicalFirm("One"));
  });

  it("reads the firm and direction a headline states", () => {
    expect(headlineFirm("Chevron price target raised to $250 from $218 at HSBC")).toBe("HSBC");
    expect(headlineFirm("Mama’s Creations (MAMA) PT Raised to $24 at DA Davidson on Organic Sales Growth")).toBe("DA Davidson");
    expect(headlineFirm("Freedom Capital Markets Starts Mama’s Creations (MAMA) at Buy")).toBe("Freedom Capital Markets");
    expect(headlineFirm("Braze (BRZE) Reiterated at Market Outperform by Citizens")).toBe("Citizens");
    expect(headlineFirm("KeyBanc Sees 'Significant Upside' for La-Z-Boy (LZB)")).toBeNull();
    expect(headlineTargetDirection("Abbott price target raised to $120 from $119 at Wells Fargo")).toBe("raise");
    expect(headlineTargetDirection("Citi lowers Abbott price target to $122")).toBe("cut");
    expect(headlineTargetDirection("Ametek Inc. (AME) PT Raised at RBC Capital Following 'Beat & Raise'")).toBe("raise");
    expect(headlineTargetDirection("Braze (BRZE) Reiterated at Market Outperform by Citizens")).toBeNull();
  });

  it("drops a call FMP repeats under two spellings of the firm (LZB Sidoti)", () => {
    const rows = [
      grade("2025-11-19", "Sidoti", "Neutral", "Buy", "upgrade"),
      grade("2025-11-19", "Sidoti & Co.", "Neutral", "Buy", "upgrade"),
    ];
    expect(dedupeGrades(rows)).toHaveLength(1);
  });

  it("does not read a market roundup FMP tags 'initialise' as an initiation (AAPL)", async () => {
    const out = await new FmpAnalystRatingsAdapter(
      fmp({
        getGrades: async () => [grade("2026-08-17", "Goldman Sachs", "Buy", "Buy", "maintain")],
        getGradeNews: async () => [
          { date: "2026-08-17", firm: "Goldman Sachs", action: "initialise", title: "Apple upgraded, Workday downgraded: Wall Street's top analyst calls" },
        ],
      }),
    ).getConsensus("AAPL");
    expect(out?.recentGrades).toHaveLength(1);
    expect(out?.recentGrades[0].action).toBe("maintain");
  });

  it("trusts the headline over a grossly wrong vendor target, and re-attributes a mis-tagged copy (CVX HSBC)", async () => {
    const out = await new FmpAnalystRatingsAdapter(
      fmp({
        getGrades: async () => [grade("2026-09-25", "HSBC", "Buy", "Buy", "maintain")],
        getPriceTargets: async () => [
          { date: "2026-09-25", firm: "HSBC", priceTarget: 90, title: "Chevron price target raised to $250 from $218 at HSBC" },
          { date: "2026-09-25", firm: "UBS", priceTarget: 250, title: "Chevron price target raised to $250 from $218 at HSBC" },
        ],
      }),
    ).getConsensus("CVX");
    expect(out?.recentGrades[0]).toMatchObject({ priceTarget: 250, previousPriceTarget: 218, priceTargetChange: "raise" });
  });

  it("joins Freedom Capital's targets FMP tags as Loop Capital Markets", async () => {
    const out = await new FmpAnalystRatingsAdapter(
      fmp({
        getGrades: async () => [grade("2026-03-03", "Freedom Broker", "Buy", "Buy", "maintain")],
        getPriceTargets: async () => [
          { date: "2026-03-03", firm: "Loop Capital Markets", priceTarget: 21, title: "Mama’s Creations (MAMA) PT Raised to $21 at Freedom Capital Markets" },
        ],
      }),
    ).getConsensus("MAMA");
    expect(out?.recentGrades[0]).toMatchObject({ priceTarget: 21, priceTargetChange: "raise" });
  });

  it("relabels a grade as the initiation the firm's headline announced (CSCO Deutsche Bank)", async () => {
    const out = await new FmpAnalystRatingsAdapter(
      fmp({
        getGrades: async () => [grade("2026-09-01", "Deutsche Bank", "Hold", "Buy", "upgrade")],
        getGradeNews: async () => [
          { date: "2026-08-31", firm: "Deutsche Bank", title: "Cisco initiated with a Buy at Deutsche Bank", action: "initialise" },
        ],
        getPriceTargets: async () => [
          { date: "2026-08-31", firm: "Deutsche Bank", priceTarget: 135, title: "Cisco initiated with a Buy at Deutsche Bank" },
        ],
      }),
    ).getConsensus("CSCO");
    expect(out?.recentGrades).toHaveLength(1);
    expect(out?.recentGrades[0]).toMatchObject({ action: "initiate", previousGrade: null, priceTarget: 135 });
  });

  it("marks a PT move the headline states without a figure, leaving the target blank", async () => {
    const out = await new FmpAnalystRatingsAdapter(
      fmp({
        getGrades: async () => [grade("2026-08-11", "RBC Capital", "Outperform", "Outperform", "maintain")],
        getGradeNews: async () => [
          { date: "2026-08-11", firm: "RBC Capital", title: "Ametek Inc. (AME) PT Raised at RBC Capital Following 'Beat & Raise'" },
        ],
      }),
    ).getConsensus("AME");
    expect(out?.recentGrades[0]).toMatchObject({ priceTarget: null, priceTargetChange: "raise" });
  });
});
