# FMP Integration — Plan, Status & Runbook

**Financial Modeling Prep (FMP)** is a *supplementary* vendor that fills gaps
Polygon structurally cannot. It is wired behind per-domain adapter seams
(`<DOMAIN>_SOURCE` env vars). Each seam defaults to `"none"` in code, but in
**production several are LIVE** (see the ownership table below) — the app is no
longer a Polygon-only build.

> **⏱ State sync — 2026-08-21 · FMP tiers LIVE in prod · sector is NOT FMP · /stable API · news is a market-wide merge**
>
> Corrections vs the earlier (2026-08-16) version of this doc:
> - **The FMP seams are ON in prod**, not "off by default": `deploy/env.production.yaml`
>   sets `EARNINGS_ESTIMATES_SOURCE=fmp`, `ANALYST_SOURCE=fmp`,
>   `NEWS_FMP_SOURCE=fmp`, `ECON_CALENDAR_SOURCE=fmp`, and
>   `SECTORS_FALLBACK_SOURCE=fmp`.
> - **A company's SECTOR/INDUSTRY is NOT from FMP.** It is derived from the SEC
>   **SIC code** through the **TradingView / RBICS taxonomy** (`classifyFromSic`
>   in `src/common/sic-tv.util.ts` + `src/common/tv-taxonomy.ts`). FMP
>   `getCompanyProfile()` is still fetched in the profile / mover-enrichment /
>   ipos / on-demand paths, but its GICS `sector` is **deliberately not used** —
>   `classifyFromSic` wins. The older GICS/SPDR scheme in
>   `src/common/sic-sector.util.ts` (`sectorFromSic`, `resolveSector`,
>   `normalizeFmpSector`, `CRYPTO_TICKERS`, `looksCrypto`) is now **dead code**
>   with zero production call sites — safe to delete.
> - **API surface is `/stable/` only.** The legacy `/api/v3` + `/api/v4` paths
>   are deprecated and return 403. All method references below use `/stable/`.
> - **News is a market-wide head-fetch merge**, not a per-ticker cursor sweep —
>   see §3 Tier 1C.
> - **Deploy is manual `gcloud`, not git push** — see §4 Runbook.
>
> **Ownership rule (enforce in review):** FMP supplies earnings estimates &
> actuals, analyst ratings & price targets, economic-calendar releases,
> institutional (13F) ownership, earnings-call transcripts, a *merged* news feed
> (under Polygon), and sector-PERFORMANCE aggregates as a fallback. It **NEVER**
> supplies price, OHLCV bars, snapshots, corporate actions, or the sector
> *classification* of a company. Those stay Polygon / SEC-EDGAR / SIC-taxonomy
> owned so there is a single source of truth.

---

## 1. What FMP fills

### LIVE in prod

| Domain | FMP role | Env toggle | `/stable/` endpoint(s) → `FmpService` method | Where it lands |
|---|---|---|---|---|
| **Earnings estimates + surprises + actuals** | Primary (Polygon has no estimate feed) | `EARNINGS_ESTIMATES_SOURCE=fmp` | `earnings-calendar` → `getEarningsCalendar`; `earnings-surprises` → `getEarningsSurprises`; forward `analyst-estimates` → `getForwardAnnualEstimates` | `earnings_events.epsEstimate/revenueEstimate`; `financials.quarters.epsEstimate` (→ %surp), `financials.annualEstimates` (forward `*YYYY` rows) |
| **Analyst ratings / consensus / price targets** | Primary (`analyst-actions` job was a no-op) | `ANALYST_SOURCE=fmp` | `grades-consensus`→`getAnalystConsensus`; `grades`→`getGrades`; `price-target-*`→`getPriceTargetConsensus`/`getPriceTargetSummary`/`getPriceTargets` | `analyst_actions/{ticker}` |
| **News (merged with Polygon)** | Second feed, deduped by URL (Polygon wins) | `NEWS_FMP_SOURCE=fmp` | `news/stock-latest`→`getLatestStockNews`; `news/stock`→`getStockNews` | `news` (each article badged `vendor`) |
| **Economic calendar (forward releases)** | Adds the forward release schedule FRED lacks | `ECON_CALENDAR_SOURCE=fmp` | `economic-calendar`→`getEconomicCalendar` | `macro_events` (alongside FRED series) |
| **Institutional (13F) ownership** | Sole source (Polygon 404s, SEC-EDGAR is raw) | *(always on when `FMP_API_KEY` set)* | `institutional-ownership/*`→`getInstitutionalOwnership`/`getLatestInstitutionalOwnership` | `institutional_ownership/{ticker}`; `companies.instOwnershipPct` (on-demand) |
| **Earnings-call transcripts** | Sole source | *(on-demand)* | `earning-call-transcript*`→`getEarningsTranscript`/`getTranscriptDates`/`getLatestEarningsTranscript` | `earnings_transcripts/{ticker}` via `/live/earnings-transcript` |
| **Sector PERFORMANCE aggregates** | **Fallback only** (Polygon primary) | `SECTORS_FALLBACK_SOURCE=fmp` | `sector-performance-snapshot`→`getSectorPerformance` | `sectors` (only when Polygon fails) |

