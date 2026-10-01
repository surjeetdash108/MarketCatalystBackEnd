# Market Data Integrity Audit — MarketCatalyst

**Date:** 2026-08-17 · **Scope:** app.marketcatalyst.ai (US-market app; Polygon/FMP/FRED/SEC-EDGAR)
**Method:** Live backend value checks + independent external verification (CNN/Google/Yahoo/CNBC/Morningstar/companiesmarketcap) + end-to-end code lineage tracing (provider → backend → cache → adapter → frontend). Markets closed (weekend) — price checks are last-close vs last-close.

---

## A. Executive Summary

**Data-quality score: 74 / 100.**

The **core financial data layer (price, market cap, P/E, EPS, 52-week, dividend, growth) is trustworthy** — externally verified and internally disciplined. Two independent external checks (SNDK, MU) matched the backend near-exactly, *including* "impossible-looking" moves (SanDisk +40× / $243B, Micron +689% / $1.1T — both real AI/NAND-memory supercycle). P/E is internally consistent everywhere, negative EPS degrades to null (not Infinity), and there is no cross-company duplication.

**The real risks are in the plumbing, not the numbers:**
- A **stock-split re-adjustment gap** that silently corrupts window indicators (52w/SMA/EMA/MACD/beta/pivots) around a split until it rolls out of the window.
- **Two UI synthetic-data generators** (fabricated candlestick chart + fabricated sparklines) shown without a "simulated" label.
- Several **`?? 0` fallbacks** that turn missing→$0/0% (Portfolio Pulse value, detail header, screener RS filter).
- **Freshness never surfaced** on fundamentals/financials/bars (up to 20h stale, presented as current).
- **Frontend ticker-switch linger** (previous ticker's price shown briefly with no "delayed" marker).
- **Search homonym collisions** (short foreign names resolve to unrelated US securities).

| Question | Answer |
|---|---|
| Production safe? | **Yes, with fixes.** No widespread wrong prices; the scary anomalies verified as real. |
| Data safe? | **Mostly.** Numbers are right; the gaps are split-spanning indicators + unlabeled synthetic fallbacks + freshness. |
| UI safe? | **Mostly**, but it displays fabricated charts/sparklines and `$0` fallbacks without disclosure. |
| Critical blockers? | **None P0.** Top items are P1 (split re-adjust, synthetic chart, Portfolio Pulse $0). |

---

## B. Confirmed Bugs

### BUG-DATA-001 — Stock-split re-adjustment gap corrupts window indicators
- **Classification:** DERIVED-BUT-CORRUPTED · **Severity:** High (P1)
- **Field:** 52w high/low, SMA/EMA ladder, MACD, beta, realized vol, pivots, RS momentum
- **Root cause:** Bars fetched `adjusted=true` (`polygon.service.ts:178`), but `stock-history.job.ts` only fetches the forward window for already-backfilled tickers; the one-time deep backfill never re-runs (`needsDeepFill` requires `earliestSyncedFrom > floor`, and `planHistoryFloor()` is a rolling date that advances past it → permanently false). `corporate-actions.job.ts` detects splits but never resets the stock-history watermark/`earliestSyncedFrom`.
- **Consequence:** After a split, stored `ohlcv_bars` keep the *old* adjustment while new bars use the *new* one → any indicator spanning the split date blends two adjustment bases and is wrong until the split rolls out of the window (up to ~1yr for 52w, ~200d for SMA200).
- **Fix:** On split detection, reset `earliestSyncedFrom`/watermark for that ticker to force a full adjusted re-backfill; or re-fetch the full window on any detected corporate action.

### BUG-DATA-002 — Fabricated candlestick chart shown as real when history is thin
- **Classification:** FALLBACK ERROR (fabrication) · **Severity:** High (P1)
- **Field:** Stock detail price chart
- **Location:** `utils.tsx:483` + `genOHLC` (440-466). When the backend returns <2 bars, the chart renders a **seeded synthetic OHLC series** scaled to end at the real price. Only signal is the "live · Polygon" pill disappearing (`stock.tsx:1031`) — **no "simulated" label.**
- **Fix:** Render an explicit empty/"insufficient history" state; never draw a fabricated series. If kept for demo, label it "Simulated".

### BUG-DATA-003 — Portfolio Pulse understates value/P&L on unpriced holdings
- **Classification:** FALLBACK ERROR (missing→$0) · **Severity:** Medium (P1)
- **Location:** `dashboard.tsx:730-731` — `Σ shares × (price ?? 0)`; a holding whose price hasn't synced contributes **$0** to total value and day P&L, silently, no disclosure. (The full `portfolio.tsx:82,88-89` does this correctly by filtering to priced holdings and discloses coverage.)
- **Fix:** Mirror portfolio.tsx — exclude unpriced holdings and disclose "n of m priced".

### BUG-DATA-004 — Fabricated sparklines on every list row
- **Classification:** FALLBACK ERROR (fabrication) · **Severity:** Low-Medium (P2)
- **Location:** `utils.tsx:118-149` `sparkSVG`/`Spark` (movers/watchlist/portfolio/screener rows, `stock-panel.tsx:102`). The sparkline shape is a deterministic `_hash3(seed)` — **not real prices**; only up/down color is real. Reads as a mini trend but is fabricated.
- **Fix:** Use real recent bars, or drop the line and keep only the colored % change.

### BUG-DATA-005 — Screener RS=0 fallback pollutes the "RS < 40" laggard screen
- **Classification:** FALLBACK ERROR (missing→0 in a filter) · **Severity:** Low-Medium (P2)
- **Location:** `screener.tsx:36-44` (`rsRating ?? 0`), filter `rsLt40` (223). An **unsynced ticker (RS defaulted to 0) passes the "RS < 40" filter** and pollutes the weak/laggard list; the row also prints literal `RS 0` (414).
- **Fix:** Treat unsynced RS as null/excluded from RS filters; render "—" not "RS 0".

### BUG-DATA-006 — UI reconstructs EPS as price/PE instead of using stored EPS
- **Classification:** DERIVED-BUT-CORRUPTED · **Severity:** Low-Medium (P2)
- **Location:** `stock.tsx:761` — `eps = price / peRatio`, the inverse of the backend's own calc, dividing the *live* price by a P/E built on the *sync-time* price → circular + rounding-lossy. The correct `epsTtm`/`eps` is already available.
- **Fix:** Display the stored `epsTtm`/`eps` directly.

### BUG-DATA-007 — Detail header price `?? 0` → $0.00
- **Classification:** FALLBACK ERROR · **Severity:** Low (P2)
- **Location:** `stock.tsx:719-720` — `price: liveCompany?.price ?? 0`. If a company doc loads without a price, the flagship header shows **$0.00 / +0.00%** instead of a loading/N-A state.

### BUG-DATA-008 — Fundamentals/financials/bars show no freshness ("as of")
- **Classification:** STALE (unmarked) · **Severity:** Medium (P2)
- **Details:** Live price is labeled "delayed 15m", but fundamentals, financials, technicals, dividends, splits and the chart carry **no visible "as of."** The backend returns `asOf` on bars but the client **discards it** (`useBackendBars.ts:20-26`). TTLs allow up-to-20h-old fundamentals (`ondemand.service.ts:144-166`) plus `stale-while-revalidate` HTTP caching; market-wide lists on the stock page are fetched once. Stale data can be presented as current.
- **Fix:** Surface `asOf`/last-sync on each data block; re-poll or badge staleness.

### BUG-DATA-009 — Ticker-switch stale-linger with no freshness marker
- **Classification:** STALE / FALLBACK (frontend) · **Severity:** Medium (P2)
- **Location:** `useApiResource.ts:12-49` never resets `data`/`loading` when `path` changes. On switching `sym`, the previous ticker's price/financials/dividends/splits/news **remain displayed until the new fetch resolves**; the header symbol updates instantly (`stock.tsx:951`) while the price is still the old ticker's, and the "delayed" marker only shows when `livePrice != null`, so the stale price shows with **no freshness marker at all**.
- **Not a permanent contamination bug:** fast-switch races are guarded (`cancelled` cleanup), so A's data can only *lag*, never bind permanently to B. Backend caches are cleanly ticker-keyed (LOW risk).
- **Fix:** Reset `data`→null and `loading`→true on path change.

### BUG-DATA-010 — Search homonym collision returns unrelated US security
- **Classification:** MAPPING ERROR (latent) · **Severity:** Medium (P2)
- **Details:** Search does ticker-prefix + company-name substring matching (`ticker-search.service.ts:85-94`; `stock.tsx:667-671`). A user typing a foreign/short name can be shown an unrelated US security sharing the string (e.g. "RELIANCE" → US "Reliance Steel/Global"; "ITC"/"TCS" → whatever US symbol owns those letters) with no signal it's the wrong company.
- **Fix:** Rank exact-ticker matches first; show exchange/name prominently; consider a "did you mean" for ambiguous short names.

### BUG-DATA-011 — Fractional share volumes in recent bars
- **Classification:** WRONG (field-level anomaly) · **Severity:** Low-Medium (P2)
- **Field:** `volume` on bars (all tickers, recent ~half of the 1Y window)
- **Evidence:** e.g. SNDK bar volume `18,569,371.05639`; every ticker sweep showed ~122/252 bars with non-integer volume. Real market volume is whole shares (external SNDK vol ~21M integer).
- **Consequence:** Pollutes any volume-derived metric (RVOL, up/down volume, VWAP inputs). Prices verify fine, so severity is limited — but volume should never be fractional.
- **Fix:** Investigate the adjusted-volume path; round/store integer session volume.

### BUG-DATA-012 — Analyst per-firm price target: dead path + fragile join
- **Classification:** UNAVAILABLE (surfaced correctly) + latent MAPPING risk · **Severity:** Low (P2)
- **Details:** The historical "consensus reused as every firm's target" bug **is already fixed** (consensus PT is only shown at ticker level — VERIFIED). Per-firm PT is fetched from FMP `/price-target-news` (genuinely per-firm) and stored in `recentGrades[].priceTarget`, but **never rendered** in any table (dead path; wasted vendor spend). The firm↔target join (`analyst-ratings.adapter.ts:105-124`) matches on normalized firm name with a **prefix fallback** and **no max time window** → if ever surfaced, could attach the wrong firm's or a stale target.
- **Note:** True *per-individual-analyst* targets are **UNAVAILABLE** from FMP (firm-level is the finest granularity).
- **Fix:** Either surface per-firm PT with a tightened join (exact-name + date window), or drop the fetch.

### BUG-DATA-013 — Billing currency & price inconsistency
- **Classification:** WRONG (config inconsistency) · **Severity:** Low (P3)
- **Details:** Plan catalog is `currency: "USD"` (`plans.registry.ts:380,392,404`) while payment analytics default to **`"INR"`** (`admin-analytics.service.ts:266,311,353`). The manage-plan UI hardcodes `$19`/`$0` (`manage-plan.tsx:98,124`), mismatching the registry's `$29.99`/`$49.99`.
- **Fix:** Single source of truth for plan price + currency.

---

## C. Incorrect Data

| Ticker | Field | Backend | Reference | Verdict |
|---|---|---|---|---|
| (all) | bar `volume` (recent) | fractional (e.g. 18,569,371.056) | integer | WRONG (field anomaly, BUG-011) |
| SNDK | price | $1,796.15 | ~$1,657 current (ext.) | ~8% high → minor STALE (not wrong) |

No systematically wrong prices/valuations were found. Everything else checked (AAPL, MSFT, NVDA, GOOGL, AMZN, META, TSLA, AMD, WDC, SNDK, INFY, MU, INTC, JPM, XOM, KO, WMT, DIS, BA, F, PLTR, ZIM, CSCO, ORCL, CRM) is internally consistent and, where externally checked (SNDK, MU), verified correct.

## D. Unavailable Data (correctly unavailable — NOT bugs unless misrepresented)

| Field | Source limit | Status |
|---|---|---|
| Per-individual-analyst price target | FMP plan (firm-level floor) | UNAVAILABLE (UI correctly shows firm-level) |
| NSE/BSE (Indian domestic) listings & INR prices | Polygon = US only | UNAVAILABLE (returns 404 no-data) |
| NYSE TICK, Put/Call composite | Not on Polygon plan | UNAVAILABLE (shown as N/A — correct) |
| Quarterly revenue estimate (sales est/surprise) | Not in quarterly pipeline | UNAVAILABLE (shown "—" — correct) |

## E. Stale Data

| Ticker | Field | TTL / behavior | Status |
|---|---|---|---|
| any | fundamentals/financials/dividends/splits | 20h TTL, no "as of" shown | STALE-capable, unmarked (BUG-008) |
| any | chart bars | `asOf` returned but discarded by UI | STALE-capable, unmarked (BUG-008) |
| any | stock-page market-wide lists | fetched once, no refresh | STALE on long sessions (BUG-008) |
| switched ticker | price/financials | linger until new fetch, no marker | transient STALE (BUG-009) |
| SNDK | price snapshot | ~8% above independent current | minor STALE |

## F. Derived Data Problems

- **Correct calc + correct inputs (VERIFIED):** P/E (backend, Infinity/negative-guarded, TTM), EPS TTM (null if <4 quarters), dividend yield (TTM & forward; avoids the ×4 single-dividend mistake), YoY/QoQ growth (annual periods, no TTM/annual mixing), RSI/ADX/beta/MACD/pivots/realized-vol (textbook, null-guarded), 52w high/low backend (`slice(-252)` max/min of intraday H/L).
- **Correct calc + BAD inputs (DERIVED-BUT-CORRUPTED):** all window indicators around a split (BUG-001).
- **Incorrect calc / circular (DERIVED-BUT-CORRUPTED):** UI `eps = price/peRatio` reconstruction (BUG-006).
- **Timeframe/labeling:** UI 52w derives separately from `useBackendBars(1Y)` with only `length>1` guard → **2–251 bars still labeled "52-week"** (thin-history mislabel).
- **Calculation nuance (low):** backend `ema()` seeds with raw first value (warm-up bias) while UI `ema()` seeds with SMA(n) → same ticker's MA ladder differs slightly between backend and UI drawer.

## G. Mapping / Contamination Problems

- **Backend:** clean — all caches/coalescing keyed per ticker; no cross-serve (LOW).
- **Frontend:** ticker-switch **linger** (stale price, no marker) — BUG-009. No permanent A→B mis-assignment (races guarded).
- **Search:** homonym collision → wrong US security for short/foreign names — BUG-010.
- **Analyst:** consensus-as-firm reuse **already fixed**; firm↔target join fragile but currently unrendered — BUG-012.

## H. Vendor / API Limitations

| Field | Provider supplies? | Backend stores? | Frontend displays? | Verified? |
|---|---|---|---|---|
| Price / prevClose / OHLC | Polygon ✓ | ✓ | ✓ | ✓ (SNDK,MU ext.) |
| Market cap | Polygon (details) ✓ | ✓ | ✓ | ✓ (SNDK,MU exact) |
| 52w high/low | derived from bars | ✓ | ✓ | ✓ |
| EPS TTM / P/E | Polygon/FMP ✓ | ✓ | ✓ | ✓ (internally) |
| Consensus price target | FMP ✓ | ✓ | ✓ (ticker-level) | ✓ |
| Per-firm price target | FMP ✓ | ✓ | ✗ (dead path) | n/a |
| Per-analyst (person) target | ✗ | ✗ | ✗ | UNAVAILABLE |
| NSE/BSE / INR | ✗ | ✗ | ✗ | UNAVAILABLE |
| NYSE TICK / Put-Call | ✗ | ✗ | N/A shown | UNAVAILABLE |
| Quarterly revenue estimate | ✗ (this pipeline) | ✗ | "—" shown | UNAVAILABLE |
| currency_name | Polygon ✓ | ✓ | ✗ (dropped) | — |

## I. UI Problems (display, separate from data)

- Fabricated chart (BUG-002) and sparklines (BUG-004) shown without "simulated" label.
- `$0.00` fallbacks (BUG-003, 007) instead of loading/N-A.
- No "as of" on most data blocks (BUG-008); stale price on switch has no marker (BUG-009).
- Currency: `$` hardcoded everywhere; no currency field ever shown (LOW realized ∵ US-only universe, MEDIUM design). A non-USD security would render `$` with no conversion.
- Manage-plan price mismatch $19/$0 vs $29.99/$49.99 (BUG-013).

## J. Test Coverage

| Feature | Tested | Passed | Failed | Blocked |
|---|---|---|---|---|
| Price / prevClose / OHLC bars | ✓ | ✓ | — | — |
| 52w high/low | ✓ | ✓ (backend) | labeling caveat | — |
| Market cap | ✓ | ✓ (ext. verified) | — | — |
| P/E / EPS | ✓ | ✓ | UI eps=price/PE | — |
| Dividend yield/annualization | ✓ | ✓ | — | — |
| YoY/QoQ growth | ✓ | ✓ | — | — |
| Technical indicators/pivots | ✓ (code) | ✓ | split-span (BUG-001) | live recompute |
| Analyst consensus / actions | ✓ | ✓ | per-firm dead path | — |
| Analyst per-firm PT | ✓ | — | dead path + join | — |
| Cross-ticker contamination | ✓ | backend ✓ | frontend linger | — |
| Currency | ✓ | US-only ok | design/billing | — |
| Universe (Indian) | ✓ | — | UNAVAILABLE / homonym | — |
| Freshness surfacing | ✓ | price ✓ | fundamentals/bars | — |
| Fallback patterns | ✓ | mostly ✓ | 6 `??0` sites | — |
| Corporate actions (live split) | ✓ (code) | — | BUG-001 | live split event |

## K. Priority Fix List

- **P0:** none (no widespread wrong data; scary anomalies verified real).
- **P1:** BUG-001 (split re-adjustment), BUG-002 (synthetic chart unlabeled), BUG-003 (Portfolio Pulse $0).
- **P2:** BUG-004 (sparklines), BUG-005 (screener RS=0 filter), BUG-006 (UI eps=price/PE), BUG-007 (header $0), BUG-008 (freshness), BUG-009 (switch linger), BUG-010 (homonym search), BUG-011 (fractional volume), BUG-012 (analyst per-firm join).
- **P3:** BUG-013 (billing currency), EMA seed, 52w thin-history label, statement line `??0`.

---

## Final Answers

**What is trustworthy?** The core price / market-cap / P/E / EPS / 52-week / dividend / growth data — externally verified (SNDK, MU matched near-exactly) and internally consistent. Backend derivation math and null-handling are disciplined. Backend caching is cleanly ticker-keyed.

**What is wrong?** Fractional bar volumes (field anomaly); billing currency/price config inconsistency; the UI's circular eps=price/PE reconstruction.

**What is stale?** Fundamentals/financials/bars can be up to ~20h old with no "as of"; stock-page lists fetched once; transient stale price on ticker switch — all unmarked.

**What is unavailable from our providers?** Per-individual-analyst price targets; NSE/BSE (Indian) domestic listings & INR; NYSE TICK / composite Put-Call; quarterly revenue estimates. (All currently surfaced correctly as N/A/"—".)

**What is incorrectly derived?** Any window indicator (52w/SMA/EMA/MACD/beta/pivots/RS) spanning a stock split, until it rolls out of the window (BUG-001); the UI eps=price/PE reconstruction (BUG-006); minor EMA seed divergence.

**What is incorrectly reused across tickers/firms?** Nothing currently rendered — the consensus-as-firm bug was already fixed; backend is ticker-keyed. Latent risks: frontend stale-linger on switch, and the unrendered per-firm PT join.

**What should be hidden or marked N/A instead of displayed?** The fabricated candlestick chart and sparklines (label "simulated" or remove); `$0.00` price fallbacks (show loading/N-A); stale data blocks (add "as of").

**What must be fixed before this app is trusted for investment research?** P1 items: (1) split re-adjustment so indicators aren't silently corrupted around corporate actions; (2) stop rendering fabricated chart/sparkline data as real; (3) Portfolio Pulse must not value unpriced holdings at $0. Then P2 freshness surfacing + ticker-switch reset, so users can tell how current each number is.
