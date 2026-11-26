import {
  applyCalendar,
  applyRecapRows,
  calendarReasons,
  closeBellSeconds,
  closeReasons,
  figureReasons,
  historyReasons,
  readLine,
  recapRows,
  upcomingEvents,
  weekdayOf,
  weekdayReasons,
  type QuoteLike,
} from "./eod-recap.facts";

// The Nov 25, 2026 session as the vendor reports it (official closes).
const bell = closeBellSeconds("2026-11-25");
const q = (
  symbol: string,
  price: number,
  previousClose: number,
  ts = bell + 120,
): QuoteLike => ({
  symbol,
  price,
  previousClose,
  change: price - previousClose,
  changePercentage: ((price - previousClose) / previousClose) * 100,
  timestamp: ts,
});
const QUOTES: QuoteLike[] = [
  q("^DJI", 50182.95, 50018.7),
  q("^GSPC", 7182.78, 7201.09),
  q("^IXIC", 23585.803, 23733.535),
  q("^RUT", 2704.061, 2684.942),
  q("^VIX", 23.32, 22.29),
  q("CLUSD", 83.01, 81.4),
  q("XAUUSD", 3529.1, 3500.2),
  q("BTCUSD", 58500, 57900),
];
const rows = recapRows(QUOTES);

// What the Nov 25 recap actually published (ETF stand-ins and model prose).
const NOV25 = `<p>The Dow Jones Industrial Average nudged higher with a 0.32% gain, while the S&amp;P 500 slipped 0.27%.</p>
<p>Broad indices close mixed on Friday.</p>
<h2 id="numbers">The numbers, by the close</h2>
<div class="stat-strip">
  <div class="stat-box">
    <div class="num">+0.32%</div>
    <div class="label">Dow Jones (50,133, +159 pts)</div>
  </div>
</div>
<div class="post-doc-scroll"><table>
  <thead><tr><th>Index</th><th>Close</th><th>Point Change</th><th>% Change</th><th>Session Read</th></tr></thead>
  <tbody>
    <tr><td class="metric">DJIA</td><td>50,133</td><td class="pos">+159</td><td class="pos">+0.32%</td><td>Broad-market optimism</td></tr>
  </tbody>
</table></div>
<h2 id="cross-asset">Rates, dollar, gold, and crypto</h2>
<p>Oil prices rose 3.3% to $139.93, lifting Bitcoin to $34.07.</p>
<div class="post-doc-scroll"><table>
  <thead><tr><th>Asset</th><th>Close or Yield</th><th>Daily Change</th><th>% Change</th><th>Main Catalyst</th></tr></thead>
  <tbody>
    <tr><td class="metric">Gold (XAU/USD)</td><td>$327.51</td><td class="pos">+1.92</td><td class="pos">+0.59%</td><td>Safe-haven demand</td></tr>
  </tbody>
</table></div>
<h2 id="calendar">What to watch next</h2>
<div class="timeline">
  <div class="timeline-item">
    <div class="timeline-date">Nov 27</div>
    <div class="timeline-text">Core CPI (CPILFESL) – underlying price pressures.</div>
  </div>
</div>
<div class="warning"><strong>Worth remembering:</strong> stay balanced.</div>
<h2 id="takeaway">The takeaway</h2>`;

