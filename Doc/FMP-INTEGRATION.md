# FMP Integration — Plan, Status & Runbook

**Financial Modeling Prep (FMP)** is a *supplementary* vendor that fills gaps
Polygon structurally cannot. It is wired behind opt-in adapter seams that default
to **off**, so the app runs identically to a Polygon-only build until each
domain is explicitly enabled.

> **Ownership rule (enforce in review):** FMP supplies **only** earnings
> estimates, analyst ratings, sector performance, and profile ratios. It NEVER
> supplies price, OHLCV bars, snapshots, news, or corporate actions — those stay
> Polygon-owned so there is a single source of truth for price.

---

## 1. What FMP fills

### Tier 1 — fills features that are *empty today* (high value)

| Gap | Why empty | FMP endpoint(s) | UI that lights up |
|---|---|---|---|
| **Earnings estimates + surprises** | Polygon has no estimate feed; `epsEstimate` is null everywhere | `/api/v3/earning_calendar` (bulk EPS/rev estimates), `/api/v3/analyst-estimates/{sym}` (forward) | Earnings-detail **%surp** columns, "Historical EPS beats", "What street expects", forward fiscal rows |
| **Analyst ratings / consensus** | `analyst-actions` job is a no-op (no vendor) | `/api/v4/upgrades-downgrades-consensus`, `/api/v3/price-target-consensus` | Analyst Actions screen + consensus card |

### Tier 2 — replaces computed/proxy data (polish, optional)

| Gap | Today | FMP endpoint(s) |
|---|---|---|
| **Sector performance** | 11-ETF proxy (`exchange:"ETF-proxy"`) | `/api/v3/sectors-performance` |
| **Profile ratios: beta / 52-wk / avg-vol / P·E** | computed from bars; some fields null in the profile adapter | `/api/v3/quote/{sym}`, `/api/v3/profile/{sym}`, `/api/v3/ratios-ttm/{sym}` |

### Not handled by FMP (kept on Polygon/SEC/FRED)
Price · OHLCV bars · snapshots · news · dividends/splits · IPOs · macro (FRED) ·
filings/Form 4/13F/8-K (SEC-EDGAR). Technical indicators (RSI/MACD/SMA/EMA/
stochastic/RVOL) stay locally computed — two vendors would just drift.

---

## 2. Design — how it stays isolated & removable

Every FMP feature sits behind a `<DOMAIN>_SOURCE` env var (default `"none"`),
resolved in `src/adapters/adapters.module.ts` the same way the existing
Polygon/none composites are. `"none"` ⇒ the adapter token resolves to `null` ⇒
the consuming job runs its original Polygon-only path.

- Vendor client: `src/vendors/fmp/fmp.service.ts` + `fmp.module.ts` (mirrors
  `vendors/fred/`). Dormant when `FMP_API_KEY` is unset.
- Auth: `?apikey=` query param (auto-redacted in logs by `common/http.util.ts`).
- To remove FMP entirely: set every `*_SOURCE` back to `none`, then delete
  `src/vendors/fmp/` and the FMP adapter files. Nothing else depends on them.

---

## 3. Status

### ✅ Phase 0 — Foundation (done)
- `src/vendors/fmp/fmp.service.ts`, `src/vendors/fmp/fmp.module.ts`
- Reads `FMP_API_KEY` / optional `FMP_API_BASE_URL`; `enabled` getter.

### ✅ Tier 1A — Earnings estimates (done, OFF by default)
- `src/adapters/earnings-estimates.adapter.ts` — `EarningsEstimatesAdapter`
  interface + `FmpEarningsEstimatesAdapter` (one bulk `/earning_calendar` call,
  nearest-date match within 21 days).
- `src/adapters/types.ts` — `EARNINGS_ESTIMATES_ADAPTER` token.
- `src/adapters/adapters.module.ts` — provider reads `EARNINGS_ESTIMATES_SOURCE`
  (default `none` → `null`); imports `FmpModule`.
- `src/sync/earnings.job.ts` — injects the token; overlays `epsEstimate` /
  `revenueEstimate` onto `earnings_events` when non-null, else unchanged.

**Data flow (no frontend change for %surp):**
`earnings_events.epsEstimate` (FMP) → `financials.job` `matchEstimate()` →
`financials/{ticker}.quarters.epsEstimate` → the widget's **%surp** columns.

**Full-history %surp:** the bulk `/earning_calendar` only covers ~180 days, so on
its own it fills %surp for the last ~1–2 quarters. `financials.job` therefore also
calls `EarningsEstimatesAdapter.getQuarterlyEstimates()` →
`FmpService.getEarningsSurprises()` (`/api/v3/earnings-surprises/{sym}`, full EPS
actual-vs-estimate history) and prefers it, with the earnings_events match as
fallback — so **every displayed quarter** gets an EPS %surp. (Sales %surp stays
"—": the surprises endpoint is EPS-only.)

### ✅ Tier 1B — Analyst ratings (done, OFF by default)
- `src/adapters/analyst-ratings.adapter.ts` — `AnalystRatingsAdapter` interface +
  `FmpAnalystRatingsAdapter` (`/api/v4/upgrades-downgrades-consensus`).
