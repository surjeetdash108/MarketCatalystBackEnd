import {
  analystSummary,
  compareToForecast,
  earningsFocus,
  etDayOf,
  latestBreadth,
  sp500Weights,
  upcomingCatalysts,
} from "./wmn-slides.util";

// Thu 26 Nov 2026, 14:30 UTC = 09:30 EST (the market open).
const NOW = new Date("2026-11-26T14:30:00Z");
const kindOf = () => null;

describe("etDayOf", () => {
  it("uses the New York calendar, not UTC", () => {
    // 02:00 UTC on the 27th is still the evening of the 26th in New York.
    expect(etDayOf(new Date("2026-11-27T02:00:00Z"))).toBe("2026-11-26");
  });
});

describe("latestBreadth", () => {
  it("reads the newest settled day", () => {
    const b = latestBreadth(
      [
        { id: "2026-11-25", advancers: 100, decliners: 300, covered: 450, universe: 500 },
        { id: "2026-11-26", advancers: 320, decliners: 150, covered: 480, universe: 500 },
      ],
      NOW,
    );
    expect(b).toEqual({ date: "2026-11-26", advancers: 320, decliners: 150, unchanged: 10 });
  });

  it("skips a session that covers under half the universe", () => {
    const b = latestBreadth(
      [
        { id: "2026-11-25", advancers: 100, decliners: 300, covered: 450, universe: 500 },
        { id: "2026-11-26", advancers: 9, decliners: 1, covered: 10, universe: 500 },
      ],
      NOW,
    );
    expect(b?.date).toBe("2026-11-25");
  });

  it("returns null once the newest settled day is too old", () => {
    const b = latestBreadth(
      [{ id: "2026-11-10", advancers: 1, decliners: 1, covered: 400, universe: 500 }],
      NOW,
    );
    expect(b).toBeNull();
  });
});

function universe(count: number, capFor: (i: number) => number = () => 1e10) {
  const companies = Array.from({ length: count }, (_, i) => ({
    ticker: `T${i}`,
    name: `Name ${i}`,
    marketCap: capFor(i),
    // The stored move is deliberately junk: the backend must not read it.
    pctChange: 0,
  }));
  return { companies, members: new Set(companies.map((c) => c.ticker)) };
}

describe("sp500Weights", () => {
  it("returns the heaviest names with their share of the index's total cap", () => {
    const { companies, members } = universe(450);
    companies[0] = { ...companies[0], marketCap: 3e12 };
    companies[1] = { ...companies[1], marketCap: 2e12 };
    const out = sp500Weights(companies, members, 2)!;
    expect(out.map((w) => w.ticker)).toEqual(["T0", "T1"]);
    const total = companies.reduce((s, c) => s + c.marketCap, 0);
    expect(out[0].weightPct).toBeCloseTo((3e12 / total) * 100, 2);
    expect(out[0].weightPct).toBeGreaterThan(out[1].weightPct);
  });

  it("gives the top-40 by default", () => {
    const { companies, members } = universe(450, (i) => 1e10 + i * 1e8);
    expect(sp500Weights(companies, members)).toHaveLength(40);
  });

  it("does not depend on the stored % move (it is flat outside the session)", () => {
    const { companies, members } = universe(450);
    expect(sp500Weights(companies, members)).not.toBeNull();
  });

  it("refuses to weight an index it can barely price", () => {
    const { companies, members } = universe(100);
    expect(sp500Weights(companies, members)).toBeNull();
  });

  it("ignores companies that are not index members, and ones with no cap", () => {
    const { companies, members } = universe(450);
    const outsider = { ticker: "ZZZ", name: "Outsider", marketCap: 9e12, pctChange: 0 };
    const capless = { ticker: "T5", name: "Capless", marketCap: 0, pctChange: 0 };
    const out = sp500Weights([...companies.filter((c) => c.ticker !== "T5"), outsider, capless], members, 500)!;
    expect(out.find((w) => w.ticker === "ZZZ")).toBeUndefined();
    expect(out.find((w) => w.ticker === "T5")).toBeUndefined();
  });
});

describe("compareToForecast", () => {
  it("is neutral about direction and tolerant of float noise", () => {
    expect(compareToForecast(3.1, 3.0)).toBe("above");
    expect(compareToForecast(2.9, 3.0)).toBe("below");
    expect(compareToForecast(3.0000001, 3.0)).toBe("in-line");
    expect(compareToForecast(null, 3.0)).toBeNull();
    expect(compareToForecast(3.0, null)).toBeNull();
  });
});