describe("eod-recap facts", () => {
  it("uses the instruments themselves, with change from the previous close", () => {
    const dow = rows.find((r) => r.id === "DJI")!;
    expect(dow.close).toBe(50182.95);
    expect(dow.change).toBeCloseTo(164.25, 2);
    expect(rows.find((r) => r.id === "GOLD")!.label).toBe("Gold, spot ($/oz)");
  });

  it("drops a print far outside the instrument's own 52-week range", () => {
    const bad = recapRows([
      { ...q("CLUSD", 139.93, 135.5), yearHigh: 100, yearLow: 55 },
    ]);
    expect(bad).toHaveLength(0);
  });

  it("holds the recap when an index has not printed its close yet", () => {
    expect(closeReasons(rows, "2026-11-25")).toEqual([]);
    const early = recapRows(
      QUOTES.map((x) =>
        x.symbol === "^DJI" ? { ...x, timestamp: bell - 900 } : x,
      ),
    );
    expect(closeReasons(early, "2026-11-25")).toEqual([
      "DJIA figure is not the final close yet",
    ]);
    expect(
      closeReasons(
        rows.filter((r) => r.id !== "SPX"),
        "2026-11-25",
      )[0],
    ).toMatch(/No official close for S&P 500/);
  });

  it("rewrites the stat boxes and both tables from the data, keeping the model's notes", () => {
    const out = applyRecapRows(NOV25, rows, { value: 4.85, changeBps: -1.2 });
    expect(out).toContain("Dow Jones (50,182.95, +164.25 pts)");
    expect(out).toContain(
      '<td class="metric">DJIA</td><td>50,182.95</td><td class="pos">+164.25</td><td class="pos">+0.33%</td><td>Broad-market optimism</td>',
    );
    expect(out).not.toContain("50,133");
    expect(out).not.toContain("Gold (XAU/USD)");
    expect(out).toContain(
      '<td class="metric">Gold, spot ($/oz)</td><td>$3,529.10</td>',
    );
    expect(out).toContain("<td>Safe-haven demand</td>");
    expect(out).toContain("10Y Treasury Yield</td><td>4.85%");
  });

  it("flags prose figures that disagree with the data (the Nov 25 oil and bitcoin lines)", () => {
    const reasons = figureReasons(NOV25, rows);
    expect(reasons.some((r) => /WTI crude.*139\.93/.test(r))).toBe(true);
    expect(reasons.some((r) => /WTI crude.*3\.3%/.test(r))).toBe(true);
    expect(reasons.some((r) => /Bitcoin.*34\.07/.test(r))).toBe(true);
    // "S&P 500 slipped 0.27%" against a real -0.25%
    expect(reasons.some((r) => /S&P 500.*0\.27%/.test(r))).toBe(true);
  });

  it("passes prose that matches the data", () => {
    const ok = `<p>The Dow rose 0.33% to 50,182.95 and the S&amp;P 500 slipped 0.25%, while gold rose to $3,529.10.</p>`;
    expect(figureReasons(ok, rows)).toEqual([]);
  });

  it("names the session by its own weekday", () => {
    expect(weekdayOf("2026-11-25")).toBe("Wednesday");
    expect(
      weekdayReasons(
        "Dow Hits 50K",
        "Broad indices close mixed on Friday",
        "<p>x</p>",
        "2026-11-25",
      ),
    ).toEqual(['Calls the Wednesday session "Friday"']);
    expect(
      weekdayReasons(
        "Stocks close mixed on Wednesday",
        "",
        '<h2 id="calendar">x</h2><p>Friday\'s jobs report</p>',
        "2026-11-25",
      ),
    ).toEqual([]);
  });

  it("holds historical claims it cannot check", () => {
    expect(
      historyReasons(
        "",
        "",
        "<p>marked the first time the index closed above 50,000</p>",
      )[0],
    ).toMatch(/first time/);
    expect(historyReasons("Dow Hits Near-14-Year High", "", "")[0]).toMatch(
      /14-Year High/i,
    );
    expect(
      historyReasons("Stocks close mixed", "", "<p>The Dow rose 0.3%.</p>"),
    ).toEqual([]);
  });

  it("builds the calendar from scheduled releases only, after the session", () => {
    const docs = [
      {
        id: "CPILFESL",
        data: { source: "fred", name: "Core CPI", eventDate: "2026-10-01" },
      },
      {
        id: "fmp_gdp_2026-11-26",
        data: {
          source: "fmp",
          name: "GDP Growth Rate QoQ 2nd Est",
          eventDate: "2026-11-26",
          importance: "high",
        },
      },
      {
        id: "fmp_pce_2026-12-02",
        data: {
          source: "fmp",
          name: "Core PCE Price Index MoM",
          eventDate: "2026-12-02",
          importance: "high",
          estimate: 0.2,
          previous: 0.3,
        },
      },
      {
        id: "fmp_old_2026-11-25",
        data: { source: "fmp", name: "Same-day item", eventDate: "2026-11-25" },
      },
      {
        id: "fmp_cftc_2026-11-27",
        data: {
          source: "fmp",
          name: "CFTC Gold speculative net positions",
          eventDate: "2026-11-27",
          importance: "medium",
        },
      },
      {
        id: "fmp_far_2026-12-31",
        data: { source: "fmp", name: "Too far", eventDate: "2026-12-31" },
      },
    ];
    const ev = upcomingEvents(docs, "2026-11-25");
    expect(ev.map((e) => e.name)).toEqual([
      "GDP Growth Rate QoQ 2nd Est",
      "Core PCE Price Index MoM",
    ]);
    const out = applyCalendar(NOV25, ev);
    expect(out).not.toContain("CPILFESL");
    expect(out).toContain('<div class="timeline-date">Thu, Nov 26</div>');
    expect(out).toContain(
      "Core PCE Price Index MoM (consensus 0.2, prior 0.3)",
    );
    expect(out).toContain('<div class="warning">');
  });

  it("flags raw series codes left in the calendar", () => {
    expect(
      calendarReasons(NOV25, ["CPILFESL", "PAYEMS"], "2026-11-25"),
    ).toEqual(["Calendar shows raw series codes: CPILFESL"]);
  });

  it("writes the read line at the real publish time", () => {
    expect(readLine(new Date("2026-11-25T21:47:00Z"), 9)).toBe(
      "Published Nov 25, 2026 · 4:47 PM ET · 9 min read",
    );
  });
});