- `ANALYST_RATINGS_ADAPTER` token + provider (`ANALYST_SOURCE`, default `none`).
- `src/sync/analyst-actions.job.ts` — was a no-op; now, when the adapter is
  present, rotates a bounded batch over `activeUniverse` (cursor pattern, 120ms
  spacing) and upserts `analyst_actions/{ticker}` = `{ ticker, consensus,
  strongBuy, buy, hold, sell, strongSell, source, updatedAt }` — the exact shape
  `analyst.tsx` / `stock.tsx` read. When null it stays the historical no-op.

### ✅ Tier 2A — Sector performance (done, OFF by default)
- `FmpSectorsAdapter` in `src/adapters/sectors.adapters.ts`; wired into the
  existing `SECTORS_ADAPTER` composite via `POLYGON_OR_FMP_SOURCES`. Enable with
  `SECTORS_SOURCE=fmp` (real aggregates) or `SECTORS_FALLBACK_SOURCE=fmp`.
- ⚠ Check first: FMP's GICS sector labels may differ from the ETF-proxy labels
  the UI matches on.

### ⬜ Remaining / not recommended
- **Tier 2B — Profile ratios** (beta / 52-wk / avg-vol / P·E): **recommend
  skipping.** These are already computed by `technical-indicators.job` into
  `companies/{ticker}`, and the composite *fallback* seam only fires when Polygon
  *fails* — so FMP-as-fallback would not fill the profile adapter's nulls when
  Polygon succeeds. Doing it right needs a field-level *merge* (not the existing
  fallback pattern) for marginal value. Left unbuilt on purpose.
### ✅ Forward-estimate rows (`*YYYY`) (done, OFF by default)
- `FmpService.getForwardAnnualEstimates()` + `EarningsEstimatesAdapter.getForwardAnnual()`
  (`/api/v3/analyst-estimates?period=annual`).
- `financials.job` injects the estimates adapter; when present, stores
  `financials/{ticker}.annualEstimates`. Empty/absent when off.
- Frontend: `AnnualEstimate` type + `EpsSalesWidget` renders the forward rows
  (dimmed, `*`-marked) after the reported years, %chg vs the prior year.
- Rides the **same** `EARNINGS_ESTIMATES_SOURCE=fmp` switch as Tier 1A.

---

## 4. Runbook — enable / verify / remove

### Enable earnings estimates (Tier 1A)
1. **Secret** (App Hosting binding already exists in `apphosting.yaml:140-141`):
   ```bash
   firebase apphosting:secrets:set FMP_API_KEY
   ```
   For the Cloud Run worker path also add `FMP_API_KEY` to the secret loop and
   `--set-secrets` in `deploy/DEPLOY.md` (§2 / worker deploy).
2. **Flip the source** — add to `apphosting.yaml` env (and
   `deploy/env.production.yaml` for the Cloud Run path):
   ```yaml
   EARNINGS_ESTIMATES_SOURCE: "fmp"
   ```
   (Absent/`"none"` = OFF.)
3. **Deploy the backend** (separate from frontend hosting), then trigger:
   ```bash
   curl -X POST .../sync/earnings/run    # admin-guarded
   ```
4. **Verify**: the job log prints `… N with fmp estimates …`; the widget's
   %surp columns populate for reported quarters.

### Scheduling
No new Cloud Scheduler entry — production runs one `sync-premarket` job that
orchestrates `premarket.job.ts`, and `earnings` is already in its `MARKET_WIDE`
phase. New FMP-backed jobs just register (for `/sync/<job>/run`) and get added to
the appropriate phase array.

### Remove
- **Instant off:** set `*_SOURCE` back to `none` and redeploy.
- **Full removal:** delete `src/vendors/fmp/`, `src/adapters/earnings-estimates.adapter.ts`,
  the `EARNINGS_ESTIMATES_ADAPTER` token + provider, and the injection in
  `earnings.job.ts`.

---

## 5. Caveats
- **%surp / forward rows need estimates** — they stay `—`/absent until Tier 1A is
  enabled (and, for forward rows, until the frontend addition ships).
- **Symbol reconciliation** — key FMP responses to the Polygon `companies`
  universe; drop non-matching (class shares / delisted differ).
- **Cost/rate** — Tier-1 calls run once daily in premarket; `http.util` handles
  429 backoff. Stay within the FMP plan tier.

---

## 6. Effort estimate
| Phase | Status | Enable via | Value |
|---|---|---|---|
| 0 Foundation | ✅ done | — | required |
| 1A Estimates | ✅ done (off) | `EARNINGS_ESTIMATES_SOURCE=fmp` | ★★★ |
| 1B Analyst | ✅ done (off) | `ANALYST_SOURCE=fmp` | ★★★ |
| 2A Sector | ✅ done (off) | `SECTORS_SOURCE=fmp` (or `_FALLBACK_`) | ★ |
| 2B Profile ratios | ⬜ not recommended (redundant + needs merge) | — | ★ |
| Forward-rows (`*YYYY`) | ✅ done (off) | `EARNINGS_ESTIMATES_SOURCE=fmp` (same as 1A) | ★★ |

**All three shipped seams are OFF by default** (`*_SOURCE` absent ⇒ `none`).
Enabling any requires `FMP_API_KEY` set + the env var above + a **backend** deploy.
