/**
 * The premarket bundle's phases, as plain data.
 *
 * Lives apart from premarket.job.ts so the admin Jobs tab (served by the live
 * service, which does not load the job classes) can say which jobs the bundle
 * runs, in what order, and how far a run has got. premarket.job.ts imports these
 * lists, so what the tab shows is what the job runs.
 */
/** Phase 2 — order matters only where noted. */
export const MARKET_WIDE: string[] = [
  "market-indices",
  "sectors",
  "market-movers",
  "market-breadth",
  "fear-greed", // reads market-breadth output
  "macro-events",
  "macro-regime", // FRED-only, self-contained regime label
  "earnings",
  "ipos",
  // edgar-ipo-pipeline moved to Saturday: S-1/424B registrations move over
  // weeks, so a weekday fetch bought nothing and sat ahead of market-hours
  // work. `ipos` stays here — a debut prices on a weekday and is wanted the
  // same morning.
  "news",
  "analyst-actions",
  // sec-form4, sec-13f and institutional-ownership are NOT here on purpose.
  // 13-F is a QUARTERLY filing and institutional-ownership is a rollup of it,
  // so running them every weekday morning re-read data that changes four times
  // a year, ahead of the market-hours jobs. They have their own Saturday
  // scheduler entries instead (sync-*-weekend), staggered so the rollup runs
  // after the filings it depends on. Premarket itself is weekday-only, so a
  // weekend phase in here would never have fired.
  "dividends",
  "options-chains", // its own small OPTIONS_UNIVERSE
];

/** Phase 3 — over the dynamic `companies` universe. */
export const PER_TICKER: string[] = [
  "companies", // refresh profiles of the active set
  // companies-financials-backfill moved to Saturday: it is a cursor backfill
  // filling gaps the profile sweep has not reached yet, with no deadline of
  // its own — the definition of work that does not need a trading morning.
  "stock-history", // ohlcv_bars substrate the compute jobs read
  "edgar-8k", // earnings 8-Ks; reads ohlcv_bars for reaction
  "technical-indicators",
  "rs-rating",
  "tech-rating",
  "financials",
  "fundamentals-growth",
  "corporate-actions",
  // After stock-history (the month-end bars it reads) AND corporate-actions: a
  // split detected this morning has already cleared the ticker's history range,
  // which beta reads as "re-backfill pending" and routes to Polygon instead of
  // a series mixing two adjustment bases. Only recomputes tickers whose beta is
  // behind the last completed month, so most mornings it writes nothing.
  "beta",
  // Real analyst-firm track records (hit rate, move after calls) from FMP
  // grades/targets + prices; cursor over the universe, ~12 runs a cycle.
  "analyst-firm-stats",
];

export const FINAL: string[] = ["recaps"];

/** Phase 1 is not a job: it warms company profiles for the hot set before phase 2. */
export const PREMARKET_WARM = "warm";

export const PREMARKET_PHASE_GROUPS: ReadonlyArray<{ id: string; label: string; jobs: readonly string[] }> = [
  { id: "market-wide", label: "Market-wide", jobs: MARKET_WIDE },
  { id: "per-ticker", label: "Per-ticker", jobs: PER_TICKER },
  { id: "recap", label: "Recap", jobs: FINAL },
];

/** Every job the bundle runs after the warm step, in run order. */
export const PREMARKET_JOBS: readonly string[] = [...MARKET_WIDE, ...PER_TICKER, ...FINAL];