### NOT handled by FMP (kept on Polygon / SEC-EDGAR / FRED / local)
Price · OHLCV bars · snapshots · **news-of-record** (Polygon) · dividends/splits ·
IPOs (Polygon) · Form 4 / 13F positions / 8-K / S-1 filings & the SIC code
(SEC-EDGAR) · macro series (FRED) · technical indicators (RSI/MACD/SMA/EMA/
stochastic/RVOL/RS/tech-rating — locally computed) · **sector/industry
classification** (SIC → TradingView taxonomy, see the callout above).

---

## 2. Design — how it stays isolated & removable

Every FMP feature sits behind a `<DOMAIN>_SOURCE` (+ optional
`<DOMAIN>_FALLBACK_SOURCE`) env var, resolved in `src/adapters/adapters.module.ts`
by `buildComposite(...)`. It instantiates the primary adapter and wraps it in a
`Composite*Adapter(primary, secondary)`; `"none"` (or fallback == primary) yields
a single-source composite while keeping every implementation registered and
switchable by env var. Execution semantics live in `with-fallback.util.ts`:
`withFallback()` tries primary, records a `SourceAttempt` on throw, falls to
secondary if configured, tags `FALLBACK_USED`, and raises `AllSourcesFailedError`
only when nothing resolves. An opt-in `isEmpty` predicate makes a resolved-but-
empty primary a *soft* failure that triggers fallback.

- **Only `SECTORS`** uses `POLYGON_OR_FMP_SOURCES` (a real vendor fallback). The
  opt-in seams `EARNINGS_ESTIMATES` / `ANALYST` / `NEWS_FMP` / `ECON_CALENDAR`
  are `["fmp","none"]` tokens consumed directly by their jobs (not composites).
- Vendor client: `src/vendors/fmp/fmp.service.ts` + `fmp.module.ts`. `/stable/`
  API, `?apikey=` auth (auto-redacted by `common/http.util.ts`), request pacing
  via `pace()`, self-disabling `enabled` getter when `FMP_API_KEY` is unset.
- To remove FMP entirely: set every `*_SOURCE` back to `none`, then delete
  `src/vendors/fmp/` and the FMP adapter files. Nothing else depends on them.

---

## 3. Status (all ✅ done + LIVE in prod unless noted)

### Tier 1A — Earnings estimates / surprises / forward rows
`earnings-estimates.adapter.ts` (`EARNINGS_ESTIMATES_ADAPTER`). `earnings.job`
overlays `epsEstimate`/`revenueEstimate` onto `earnings_events`; `earnings-actuals.job`
backfills reported actuals; `financials.job` (and the on-demand `getFinancials`)
prefer `getEarningsSurprises()` for full-history %surp and store forward
`annualEstimates` from `getForwardAnnualEstimates()` (the dimmed `*YYYY` rows in
`EpsSalesWidget`). Full-US forward calendar: FMP calendar symbols are reconciled
against the Polygon `tickers` reference, keeping US CS/ADRC listings.
⚠ Sales %surp stays "—" (the surprises endpoint is EPS-only).

### Tier 1B — Analyst ratings, consensus & price targets
`analyst-ratings.adapter.ts` (`ANALYST_RATINGS_ADAPTER`). `analyst-actions.job` is
a **full-universe sweep** (no cursor) that upserts `analyst_actions/{ticker}` with
consensus vote tallies, per-firm grade changes (`getGrades`), and price-target
posts (`getPriceTargets`, joined to grades by firm).

### Tier 1C — News (market-wide merge)
`FmpService.getLatestStockNews()` / `getStockNews()`; `fmp-news.adapter.ts`
(`NEWS_FMP_ADAPTER`, `NEWS_FMP_SOURCE=fmp`). **`news.job` no longer sweeps
per-ticker.** It does a **market-wide head-fetch**: `fetchMarketNews(from,to)` on
the Polygon primary, then FMP, then a (currently inert) TradingView adapter,
merges all, groups by *tracked* ticker, dedupes by URL (Polygon wins), and keeps
`ARTICLES_PER_TICKER = 8` newest. Runs every 10 min. Each article carries
`vendor` (`polygon`|`fmp`) + `sentiment`; the `/live/news` on-demand path writes
`vendor` too.
⚠ Redistribution licensing for serving FMP news to users was flagged and
**accepted by the user** — the deliberate exception to the Polygon-only-to-users
rule. ⚠ FMP `sentiment` is frequently null.

