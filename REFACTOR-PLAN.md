# Refactor: Cache + sync-jobs → dynamic live-API architecture

**Branch:** `smishra/remove-chached-data` · **Env:** staging (commit only, never deploy)

## Goal
Remove the Firestore-cache + cron-sync-job architecture. Every `/market-data/*`
endpoint calls Polygon/FMP/FRED/SEC **live per request**. The UI shows a spinner
(`DataState`) during the added latency.

## Confirmed decisions
1. **Paid Polygon + FMP keys** are set in the stage `.env` (`POLYGON_PAGE_DELAY_MS`
   must be `0` on the paid key). FMP key wired (`FMP_API_KEY`).
2. **Coalescing window: 2–5s in-flight/short dedupe** — concurrent identical
   requests share ONE vendor call; a result is reused for ≤5s. This is NOT a
   stale cache (no cron, no Firestore, no long TTL) — it only prevents duplicate
   vendor calls under load.
3. **Wire FMP** for `earnings` (1-call calendar w/ estimates) and **analyst
   actions** (FMP has a ratings/grades endpoint — replaces the current no-op).
4. UI: fix `useApiResource` loading-on-path-change, then fill `DataState` gaps.

## Keep on Firestore (do NOT touch)
User data (watchlist, portfolio, notes, settings, profile, notifications),
plans, feature-flags, searched-ticker analytics, 13F drill-down positions.

## Delete (cache/worker machinery)
`SyncModule` (30 jobs), `PurgeModule`, `RetentionModule`, `AutoPurgeModule`,
`CachedCollectionsService`, `MarketDataService.ensureFresh`, `sync-meta`,
`sync-registry`, the `APP_ROLE=worker` deployment + Cloud Scheduler jobs
(collapse to one live service).

## Already live (no work)
All `/live/*` (company, financials, bars, quotes, dividend-history, splits,
news, options-chain, market-status, tape). They already use `OnDemandService`/
`TapeService` with request coalescing — this is the target pattern to reuse.

## Conversion tiers
**Tier A (trivial, few calls):** sectors, macro-events, macro-regime, market-sentiment.
**Tier B (market-wide, bounded):** movers, earnings (→FMP), ipos, dividends, fund-holdings.
**Tier C (hard — per-endpoint resolution):**
- `companies` → keep a lightweight ticker/profile reference (boot + lazy refresh), NOT a live per-request whole-universe pull. Per-ticker detail already via `/live/company`.
- `news` (global) → scope to a ticker set (e.g. movers' tickers), live.
- `recaps` → recompute from live movers/sectors per request, or drop.
- `earnings-announcements`, `filings-wire`, `insider-transactions` → convert to **per-ticker on-demand** (fast), not a global pre-crawled feed.
- `ipo-pipeline` → fetch+parse SEC master.idx live (moderate).
- `analyst-actions` → **wire FMP ratings endpoint** (no Polygon source).
- `market-sentiment-history` → compute live (SPY/TLT/VIXY 220d bars + breadth).

## Per-module recipe
1. `LiveXService` method: call vendor adapter + do the derived math (moved out of the job) + wrap in the 2–5s coalescer.
2. Rewrite controller: drop `ensureFresh`+`cached.get` → call `LiveXService`.
3. Delete `sync/<x>.job.ts`.
4. `curl` verify (real data, right shape). Commit.

## UI spinner work
- Fix `useApiResource`: on path change, reset `loading→true` and clear stale `data`.
- Add `loading` to the ~30 `DataState` omissions; wire it in heatmap, movers, ipos, earnings, commentary, recap, dashboard, stock screens.

## Order
1. UI spinner fix.
2. `sectors` (pattern-setter: LiveService + coalescer + controller + delete job).
3. Rest of Tier A → movers → rest of Tier B.
4. Tier C decisions one at a time.
5. Delete worker stack, collapse deploy, empty stale Firestore market-data collections.

## Status log
- [x] UI spinner fix (useApiResource loading-on-path-change)
- [x] sectors — live (Polygon), verified
- [x] macro-events — live (FRED), verified; needs FRED_API_KEY (now set in .env)
- [x] macro-regime — live (FRED), verified; degrades gracefully
- [x] market-sentiment (+ history) — live (Polygon), verified. History dropped the
      market_breadth join (3 price components/day; today keeps live breadth).
- [ ] movers (Tier B, flagship — next)
- [ ] earnings (FMP) / ipos / dividends / fund-holdings
- [ ] Tier C (companies, news, recaps, SEC feeds per-ticker, ipo-pipeline, analyst→FMP, sentiment-history)
- [ ] worker/deploy teardown (delete SyncModule+Purge+Retention+AutoPurge, collapse roles)

## Env notes (stage .env, gitignored)
- FMP_API_KEY, FRED_API_KEY, POLYGON_API_KEY set. POLYGON_PAGE_DELAY_MS=0.
- Reverted aspirational source values that the polygon-only AdaptersModule rejects
  (MOVERS_SOURCE, *_FALLBACK_SOURCE=fmp/finnhub → polygon/none). Re-enable `fmp`
  per-domain as each FMP adapter is built (earnings/analyst first).
