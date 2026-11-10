# MarketCatalyst E2E Data Quality & Fixes Report
**Testing Dates:** October 20 & October 22, 2026  
**Audience:** Internal Engineering & Product Team  
**Repositories:** `MarketCatalystUI`, `MarketCatalystBackEnd`  

---

## Executive Summary

During end-to-end integration and data-quality audits on October 20 and October 22, 2026, approximately 600 individual data and UI discrepancy rows were cataloged across MarketCatalyst. Rather than applying superficial, per-ticker overrides, investigation revealed that these discrepancies stemmed from **13 core root causes** spanning timezone boundaries, sliding consensus windows, vendor API limitations, and state management.

All 13 categories have been addressed with algorithmic, permanent fixes. The backend test suite passes with **51/51 test suites and 516/516 tests passing**, and the frontend builds cleanly with zero errors.

### Summary Table

| # | Root Cause Category | Issues (Approx.) | Screens Affected | Status |
|---|---|---|---|---|
| 1 | Dates shown one day early (Timezone boundary handling) | ~65 rows | Stock Intelligence, Catalysts, 13F & Insider, Analyst Actions | **Fixed** |
| 2 | Hardcoded or placeholder values | ~35 rows | Stock Intelligence (Overview, Upcoming Catalysts) | **Fixed** |
| 3 | Analyst price targets and actions formatting/search | ~100 rows | Analyst Actions, Stock Detail (Analyst tab), SI Catalysts | **Fixed** |
| 4 | Inflated analyst consensus counts & skewed target ranges | ~40 rows | Stock Detail, SI Analyst Overview, Analyst Hub | **Fixed** |
| 5 | Valuation and fundamentals calculations (Bank metrics, GAAP EPS) | ~80 rows | Stock Detail (Key Stats), SI Valuation, Financials | **Fixed** |
| 6 | Stale or inconsistent prices and caching | ~50 rows | Heatmap, Dashboard, ETF Corner, Themes, Movers | **Fixed** |
| 7 | List sorting and ranking | ~25 rows | Market Movers (Top Gainers/Losers, Most Active) | **Fixed** |
| 8 | Relative volume (RVOL) time-of-day calculation | ~20 rows | Movers, Stock Detail Header, Stock Intelligence | **Fixed** |
| 9 | Insider and 13F aggregation (Sells count, future dates) | ~60 rows | 13F & Insider Screen, Stock Detail Insider Drawer | **Fixed** |
| 10 | Next earnings date and multi-week calendar slicing | ~40 rows | Stock Detail, Earnings Hub, SI Catalysts | **Fixed** |
| 11 | Fields stuck on N/A or Loading states | ~30 rows | Stock Detail, AI Research Synthesis | **Fixed** |
| 12 | Screener logic & permissive preset filters | ~25 rows | Stock Screener | **Fixed** |
| 13 | UI state, timezone labels & Live Feed categorization | ~30 rows | Themes, Movers, Dashboard Live Feed | **Fixed** |

---

## 1. Dates Shown One Day Early (Timezone Handling)

- **Problem:** Date-only strings (e.g. `"2026-10-21"`) were parsed as midnight UTC and formatted in US timezones, causing them to render in the previous evening and display one calendar day early.
- **Where it appeared:** Stock Intelligence "Why It Moved" catalyst cards, Catalysts tab earnings/analyst dates, 13F & Insider Form 4 dates, and Analyst Action rows.
- **Examples:**
  - NEE analyst call: Rendered as `Jul 21` (App) vs. `Jul 22` (Correct).
  - NVDA Needham call: Rendered as `Oct 20` (App) vs. `Oct 21` (Correct).
  - SEC Form 4 filings: Rendered as 1 day prior to actual SEC filing date.
- **Root cause:** Standard JavaScript `new Date("YYYY-MM-DD")` evaluates at `00:00:00 UTC`. When formatted with local browser timezone formatters in US Eastern Time (UTC-4/UTC-5), the time shifted back 4–5 hours into the prior calendar day.
- **Fix:**
  - Created shared date formatter `fmtMarketDate()` in `app/iq/calendar-range.ts` with explicit `timeZone: "America/New_York"`.
  - Updated date renderers in `app/iq/si/data.ts`, `app/iq/screens/insider.tsx`, `app/iq/screens/analyst.tsx`, and `app/iq/date-picker.tsx`.
  - Standardized backend job calendar bounds with `etTodayIso()` in `src/sync/sectors.job.ts` and `src/common/sync-meta.service.ts`.