### Tier 1D — Economic calendar
`getEconomicCalendar()` consumed by `macro-events.job` (`ECON_CALENDAR_SOURCE=fmp`)
to add the forward US release schedule + estimates on top of FRED's realized
series in `macro_events`.

### Tier 1E — Institutional ownership & transcripts
`institutional-ownership.job` (cursor) writes `institutional_ownership/{ticker}`
from `getLatestInstitutionalOwnership()`. Earnings-call transcripts are on-demand
only (`/live/earnings-transcript` → `getLatestEarningsTranscript()`), cached in
`earnings_transcripts` (caches "none" too).

### Tier 2A — Sector performance (FALLBACK only)
`FmpSectorsAdapter` wired into `SECTORS_ADAPTER` via `POLYGON_OR_FMP_SOURCES`;
`SECTORS_FALLBACK_SOURCE=fmp` fires only when Polygon's aggregate fails.
⚠ FMP's GICS sector labels differ from the ETF-proxy labels the UI matches on —
that is why it is fallback-only, and why it is **not** the source of company
sector *classification*.

### ❌ NOT used — company sector via FMP GICS profile
`getCompanyProfile()` is fetched in the profile / mover / ipos / on-demand paths
but its `sector` is intentionally discarded. Sector/industry come from
`classifyFromSic` (TradingView taxonomy). The `sic-sector.util.ts` GICS scheme
(`resolveSector`/`CRYPTO_TICKERS`) is dead code.

---

## 4. Runbook — enable / verify / remove

> **⚠ Deploy is manual `gcloud`, NOT git push.** The production worker
> (`market-catalyst-backend`) and read API (`market-catalyst-live`) are both
> deployed with `gcloud run deploy --source .` in **us-central1**. A `git push`
> only rebuilds the near-dormant App Hosting service `market-catalyst-be`
> (us-east4), which runs almost nothing. See the top of `deploy/DEPLOY.md`.

**Enable a seam**
1. **Secret:** `FMP_API_KEY` must be bound on **both** us-central1 services.
   `--set-secrets` REPLACES the whole set, so it must list all four keys —
   `POLYGON_API_KEY,FMP_API_KEY,FINNHUB_API_KEY,FRED_API_KEY` — or FMP silently
   drops and every seam disables with no error (`FmpService.enabled=false`).
2. **Flip the source** in `deploy/env.production.yaml` (e.g.
   `EARNINGS_ESTIMATES_SOURCE: "fmp"`). Absent/`"none"` = OFF.
3. **Deploy** the worker (and live, reusing the image or `--source .`):
   ```bash
   gcloud run deploy market-catalyst-backend --source . --region us-central1 --project market-catalyst-502415
   gcloud run deploy market-catalyst-live    --source . --region us-central1 --project market-catalyst-502415
   ```
4. **Trigger + verify** (worker; needs a `gcloud auth print-identity-token`
   bearer — the worker trusts IAM):
   ```bash
   TOK=$(gcloud auth print-identity-token)
   curl -X POST -H "Authorization: Bearer $TOK" \
     https://market-catalyst-backend-741318166823.us-central1.run.app/sync/earnings/run
   ```
   Check the job log / `GET /sync/earnings/status` and the UI (%surp columns,
   analyst board, news vendor badges, etc.).

**Remove:** set `*_SOURCE` back to `none` and redeploy; for full removal delete
`src/vendors/fmp/` + the FMP adapters + their tokens/providers/injections.

---

## 5. Caveats
- **`/stable/` only** — v3/v4 return 403.
- **Sector is not FMP** — do not re-wire FMP GICS into classification; the SIC →
  TradingView map is the single classifier.
- **Symbol reconciliation** — key FMP responses to the Polygon universe; drop
  non-matching class-shares/delisted rows.
- **FMP `sentiment` frequently null**; sales %surp unavailable (EPS-only).
- **Secret drift** — the four-secret `--set-secrets` footgun above has bitten a
  deploy before; prefer the image-only deploy that inherits existing secrets.
- **Cost/rate** — `http.util` handles 429 backoff; FMP pacing via `pace()`. Stay
  within the plan tier.