describe("upcomingCatalysts", () => {
  const ev = (over: Record<string, unknown>) => ({
    id: "x",
    name: "CPI YoY",
    importance: "high",
    eventDate: "2026-11-26",
    ...over,
  });

  it("uses the exact window when the release time is known", () => {
    const rows = [
      ev({ id: "soon", eventTime: "2026-11-26T18:00:00Z" }), // +3.5h
      ev({ id: "far", eventTime: "2026-11-28T18:00:00Z" }), // +51h
      ev({ id: "old", eventTime: "2026-11-26T05:00:00Z" }), // -9.5h
    ];
    expect(upcomingCatalysts(rows, NOW, kindOf).map((c) => c.id)).toEqual(["soon"]);
  });

  it("falls back to today and tomorrow when only a day is stored", () => {
    const rows = [
      ev({ id: "today" }),
      ev({ id: "tomorrow", eventDate: "2026-11-27" }),
      ev({ id: "later", eventDate: "2026-12-03" }),
    ];
    const ids = upcomingCatalysts(rows, NOW, kindOf).map((c) => c.id);
    expect(ids.sort()).toEqual(["today", "tomorrow"]);
  });

  it("skips weekly positioning and inventory tallies the calendar rates 'medium'", () => {
    const rows = [
      ev({ id: "c1", name: "CFTC Gold Speculative net positions", importance: "medium" }),
      ev({ id: "c2", name: "API Crude Oil Stock Change (Nov/27)", importance: "medium" }),
      ev({ id: "c3", name: "EIA Gasoline Stocks Change (Nov/27)", importance: "medium" }),
      ev({ id: "c4", name: "MBA 30-Year Mortgage Rate (Nov/27)", importance: "medium" }),
      ev({ id: "keep", name: "Goods Trade Balance (Oct)", importance: "high" }),
      ev({ id: "fed", name: "Fed Bowman Speech", importance: "medium" }),
    ];
    expect(upcomingCatalysts(rows, NOW, kindOf).map((c) => c.id).sort()).toEqual(["fed", "keep"]);
  });

  it("drops low-importance noise", () => {
    expect(upcomingCatalysts([ev({ importance: "low" })], NOW, kindOf)).toEqual([]);
  });

  it("marks a printed release as released and compares it with the forecast", () => {
    const [c] = upcomingCatalysts(
      [ev({ eventTime: "2026-11-26T13:30:00Z", actual: 3.4, estimate: 3.2, previous: 3.0 })],
      NOW,
      kindOf,
    );
    expect(c.status).toBe("released");
    expect(c.versus).toBe("above");
    expect(c.previous).toBe(3.0);
  });

  it("keeps an unprinted release that is a little overdue as upcoming", () => {
    const [c] = upcomingCatalysts([ev({ eventTime: "2026-11-26T14:00:00Z" })], NOW, kindOf);
    expect(c.status).toBe("upcoming");
    expect(c.versus).toBeNull();
  });

  it("caps the list, keeping the high-importance names, in clock order", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      ev({
        id: `e${i}`,
        importance: i < 3 ? "high" : "medium",
        eventTime: new Date(NOW.getTime() + (8 - i) * 3_600_000).toISOString(),
      }),
    );
    const out = upcomingCatalysts(rows, NOW, kindOf);
    expect(out).toHaveLength(5);
    expect(["e0", "e1", "e2"].every((id) => out.some((c) => c.id === id))).toBe(true);
    const times = out.map((c) => Date.parse(c.time!));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("earningsFocus", () => {
  const companies = [
    { ticker: "BIG", name: "Big Co", marketCap: 900e9 },
    { ticker: "MID", name: "Mid Co", marketCap: 50e9 },
    { ticker: "TINY", name: "Tiny Co", marketCap: 1e9 },
  ];
  const e = (over: Record<string, unknown>) => ({
    ticker: "BIG",
    date: "2026-11-26",
    session: "AMC",
    epsEstimate: 2,
    epsActual: null,
    ...over,
  });

  it("returns null only when nobody reports, so the slide is dropped", () => {
    expect(earningsFocus([], [], companies, NOW)).toBeNull();
    // Reports on some other day do not count either.
    expect(earningsFocus([e({ date: "2026-11-30" })], [], companies, NOW)).toBeNull();
  });

  it("has no size floor: a small company reporting alone still fills the slide", () => {
    const micro = [{ ticker: "ENLV", name: "Enlivex", marketCap: 30e6 }];
    const out = earningsFocus([e({ ticker: "ENLV" })], [], micro, NOW)!;
    expect(out.items.map((i) => i.ticker)).toEqual(["ENLV"]);
    expect(out.total).toBe(1);
    // TINY ($1B) used to be filtered out; now it is shown.
    expect(earningsFocus([e({ ticker: "TINY" })], [], companies, NOW)?.items[0].ticker).toBe("TINY");
  });

  it("counts a company with no market cap on file, ranked after every one that has one", () => {
    const out = earningsFocus(
      [e({ ticker: "NOCAP" }), e({ ticker: "TINY" }), e({ ticker: "ZZZ" })], // ZZZ is not in `companies` at all
      [],
      [...companies, { ticker: "NOCAP", name: "No Cap Inc", marketCap: null }],
      NOW,
    )!;
    expect(out.items.map((i) => i.ticker)).toEqual(["TINY", "NOCAP", "ZZZ"]);
    expect(out.items[1].marketCap).toBeNull();
    expect(out.items[2].name).toBe("ZZZ"); // falls back to the ticker when nothing names it
  });

  it("ranks by market cap and reports surprise against the estimate", () => {
    const out = earningsFocus(
      [
        e({ ticker: "MID", epsActual: 1.1, epsEstimate: 1.0, revenueActual: 11, revenueEstimate: 10 }),
        e({ ticker: "BIG", epsActual: 2.4, epsEstimate: 2.0 }),
        e({ ticker: "TINY" }),
      ],
      [],
      companies,
      NOW,
    )!;
    expect(out.items.map((i) => i.ticker)).toEqual(["BIG", "MID", "TINY"]);
    expect(out.items[0].eps.surprisePct).toBe(20);
    expect(out.items[1].revenue.surprisePct).toBe(10);
    expect(out.items[0].reported).toBe(true);
  });

  it("carries guidance and the recorded reaction from the 8-K row", () => {
    const out = earningsFocus(
      [e({ epsActual: 2.4 })],
      [
        {
          ticker: "BIG",
          announceDate: "2026-11-26",
          session: "AMC",
          guidanceDirection: "raised",
          guidanceRange: "$9.00 to $9.50",
          reactionPct: -3.2,
        },
      ],
      companies,
      NOW,
    )!;
    expect(out.items[0].guidance).toEqual({ direction: "raised", range: "$9.00 to $9.50" });
    expect(out.items[0].reactionPct).toBe(-3.2);
  });

  it("leaves surprise empty rather than dividing by a near-zero estimate", () => {
    const out = earningsFocus([e({ epsActual: 0.5, epsEstimate: 0 })], [], companies, NOW)!;
    expect(out.items[0].eps.surprisePct).toBeNull();
  });

  it("caps the slide at three names but counts them all", () => {
    const many = ["A", "B", "C", "D"].map((t, i) => ({ ticker: t, name: t, marketCap: (100 - i) * 1e9 }));
    const out = earningsFocus(
      many.map((c) => e({ ticker: c.ticker })),
      [],
      many,
      NOW,
    )!;
    expect(out.items).toHaveLength(3);
    expect(out.items.map((i) => i.ticker)).toEqual(["A", "B", "C"]); // the three biggest
    expect(out.total).toBe(4);
  });

  it("adds yesterday's after-close reporters in the morning only", () => {
    const rows = [e({ date: "2026-11-25", session: "AMC", epsActual: 2.1 })];
    expect(earningsFocus(rows, [], companies, NOW)?.items[0].ticker).toBe("BIG"); // 09:30 ET
    const afternoon = new Date("2026-11-26T19:30:00Z"); // 14:30 ET
    expect(earningsFocus(rows, [], companies, afternoon)).toBeNull();
  });
});

describe("analystSummary", () => {
  const companies = [
    { ticker: "BIG", name: "Big Co", marketCap: 900e9 },
    { ticker: "MID", name: "Mid Co", marketCap: 50e9 },
  ];
  const doc = (ticker: string, grades: Array<Record<string, unknown>>) => ({ ticker, recentGrades: grades });

  it("counts upgrades, downgrades, initiations and target moves since the last session", () => {
    const s = analystSummary(
      [
        doc("BIG", [
          { date: "2026-11-25", firm: "A", action: "upgrade", newGrade: "Buy", previousGrade: "Hold", priceTargetChange: "raise", priceTarget: 200 },
          { date: "2026-11-26", firm: "B", action: "initiate", newGrade: "Buy" },
          { date: "2026-11-20", firm: "C", action: "downgrade" }, // too old
        ]),
        doc("MID", [{ date: "2026-11-26", firm: "D", action: "downgrade", priceTargetChange: "cut" }]),
      ],
      companies,
      NOW,
    )!;
    expect(s).toMatchObject({ upgrades: 1, downgrades: 1, initiations: 1, ptRaises: 1, ptCuts: 1 });
    expect(s.rows[0].ticker).toBe("BIG"); // largest company first
  });

  it("does not count 'maintain' calls as rating changes", () => {
    const s = analystSummary(
      [doc("BIG", [{ date: "2026-11-26", action: "maintain", priceTargetChange: "raise" }])],
      companies,
      NOW,
    )!;
    expect(s.upgrades + s.downgrades + s.initiations).toBe(0);
    expect(s.ptRaises).toBe(1);
    expect(s.rows).toEqual([]);
  });

  it("reaches back over the weekend on a Monday", () => {
    const monday = new Date("2026-11-30T14:30:00Z");
    const s = analystSummary(
      [doc("BIG", [{ date: "2026-11-27", firm: "A", action: "upgrade" }])],
      companies,
      monday,
    );
    expect(s?.upgrades).toBe(1);
  });

  it("returns null when the Street did nothing", () => {
    expect(analystSummary([doc("BIG", [])], companies, NOW)).toBeNull();
  });
});