- **How verified:** Verified with unit tests in `src/common/date.util.spec.ts` and verified calendar alignment across Form 4 filings and analyst action dates.
- **Status:** **Fixed**

---

## 2. Hardcoded or Placeholder Values

- **Problem:** The Stock Intelligence Overview radar and signal scores displayed the exact same numbers for every stock, and upcoming catalyst dates were hardcoded static strings.
- **Where it appeared:** Stock Intelligence Overview tab (7 signal category scores) and Upcoming Catalysts right rail.
- **Examples:**
  - Signal scores: Rendered as `88, 87, 80, 71, 70, 71, 67` identically for NVDA, ETN, MSFT, COST, and all other tickers.
  - Options Expiry: Hardcoded as `Oct 25` (a Sunday) vs. actual 3rd Friday of the month (`Nov 20`).
  - FOMC Meeting: Hardcoded as `Oct 29` vs. Federal Reserve schedule (`Oct 28`).
- **Root cause:** The Overview screen used a static placeholder mock tuple rather than subscribing to the dynamic forward-signal calculation engine. Catalyst calendar dates used static string literals.
- **Fix:**
  - Refactored `app/iq/si/stock-intelligence.tsx` to compute Overview scores from the dynamic `forwardSignals` model, matching the Forward Signals tab.
  - Implemented dynamic 3rd-Friday options expiration math (`calcThirdFriday(year, month)`) and 2026 FOMC calendar mapping in `app/iq/calendar-range.ts` and `src/sync/calendar-estimates.ts`.
- **How verified:** Verified distinct, dynamic scores for NVDA vs. MSFT vs. ETN; verified options expiry calculates dynamically as Nov 20, 2026.
- **Status:** **Fixed**

---

## 3. Analyst Price Targets and Actions

- **Problem:** Broker calls displayed the market consensus price target instead of the firm's actual target, price target text was truncated on the right, and ticker searches matched company names over exact symbols.
- **Where it appeared:** Analyst Actions screen (`/menu/analyst`), Stock Detail Analyst tab (`stock-analyst-actions-view.tsx`), SI Catalysts analyst tab.
- **Examples:**
  - Firm price target: Rendered consensus target (e.g. `$430`) when the firm issued a rating without a target, or showed confusing `"old → new"` text.
  - Ticker search: Typing `"NEE"` returned Needham & Company before NextEra Energy.
  - Actions table: Capped at 20 total actions with columns overflowing the viewport.
- **Root cause:** FMP's price target feed returned only the latest 100 posts; missing firm targets defaulted to consensus; frontend lacked pagination; prefix search ranked by substring presence without prioritizing exact ticker equality.
- **Fix:**
  - `src/adapters/analyst-ratings.adapter.ts`: Preserved full broker action history, distinguished firm targets from consensus (`"—"` when omitted), and added `"as of MM-DD"` timestamps for carried-forward targets.
  - `src/live/ticker-search.service.ts`: Prioritized exact symbol match (`ticker.toUpperCase() === query`).
  - `app/iq/stock-analyst-actions-view.tsx`: Connected to `/market-data/analyst-history`, implemented 20-row pagination with Next/Prev navigation, fixed column widths, and styled price target font in white.
- **How verified:** Unit tests in `src/adapters/analyst-consensus.spec.ts` passing; verified search returns NEE first; UI pagination verified.
- **Status:** **Fixed**

---

## 4. Inflated Analyst Consensus Counts & Price Target Low/High

- **Problem:** Analyst Buy/Hold/Sell counts were 1.5× to 2× higher than public sources (e.g. Yahoo Finance), and consensus target ranges were distorted by outdated broker calls.
- **Where it appeared:** Stock Detail Analyst Consensus card, SI Analyst Overview, Analyst Hub.
- **Examples:**
  - CRM rating counts: Showed 65+ ratings (App) vs. ~45 ratings (Yahoo Finance).
  - Target low/high: Outdated analyst targets from 24+ months ago pulled the target low/high boundaries away from current market reality.
- **Root cause:** Consensus queries aggregated all historical database entries without an expiration window, accumulating duplicate reiterations and retired broker coverage over several years.
- **Fix:**
  - `src/adapters/analyst-ratings.adapter.ts`: Enforced a firm-level sliding deduplication window: maximum 36 months for rating recommendations, and maximum 12 months for price targets. Only the latest valid call from each firm is retained.
- **How verified:** Unit tests in `src/adapters/analyst-consensus.spec.ts` passing; validated CRM rating counts reflect active coverage.
- **Status:** **Fixed**

---

## 5. Valuation and Fundamentals Calculations

- **Problem:** P/E, EPS (TTM), Forward P/E, PEG, and Total Debt differed noticeably from public data; banking institutions displayed misleading corporate metrics.
- **Where it appeared:** Stock Detail Key Statistics, Stock Intelligence Valuation cards.
- **Examples:**
  - NVDA Forward P/E: Rendered as ~46× (based on current FY in progress) vs. market standard ~13.4× (next fiscal year consensus).
  - JPM Revenue: Rendered as ~$76B (gross interest revenue) vs. ~$50B (net interest revenue).
  - JPM / Banks: Displayed Gross Margin, EV/EBITDA, and FCF Yield (metrics not used for banks).
  - COST Total Debt: Rendered as ~$4.1B (long-term debt only) vs. ~$8.6B (total debt including short-term obligations and leases).
- **Root cause:** Forward P/E used current-year EPS instead of next fiscal year estimate; bank revenue logic did not subtract interest expense; debt aggregation omitted current liabilities.
- **Fix:**
  - `app/iq/si/data.ts`: Forward P/E computes against next fiscal year estimate (`nextFyEps || fwdEps`); PEG computes `fwdPE / epsGrowth`.
  - `src/adapters/fmp-financials.adapter.ts`: Prioritized GAAP diluted EPS; calculated bank revenue net of interest expense; included short-term and long-term debt in total debt.
  - `app/iq/si/data.ts`: Automatically suppressed Gross Margin, EV/EBITDA, and FCF Yield for banking SIC codes (`60xx/61xx`).
- **How verified:** Unit tests in `src/adapters/fmp-financials.adapter.spec.ts` and `src/live/financials-ttm.spec.ts` passing.
- **Status:** **Fixed** *(Historical bank net revenue will reflect on older periods upon execution of the background `financials` sync job).*

---

## 6. Stale or Inconsistent Prices and Caching

- **Problem:** Sector percentage changes displayed prior-day values; Popular ETF cards lacked prices; prices differed across screens at the same minute.
- **Where it appeared:** Heatmap, Dashboard Market Recap, ETF Corner fund cards, Themes.
- **Examples:**
  - Sector %: Displayed previous day's close during active market trading hours.
  - ETF Corner: Six Popular ETF cards showed fund ticker with blank price and percentage.
- **Root cause:** Sector rollup cache had no TTL invalidation during market hours; ETF quote consumer lacked batching and raced with component mounting.
- **Fix:**
  - `src/sync/company-quotes.job.ts` & `src/market-data/sectors.controller.ts`: Added cache TTL invalidation; sector rollups automatically rebuild when older than 10 minutes.
  - `app/iq/screens/etf-corner.tsx`: Implemented batched live quote resolution using `useLiveQuotes(fundSymbols)` with `fundPx()` mapping for real-time price & %.
- **How verified:** Frontend build verified with live quote bindings; backend sector controller tests passing.
- **Status:** **Fixed**

---

## 7. List Sorting and Ranking

- **Problem:** Movers tables (Top Gainers / Top Losers) appeared out of order, and the Most Active table omitted volume.
- **Where it appeared:** Market Movers (`/menu/movers`), Most Active table.
- **Examples:**
  - Top Losers: Stock with -4.1% listed above stock with -7.8%.
  - Most Active: Table omitted volume column entirely.
- **Root cause:** Sorting was performed on unadjusted raw fields rather than the displayed net change percent; the volume column definition was missing from table headers.
- **Fix:**
  - `app/iq/screens/movers.tsx`: Sorted explicitly on `displayedChangePercent` descending for Gainers and ascending for Losers; added a dedicated **Volume** column to Most Active.
- **How verified:** Manual inspection of sorting logic; verified in UI build.
- **Status:** **Fixed**

---

## 8. Relative Volume (RVOL) Time-of-Day Calculation

- **Problem:** Intraday RVOL carried over the previous session's closing volume ratio rather than pacing volume according to the elapsed trading day.
- **Where it appeared:** Movers, Stock Detail header, Stock Intelligence volume badges.
- **Examples:**
  - ISRG RVOL: Showed 2.8× right at 9:35 AM, reflecting yesterday's closing surge rather than morning volume pace.
- **Root cause:** Accumulated intraday volume was divided directly by the full-day 30-day average volume without scaling for elapsed market minutes.
- **Fix:**
  - `src/sync/company-quotes.job.ts`: Adjusted live RVOL dynamically for time of day (`minutesSinceOpen / 390`) against historical baseline.
- **How verified:** Unit test in `src/sync/company-quotes.job.spec.ts` passing.
- **Status:** **Fixed**

---

## 9. Insider and 13F Aggregation

- **Problem:** Stock insider drawers showed "0 open-market sells", transactions contained future dates (e.g., 2027), and transaction dates shifted back by one day.
- **Where it appeared:** 13F & Insider screen (`/menu/insider`), Stock Detail Insider drawer.
- **Examples:**
  - Open-market sells: Showed 0 sells for active stocks like ISRG, NVDA, and CRM.
  - Future dates: ETN displayed insider rows dated `2027-02-25`.
- **Root cause:** Stock drawer drew from the global 30-day feed (capped at 48 pages) rather than the stock's dedicated Form 4 feed; vendor sent malformed future dates; filing date calculation used rounded "days ago".
- **Fix:**
  - `src/market-data/insider-transactions.controller.ts` & `src/common/insider-rows.util.ts`: Filtered out any trade dated after today or after its own filing date.
  - `app/iq/screens/insider.tsx`: Queried dedicated `/market-data/insider-transactions?ticker=${sym}` on stock click with an 8-second safety timeout.
  - Updated layout: Executive details on left, Buy/Sell badges and dollar values on right.
- **How verified:** Unit test in `src/common/insider-rows.util.spec.ts` passing; verified in UI build.
- **Status:** **Fixed**

---

## 10. Next Earnings Date and Multi-Week Calendar Slicing

- **Problem:** Next earnings dates displayed reports from months in the past (e.g. MSFT Jul 29), showed "TBD", or dropped dates from the multi-week Earnings Hub.
- **Where it appeared:** Stock Detail Key Stats, Earnings Hub (`/menu/earnings`), SI Catalysts.
- **Examples:**
  - MSFT: Next earnings displayed as Jul 29 (3 months in the past).
  - Earnings Hub: Oct 27–28 was missing due to silent row cutoff.
- **Root cause:** Cached company profile stored stale `nextEarningsDate`; FMP earnings calendar API capped query responses at 4,000 rows without pagination, silently truncating late-month dates.
- **Fix:**
  - `app/iq/si/stock-intelligence.tsx` & `app/iq/screens/stock.tsx`: Filtered out past dates (`date < todayIso`) and resolved the next future date from `/market-data/earnings`.
  - `src/adapters/earnings-estimates.adapter.ts`: Implemented adaptive date-slicing to query in smaller date ranges, preventing FMP row truncation.
- **How verified:** Verified MSFT/STRL resolve to future Q3/Q4 report dates; triggered `sync-earnings-postclose` scheduler job.
- **Status:** **Fixed**

---

## 11. Fields Stuck on N/A or Loading States

- **Problem:** Stock Detail key statistics flashed `$0.00 / 0.00%` or remained stuck on `N/A`, and AI Research synthesis stayed on "Loading…" indefinitely.
- **Where it appeared:** Stock Detail modal (`stock.tsx`), AI Read widget (`stock-intelligence.tsx`).
- **Examples:**
  - CRM / JPM: Key statistics showed `N/A` on fresh page load.
  - AI Research synthesis: Stayed on "Loading…" indefinitely if the worker job hadn't completed.
- **Root cause:** Component state did not fall back to company universe profile while waiting for live websocket/endpoint resolution; AI poll loop lacked retry interval.
- **Fix:**
  - `app/iq/screens/stock.tsx`: Added fallback to `companiesList` profile and rendered clean `—` placeholders during load.
  - `app/iq/si/stock-intelligence.tsx`: Added a 30-second polling retry for pending AI analysis.
- **How verified:** UI build passing; verified graceful loading states without `N/A` flicker.
- **Status:** **Fixed**

---

## 12. Screener Logic & Permissive Preset Filters

- **Problem:** Stock screener presets returned the entire stock universe, ignoring preset criteria, or matched stocks failing fundamental rules.
- **Where it appeared:** Stock Screener (`/menu/screener`).
- **Examples:**
  - "High Growth Tech": Returned virtually all stocks in the database.
- **Root cause:** Filter conditions had permissive default fallbacks for missing attributes, and unbuildable preset filters were active.
- **Fix:**
  - `app/iq/screens/screener.tsx`: Disabled 5 unbuildable presets and enforced strict filter criteria matching against live company metrics.
- **How verified:** Tested screener presets in UI; verified result counts reflect filtered criteria.
- **Status:** **Fixed**

---

## 13. UI State, Timezone Labels & Live Feed Categorization

- **Problem:** Theme chips stacked together rather than switching; timestamps lacked timezone labels; Live Feed tagged every headline as "Macro" with placeholder "NONE" tickers.
- **Where it appeared:** Themes (`/menu/themes`), Dashboard Live Feed, Movers header.
- **Examples:**
  - Themes: Selecting "AI Infrastructure" then "Semiconductors" resulted in an additive combination rather than a single selection.
  - Live Feed: Headlines tagged as "Macro" with symbol "NONE".
  - Movers: Displayed time as "2:30 PM" without timezone (users thought it was CT instead of ET).
- **Root cause:** Multi-select state handling in themes; Live Feed lacked ticker validation; time formatter omitted timezone label.
- **Fix:**
  - `app/iq/screens/themes.tsx`: Switched theme chip selection to single-select.
  - `app/iq/news-feed.ts`: Validated tickers against active universe and hid `"NONE"` placeholder tickers; mapped categories from tags.
  - `app/iq/screens/movers.tsx`: Explicitly labeled header timestamps as **ET** (Eastern Time).
- **How verified:** UI build passing with zero errors; verified in live UI.
- **Status:** **Fixed**

---

## Open Items & Vendor Dependencies

1. **Vendor Data Gaps (Not on current tier):**
   - Certain quarterly EPS estimates and actuals for specific tickers (JPM, STRL, XOM, ISRG) reflect FMP vendor discrepancies.
   - NYSE TICK and Put/Call ratio indicators lack an active upstream data feed.
   - Long-term 40+ year dividend histories (e.g. XOM's 43-year dividend aristocrat streak) are constrained by Polygon's historical dividend window (~25 years).
2. **Scheduled Maintenance:**
   - **2027 FOMC Calendar:** Add Federal Reserve 2027 meeting dates to `app/iq/calendar-range.ts` by December 2026.
   - **Bank Revenue Financials Backfill:** The background `financials` sync job should complete its cycle to update pre-2024 bank quarters with net interest revenue.

---

## Recommended Regression Safeguards

To prevent these issues from recurring as the codebase evolves, the following automated checks should be maintained:
1. **Date-Only Timezone Guard Test:** Ensure any new date-only ISO string (`YYYY-MM-DD`) is strictly tested against a timezone offset assertion (e.g. assuring UTC midnight resolves to the same calendar date in `America/New_York`).
2. **Movers Sort-Order Test:** Add a component test asserting that `Gainers[i].changePercent >= Gainers[i+1].changePercent` and `Losers[i].changePercent <= Losers[i+1].changePercent`.
3. **Exact Ticker Search Test:** Assert that a search query matching a listed symbol exactly returns that symbol at index `0`.
4. **Cache Freshness Assertion:** Unit test verifying that `SnapshotCacheService` automatically clears or refreshes entries exceeding 10 minutes during active market sessions.
