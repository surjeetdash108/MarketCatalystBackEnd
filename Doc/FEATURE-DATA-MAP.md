# MarketCatalyst — Feature & Data Source Map

**Generated:** 2026-07-20 · **Scope:** every user-facing feature in MarketCatalystUI, traced to its data source, the vendor behind it, and a free alternative where one exists.

---

## 0. How to read this document

### Source classification

| Tag | Meaning |
|---|---|
| **LIVE** | Read from Firestore, populated by a backend sync job from a real vendor API. |
| **HYBRID** | Live data overlays a hardcoded base row. Specific numeric fields (price, %chg, market cap) are real; descriptive fields (catalyst text, narrative, session) stay static. **Falls back silently** unless noted. |
| **STATIC** | A hardcoded array/object in the frontend. Never touches a vendor. |
| **GENERATED** | Numbers fabricated in the browser by arithmetic or a seeded PRNG, rendered as if real. |
| **USER** | Data the user entered, persisted to Firestore under `users/{uid}/…`. |
| **NONE** | Pure UI — navigation, layout, filters over already-fetched data. |

### Verification status of claims in this document

| Marker | Meaning |
|---|---|
| ✅ **VERIFIED** | Confirmed by reading source code, or by calling the live endpoint on 2026-07-20. |
| ⚠️ **UNVERIFIED** | From vendor documentation knowledge, not tested against a live key. **Pricing and free-tier limits change — confirm before relying on any of these.** |

Everything in Parts A and B is ✅ unless marked. Free-tier claims in Part C are ⚠️ except where a probe result is quoted.

---

## 1. Executive summary

| Metric | Count |
|---|---|
| Screens audited | 19 + app shell + public landing page |
| Features catalogued | ~185 |
| Sync jobs in the backend | 21 |
| Firestore collections written | 21 |
| Data vendors wired and in use | 5 (Polygon/Massive, FMP, Finnhub, FRED, SEC EDGAR) |
| Vendor services present but **not wired** | 3 (Benzinga, Tradier, Unusual Whales) |
| API keys declared but unused in code | 3 (`ANTHROPIC_API_KEY`, `ALPHAVANTAGE_API_KEY`, `MEDIASTACK_API_KEY`) |

**Headline finding:** roughly **one third** of what the app displays is LIVE. The rest is STATIC or GENERATED, and with three exceptions the UI does not tell the user which is which. See Part D.

---

## Part A — Vendor & API reference

### A.1 Polygon / Massive — primary market-data vendor

- **Base URL:** `https://api.massive.com` (env `POLYGON_API_BASE_URL`; code default is still `https://api.polygon.io`, which resolves but is being phased out after the Oct 2025 rebrand)
- **Auth:** `?apiKey=***` query parameter
- **Plan:** Stocks Starter — unlimited request rate, 5 years history, 15-minute delayed, **no** trades/quotes tick data, **no** Options or Indices entitlement
- **Throttle:** `POLYGON_PAGE_DELAY_MS`, set to `0` in production (paid tiers are unlimited; verified empirically 2026-07-20 — 12 parallel requests, zero 429s). Code default is `12500` for the free tier.

| Endpoint | Purpose | Key request params | Response fields read | Feeds collection |
|---|---|---|---|---|
| `GET /v3/reference/tickers` | Ticker universe | `market=stocks`, `active`, `limit=1000`, paginated via `next_url` | `ticker, name, market, locale, primary_exchange, type, active, currency_name, cik, composite_figi, share_class_figi` | `tickers` |
| `GET /v3/reference/tickers/{ticker}` | Company profile | — | `name, market_cap, sic_code, sic_description, primary_exchange, description` | `companies` |
| `GET /v2/aggs/ticker/{t}/range/1/day/{from}/{to}` | Daily OHLCV | `adjusted=true`, `sort=asc` | `t, o, h, l, c, v` | `ohlcv_bars`, `market_indices`, `sectors` |
| `GET /v2/aggs/grouped/locale/us/market/stocks/{date}` | Whole-market daily snapshot | — | `T, o, c, v` | `tickers` (quotes), `market_movers`, `market_sentiment` |
| `GET /v3/reference/dividends` | Dividend calendar | `ex_dividend_date.gte/.lte`, `limit=1000` | `id, dividend_type, ticker, ex_dividend_date, record_date, pay_date, declaration_date, cash_amount, frequency` | `dividends` |
| `GET /vX/reference/ipos` | IPO calendar | `listing_date.gte/.lte`, `limit=1000` | `ticker, issuer_name, primary_exchange, listing_date, lowest_offer_price, highest_offer_price, final_issue_price, max_shares_offered, total_offer_size, ipo_status` | `ipos` |
| `GET /v2/reference/news` | Company news | `ticker`, `published_utc.gte/.lte`, `order=desc`, `limit=10` | `id, title, description, publisher.name, article_url, keywords, published_utc, image_url, insights[].{ticker,sentiment,sentiment_reasoning}` | `news` |
| `GET /v3/reference/options/contracts` | Options contracts | `underlying_ticker`, `expiration_date.gte`, `limit=20` | `ticker, contract_type, strike_price, expiration_date` | `options_chains` |
| `GET /vX/reference/financials` | Income statements | `timeframe=annual\|ttm`, `limit` | `fiscal_year`, `financials.income_statement.{revenues, cost_of_revenue, gross_profit, diluted_earnings_per_share}.value` | `companies` |

**Documented limitations (from code comments):**
- No dividend yield, no peer lists — structurally `null` on this source.
- No sector taxonomy — sector is derived from `sic_code` via `sectorFromSic()`, approximate.
- **No sector endpoint on any tier** — `sectors` is derived from 11 SPDR sector ETFs, not true cap-weighted aggregates.
- Options: strikes/expirations and last close/volume are real (delayed); **bid/ask, IV, greeks, open interest are not available on this plan**.
- `/vX/reference/financials` is Polygon's **experimental** namespace. The replacement `/stocks/financials/v1/*` requires Advanced or the Financials add-on, so it cannot be upgraded on Starter and may break without deprecation notice.

### A.2 FMP (Financial Modeling Prep)

- **Base URL:** `https://financialmodelingprep.com/stable` — **hardcoded**, no env override
- **Auth:** `?apikey=***`

| Endpoint | Purpose | Response fields read | Feeds |
|---|---|---|---|
| `GET /earnings-calendar` | Earnings calendar | `symbol, date, epsActual, epsEstimated, revenueActual, revenueEstimated` | `earnings_events` |
| `GET /grades-consensus` | Analyst consensus | `strongBuy, buy, hold, sell, strongSell, consensus` | `analyst_actions` |
| `GET /profile` | Company profile | `companyName, price, changePercentage, marketCap, beta, sector, industry, exchange, range, volume, averageVolume, description` | `companies` |
| `GET /ratios-ttm` | Valuation ratios | `priceToEarningsRatioTTM, netIncomePerShareTTM, dividendYieldTTM, dividendPerShareTTM` | `companies` |
| `GET /stock-peers` | Peer list | `symbol[]` | `companies` |
| `GET /biggest-gainers`, `/biggest-losers` | Movers | `symbol, price, changesPercentage` | `market_movers` |
| `GET /dividends-calendar` | Dividends | `symbol, date, recordDate, paymentDate, declarationDate, dividend, yield, frequency` | `dividends` |
| `GET /sector-performance-snapshot` | Sector performance | `date, sector, exchange, averageChange` | `sectors` |

**Limitations:**
- Movers endpoints **do not report volume** — no minimum-volume filter possible on this source; `volume` is written as `0`.
- `ratios-ttm` failures are logged as "likely this plan's undocumented per-symbol restriction."
- ⚠️ **Earnings calendar coverage is severely limited on the current plan.** Probed live 2026-07-20: `from=2026-07-20&to=2026-07-24` returned **10 rows**; `limit=1000` changed nothing; a single day (Jul 22) returned **2 rows**. See §C.3 — this is the single biggest data-quality gap in the app.
- **No session field.** The response contains only `symbol, date, epsActual, epsEstimated, revenueActual, revenueEstimated, lastUpdated`. Before Open / After Close cannot be sourced here.

### A.3 Finnhub

- **Base URL:** `https://finnhub.io/api/v1` — hardcoded
- **Auth:** `?token=***`
- **Currently used for:** news (aggregated with Polygon), IPO fallback, quote fallback

| Endpoint | Purpose | Response fields read | Feeds |
|---|---|---|---|
| `GET /company-news` | Company news | `id, headline, summary, source, url, datetime, category, image` | `news` |
| `GET /calendar/ipo` | IPO calendar | `ipoCalendar[].{date, symbol, name, exchange, price, numberOfShares, totalSharesValue, status}` | `ipos` (fallback) |
| `GET /quote` | Real-time quote | `c, d, dp, o, h, l, pc, t` | `market_indices` (fallback) |

**Limitation:** `/company-news` has no sentiment or keyword fields — structurally null on this source.

**Two endpoints available on the existing key but NOT currently wired** (both probed live 2026-07-20):

| Endpoint | Probe result | What it would unlock |
|---|---|---|
| `GET /calendar/earnings` | **488 rows** for Jul 20–24 vs FMP's 10. Fields: `symbol, date, hour, quarter, year, epsEstimate, epsActual, revenueEstimate, revenueActual`. `hour` values across the sample: `bmo`=138, `amc`=169, blank=181. | **~49× the earnings coverage**, plus the **Before Open / After Close session field** and fiscal quarter/year. |
| `GET /stock/recommendation` | Returns a **monthly time series** per symbol: `{symbol, period, strongBuy, buy, hold, sell, strongSell}` | Analyst-rating **history** — FMP's `grades-consensus` is a single snapshot with no history. |

### A.4 FRED (St. Louis Fed) — macro

- **Base URL:** `https://api.stlouisfed.org/fred` — hardcoded · **Auth:** `?api_key=***`
- `GET /series/observations?series_id={id}&file_type=json&sort_order=desc&limit=2` → `observations[].{date, value}` (`.` sentinel → `null`) → `macro_events`
- **Note:** FRED has no consensus/estimate concept, so `estimate` is always written `null`.
- **Free and authoritative. No alternative needed** — this is the correct source.

### A.5 SEC EDGAR — insider & institutional

- **Base URLs:** `https://data.sec.gov/submissions`, `https://www.sec.gov/Archives/edgar/data` — hardcoded
- **Auth:** none. Requires a `User-Agent` header identifying the caller (SEC policy) — env `SEC_EDGAR_USER_AGENT`. Throttled to ≥150ms between requests.

| Endpoint | Purpose | Feeds |
|---|---|---|
| `GET /submissions/CIK{10-digit}.json` | Filing index per company | `fund_holdings`, `insider_transactions` |
| `GET /Archives/edgar/data/{cik}/{accession}/index.json` | Locate filing documents | both |
| `GET /Archives/.../{infoTable}.xml` | 13F holdings (parsed) | `fund_holdings/{cik}/filings/{acc}/positions` |
| `GET /Archives/.../{form4}.xml` | Form 4 insider transactions | `insider_transactions` |
| `GET https://www.sec.gov/files/company_tickers.json` | Ticker→CIK map | (in-memory) |

**Free and authoritative. No alternative needed.**
⚠️ **Code-quality note:** the last endpoint is called by a raw `fetch()` **inside `sec-form4.job.ts` itself**, bypassing `SecEdgarService` and `fetchJson()` — so it gets no retry/backoff and no URL redaction on error. Worth routing through the vendor service.

### A.6 Adapter fallback chains

Configured per domain via `<NAME>_SOURCE` / `<NAME>_FALLBACK_SOURCE`:

| Adapter | Chain (`.env.example`) |
|---|---|
| `COMPANY_PROFILE_ADAPTER` | polygon → fmp |
| `MOVERS_ADAPTER` | fmp → polygon |
| `MOVER_ENRICHMENT_ADAPTER` | polygon → fmp |
| `NEWS_ADAPTER` | **aggregate** — polygon + finnhub called concurrently, merged, deduped by URL/headline |
| `DIVIDENDS_ADAPTER` | polygon → fmp |
| `IPOS_ADAPTER` | polygon → finnhub |
| `SECTORS_ADAPTER` | polygon → fmp |
| `QUOTE_ADAPTER` | polygon → finnhub |
| `MARKET_BARS_ADAPTER` | polygon only |
| `TICKER_UNIVERSE_ADAPTER` | polygon only |
| `FINANCIALS_ADAPTER` | polygon only |

**Not behind adapters** (single-vendor, no fallback, by design): FMP for earnings + analyst-actions, Polygon for fear-greed/market-quotes/options-chains, FRED for macro, SEC EDGAR for 13F/Form 4.

### A.7 Sync job → collection map

| Job | Cron (ET) | Writes | Vendor |
|---|---|---|---|
| `ticker-universe` | `0 3 * * 0` | `tickers` | Polygon |
| `market-quotes` | `7 18 * * 1-5` | `tickers` (merge) | Polygon |
| `companies` | `0 2 * * *` | `companies` | Polygon → FMP |
| `stock-history` | `0 3 * * *` | `ohlcv_bars` | Polygon |
| `rs-rating` | `0 4 * * *` | `companies` (merge) | **none — computed from `ohlcv_bars`** |
| `technical-indicators` | `10 4 * * *` | `companies` (merge) | **none — computed** |
| `tech-rating` | `15 4 * * *` | `companies` (merge) | **none — computed** |
| `fundamentals-growth` | `30 4 * * *` | `companies` (merge) | Polygon (experimental namespace) |
| `market-indices` | `5 18 * * 1-5` | `market_indices`, `market_indices_history` | Polygon → Finnhub |
| `market-movers` | `0 18 * * 1-5` | `market_movers`, `market_movers_history` | FMP → Polygon |
| `sectors` | `0 18 * * 1-5` | `sectors`, `sectors_history` | Polygon (ETF proxy) → FMP |
| `news` | `*/30 9-16 * * 1-5` | `news` (+ per-user notifications) | Polygon + Finnhub |
| `earnings` | `0 6 * * *` | `earnings_events` | FMP |
| `analyst-actions` | `0 6 * * *` | `analyst_actions` | FMP |
| `dividends` | `20 6 * * *` | `dividends` | Polygon → FMP |
| `ipos` | `15 6 * * *` | `ipos` | Polygon → Finnhub |
| `macro-events` | `10 18 * * 1-5` | `macro_events` | FRED |
| `fear-greed` | `15 18 * * 1-5` | `market_sentiment` | Polygon (computed) |
| `options-chains` | `0 19 * * 1-5` | `options_chains` | Polygon |
| `sec-13f` | `0 1 * * *` | `fund_holdings/**` | SEC EDGAR |
| `sec-form4` | `30 1 * * *` | `insider_transactions` | SEC EDGAR |

---

# Part B — Screen-by-screen, feature-by-feature

**One section per screen. One row per feature.** Every row carries its own type, source, provider, endpoint and alternative — nothing is deferred to another part of this document.

Column meanings:
- **Type** — API (live vendor data) · STATIC (hardcoded) · GENERATED (fabricated in-browser) · HYBRID (live overlaid on static) · USER (user-entered) · NONE (pure UI) · FAKE (simulates an action it does not perform)
- **Source** — the Firestore collection, const, or function actually supplying the value
- **Endpoint** — the vendor call behind it. `—` where no API is involved
- **Free alternative** — for API rows: another vendor for the same data. **For STATIC/GENERATED rows: what you would wire to make it real.** ⚠️ unverified unless marked ✅

---

## B.1 Dashboard — `app/iq/screens/dashboard.tsx` · **17 features**

Mission-control landing screen: summary cards, hover popovers, slide-in drawers.

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Market Pulse strip | HYBRID | `market_indices` over static `pulse` | Polygon → Finnhub | `/v2/aggs/ticker/{t}/range/1/day/…` | Finnhub `/quote` ✅ (already wired) · Twelve Data |
| 2 | "What Matters Now" AI feed | STATIC | `wmn` array | — | — | Anthropic API (`ANTHROPIC_API_KEY` already provisioned, unused) |
| 3 | 30-sec audio button | NONE | no handler | — | — | Any TTS (ElevenLabs, Google TTS) |
| 4 | Earnings Today | HYBRID | `earnings_events` (EPS only) | FMP | `/stable/earnings-calendar` | **Finnhub `/calendar/earnings` ✅ 488 vs 10 rows** |
| 5 | Movers card (3 tabs) | HYBRID | `market_movers` | FMP → Polygon | `/stable/biggest-gainers`, `/losers` | Polygon grouped-daily ✅ (already the fallback) |
| 6 | Heatmap mini-grid | HYBRID | `companies` + `sectors` | Polygon | `/v3/reference/tickers/{t}` | FMP `/sector-performance-snapshot` ✅ |
| 7 | Analyst Actions | HYBRID | static `analyst` + live consensus pill | FMP | `/stable/grades-consensus` | **Finnhub `/stock/recommendation` ✅ (adds history)** |
| 8 | Screener leaders/laggards | STATIC | `screenerStocks` | — | — | Derive from `companies` (already synced) |
| 9 | Portfolio Pulse | HYBRID/USER | `users/{uid}/portfolios/default/holdings` | — | — | — (user data; prices from `companies`) |
| 10 | Watchlist card | HYBRID/USER | `users/{uid}/watchlists/default` | — | — | — |
| 11 | Insider & Institutional | HYBRID | `insider_transactions` + `INSIDER_MINI_MOCK` | SEC EDGAR | `/submissions/CIK{n}.json` | — already optimal (free, authoritative) |
| 12 | Live Market Feed | HYBRID | `news`, falls back `MOCK_LIVE_FEED` | Polygon + Finnhub | `/v2/reference/news`, `/company-news` | Marketaux · GDELT · publisher RSS |
| 13 | Recaps card | GENERATED | one-line `.txt` blob labeled "PDF" | — | — | Anthropic API + a real PDF lib |
| 14 | VIX card | HYBRID | `market_indices` VIX; falls back `14.18` | Polygon | `/v2/aggs/ticker/VIXY/…` | CBOE delayed · Finnhub `/quote` |
| 15 | Fear & Greed gauge | HYBRID | `market_sentiment/fear_greed`; falls back `62` | Polygon (computed) | grouped-daily | CNN unofficial endpoint (keep in-house) |
| 16 | Hover popups | — | derived from rows above | — | — | — |
| 17 | Market Internals + F&G History drawers | STATIC | `MARKET_INTERNALS`, `FG_HISTORY` | — | — | Compute breadth from Polygon grouped-daily (already synced) |

---

## B.2 Stock Detail — `app/iq/screens/stock.tsx` · **18 features**

Full single-stock page: chart, ratings, financials, peers, dividends, notes.

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Symbol search + watchlist star | STATIC/USER | `SYMBOLS`; star → **`localStorage`** | — | — | Migrate star to Firestore |
| 2 | Header price/name/sector | HYBRID | `companies` | Polygon → FMP | `/v3/reference/tickers/{t}` | Finnhub `/stock/profile2` |
| 3 | Price chart | HYBRID | `ohlcv_bars` **3M/6M/1Y only**; else `genOHLC()` | Polygon | `/v2/aggs/ticker/{t}/range/1/day/…` | Stooq (free CSV) · Tiingo · Twelve Data |
| 4 | RSI pane | GENERATED | `RsiPane` sine wave | — | — | Compute from `ohlcv_bars` (already synced) |
| 5 | EPS surprise pane | GENERATED | `earnHistory()` hash | — | — | Finnhub `/calendar/earnings` ✅ history |
| 6 | Chart pattern callout | GENERATED | canned phrase on `isUp` | — | — | Anthropic API |
| 7 | Chart notes | USER | `stock_comments` | — | — | — |
| 8 | Keystats grid | HYBRID | `companies` + formulas; Short Int. static | Polygon | `/v3/reference/tickers/{t}` | FINRA short-interest files (free) |
| 9 | AI Technical Analysis | GENERATED | template string | — | — | Anthropic API |
| 10 | Financials chart | GENERATED | `earnIncome()` invented ratios | — | — | **SEC XBRL `companyconcept` (free, authoritative)** |
| 11 | Earnings Growth chart | GENERATED | `earnHistory()` | — | — | SEC XBRL · Finnhub |
| 12 | Technical Rating | HYBRID | `companies.rsi14/macd`; **MA counts always static** | computed in-house | — | — (already computed from bars) |
| 13 | Peers list | GENERATED | change = `(rs-50)/10` | — | — | FMP `/stable/stock-peers` ✅ (already called) |
| 14 | Industry Group rank | STATIC | `sectorList` | — | — | Derive from `companies.sector` |
| 15 | Dividend history | GENERATED | formulas; ex-div from `charCodeAt(0)` | — | — | Polygon `/v3/reference/dividends` ✅ (already synced!) |
| 16 | Earnings history | GENERATED | `BEAT_STREAK` + `earnHistory()` | — | — | Finnhub `/calendar/earnings` ✅ |
| 17 | Insider & institutional | HYBRID | `insider_transactions`; ownership static | SEC EDGAR | `/submissions/CIK{n}.json` | Derive ownership from `fund_holdings` (already synced) |
| 18 | Key levels (pivots) | GENERATED | fixed multiples `p*1.03` | — | — | Compute from `ohlcv_bars` high/low |

---

## B.3 Earnings Hub — `app/iq/screens/earnings.tsx` · **9 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Embedded Earnings Calendar | API | see B.4 | FMP | `/stable/earnings-calendar` | **Finnhub ✅** |
| 2 | Selected-company detail card | HYBRID | **BUG — falls back to `EARN_CAL[0]`=AMD** | FMP | `/stable/earnings-calendar` | Finnhub ✅ (adds session, quarter) |
| 3 | Company bio | STATIC | `COMPANY_BIO` (42 entries) | — | — | `companies.description` ✅ (already synced) |
| 4 | EPS history chart | GENERATED | `earnHistory()` | — | — | Finnhub `/calendar/earnings` ✅ |
| 5 | Income statement chart | GENERATED | `earnIncome()` | — | — | SEC XBRL (free) |
| 6 | AI earnings read | GENERATED | template string | — | — | Anthropic API |
| 7 | Earnings call drawer | STATIC | `CALLS_DATA` hand-written | — | — | FMP transcripts (paid) · API Ninjas |
| 8 | AI analysis modal | STATIC | `CALLS_DATA` | — | — | Anthropic API |
| 9 | Open full stock page | NONE | navigation | — | — | — |

---

## B.4 Earnings Calendar — `app/iq/screens/earnings-calendar.tsx` · **6 features**

**The only fully-live screen.** No mock fallback by design — an empty day renders empty.

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Date navigator + Day/Week toggle | NONE | client state | — | — | — |
| 2 | Filter bar (Cap/Sort/View/Has news/Today) | NONE | client-side over fetched rows | — | — | — |
| 3 | Upcoming IPOs block | API | `ipos` | Polygon → Finnhub | `/vX/reference/ipos` | Finnhub `/calendar/ipo` ✅ (already fallback) |
| 4 | Day table | API | `earnings_events` ⋈ `companies` ⋈ `news` | FMP | `/stable/earnings-calendar` | **Finnhub ✅ — would restore session column** |
| 5 | Week grid | API | same, reshaped | FMP | same | Finnhub ✅ |
| 6 | News count badge | API | `news` | Polygon + Finnhub | `/v2/reference/news` | Marketaux · GDELT |

**Columns omitted for lack of any data source:** Before Open/After Close (FMP has no session field — **Finnhub does**), Typical move, Guidance, Reaction.

---

## B.5 Movers — `app/iq/screens/movers.tsx` · **7 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Tab bar + "N live" counter | HYBRID | aggregate of #5 | FMP → Polygon | — | — |
| 2 | Trending across reports | GENERATED | days = `2 + charCodeAt(0)%4` | — | — | Compute from `news` frequency |
| 3 | Sector / cap filters | NONE | client filter | — | — | — |
| 4 | Sector tally pills | HYBRID | count over #5 | — | — | — |
| 5 | Movers table | HYBRID | `market_movers` + `companies.rvol`; **catalyst / MA posture / week% / tech context always static** | FMP → Polygon | `/stable/biggest-gainers`, `/losers` | Polygon grouped-daily ✅ (has volume; FMP does not) |
| 6 | Intraday sparkline | GENERATED | seeded random walk | — | — | Polygon intraday aggs (needs plan check) |
| 7 | Stock detail drawer | — | embeds B.2 | — | — | — |

---

## B.6 Screener — `app/iq/screens/screener.tsx` · **6 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Preset filter chips | STATIC | `screenerPresets` | — | — | — (legitimate config) |
| 2 | Manual filter groups | NONE | client filter; **some checkboxes are disabled no-ops** | — | — | — |
| 3 | Save screen | USER | **`localStorage`** | — | — | Migrate to Firestore |
| 4 | Match count + "N live" | HYBRID | aggregate of #5 | — | — | — |
| 5 | Results list | HYBRID | `companies` overlays cap/PE/RS/tech/rvol/growth | Polygon + computed | `/v3/reference/tickers/{t}`, `/vX/reference/financials` | SEC XBRL for fundamentals |
| 6 | Chart + detail panel | GENERATED | `stock-panel.tsx` — **never passes real bars** | — | — | Thread `useOhlcvBars` through (data already synced) |

---

## B.7 Watchlist — `app/iq/screens/watchlist.tsx` · **5 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Add stock + modal | USER | `users/{uid}/watchlists/default` (`arrayUnion`); **local-only when signed out, no warning** | — | — | — |
| 2 | AI watchlist summary | GENERATED | template + hardcoded "Nasdaq +1.02%, S&P 500 +0.73%" | — | — | Anthropic API; index values from `market_indices` ✅ |
| 3 | Watchlist rows | HYBRID/USER | watchlist doc ⋈ `companies` | Polygon | `/v3/reference/tickers/{t}` | Finnhub `/quote` |
| 4 | Remove-stock modal | USER | `arrayRemove` | — | — | — |
| 5 | Chart + detail panel | GENERATED | `stock-panel.tsx` synthetic | — | — | Thread real bars |

---

## B.8 Portfolio — `app/iq/screens/portfolio.tsx` · **8 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | **Import from photo** | **FAKE** | `setTimeout` → hardcoded `NVDA 15 / AAPL 120 / MSFT 60`; **no image is read** while UI says "Scanning image with AI…" | — | — | Anthropic API vision (key already provisioned) |
| 2 | Add holding + modal | USER | `users/{uid}/portfolios/default/holdings/{ticker}` | — | — | — |
| 3 | AI portfolio summary | GENERATED | template | — | — | Anthropic API |
| 4 | Holdings list + total | HYBRID/USER | holdings ⋈ `companies` | Polygon | `/v3/reference/tickers/{t}` | Finnhub `/quote` |
| 5 | Shares input | STATIC/USER | `DEFAULT_SHARES` merged with user `shares` | — | — | — |
| 6 | Totals write-back | USER | writes `totalValue/dayPL/dayPLPct` | — | — | — |
| 7 | Remove-holding modal | USER | `deleteDoc` | — | — | — |
| 8 | Chart + detail panel | GENERATED | `stock-panel.tsx` synthetic | — | — | Thread real bars |

---

## B.9 Heatmap — `app/iq/screens/heatmap.tsx` · **4 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Stocks / S&P 500 tabs | NONE | **dead control** — state set, never read | — | — | — |
| 2 | Color legend | NONE | static legend | — | — | — |
| 3 | Treemap | HYBRID | `companies` + `sectors` over static `sectorList` universe | Polygon | `/v3/reference/tickers/{t}` | FMP `/sector-performance-snapshot` ✅ |
| 4 | Hover tooltip | HYBRID/STATIC | Price/RVOL/MA from **static `movers`**, not the live-merged list | — | — | Use the live-merged list already on-screen |

---

## B.10 Themes — `app/iq/screens/themes.tsx` · **4 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Theme filter pills | STATIC | `THEMES` — frozen prices (NVDA pinned `$1181.75`) | — | — | — (basket definitions are legitimate config) |
| 2 | AI theme summary | GENERATED | template despite "◆ AI theme summary" | — | — | Anthropic API |
| 3 | Constituents list | HYBRID | `companies` overlays frozen prices | Polygon | `/v3/reference/tickers/{t}` | Finnhub `/quote` |
| 4 | Chart + detail panel | GENERATED | `stock-panel.tsx` synthetic | — | — | Thread real bars |

---

## B.11 Macro — `app/iq/screens/macro.tsx` · **10 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Market regime card | STATIC | hardcoded "Risk-On Rally" | — | — | Anthropic API + `market_indices` |
| 2 | VIX card | STATIC | hardcoded `14.18 / ▼-2.51%` — **Dashboard's VIX card is live** | — | — | `market_indices` VIXY ✅ (already synced) |
| 3 | Economic calendar | HYBRID | `macro_events`; silent fallback to hardcoded arrays | FRED | `/series/observations` | — already optimal (free, authoritative) |
| 4 | Live Economic Indicators ✅labeled | API | `macro_events` | FRED | `/series/observations?series_id=…&limit=2` | — |
| 5 | Dividend calendar (Day/Week tabs) | API | `dividends` | Polygon → FMP | `/v3/reference/dividends` | FMP `/dividends-calendar` ✅ (has yield) |
| 6 | Dividend calendar — **Month tab** | STATIC | reads only `DIV_STOCKS`, never live | — | — | Point at `dividends` ✅ (already synced) |
| 7 | Live Dividend Calendar ✅labeled | API | `dividends` | Polygon | `/v3/reference/dividends` | Finnhub `/stock/dividend` |
| 8 | VIX Sensitive Stocks | STATIC | `VIX_STOCKS` beta/IV30 | — | — | `companies.beta` ✅ (already synced) |
| 9 | 10-yr dividend history chart | GENERATED | `divHistory()` decays by symbol hash | — | — | Polygon `/v3/reference/dividends` historical range |
| 10 | Dividend CAGR / streak | HYBRID | streak correctly `null`→"—" for live rows | Polygon | `/v3/reference/dividends` | — |

---

## B.12 Insider & 13F — `app/iq/screens/insider.tsx` · **12 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Most-active-by-$ chips | HYBRID | `insider_transactions` + `BUYERS`/`SELLERS` | SEC EDGAR | `/submissions/CIK{n}.json` | — already optimal |
| 2 | Insider activity table ✅labeled | HYBRID | merged feed; live rows pilled | SEC EDGAR | Form 4 XML | — |
| 3 | Insider stock drawer | HYBRID | live filings + `insiderHistory()` **generated, unlabeled** | SEC EDGAR | Form 4 XML | Widen the EDGAR lookback instead of generating |
| 4 | Most-active institutional chips | GENERATED | `instMeta()` hash-fabricated | — | — | Derive from `fund_holdings` ✅ (already synced) |
| 5 | Institutional activity table | GENERATED | `INST_DATA` fabricated | — | — | Derive from `fund_holdings` ✅ |
| 6 | Top tracked funds ✅labeled | HYBRID | `fund_holdings` fuzzy-matched onto static `funds` | SEC EDGAR | 13F info-table XML | — |
| 7 | Institutional drawer | STATIC+GENERATED | `mutualFunds()`, `instQuarters()` | — | — | `fund_holdings/{cik}/filings/*/positions` ✅ |
| 8 | AI 13F Summary | STATIC | hardcoded, frozen at "Berkshire · Q1 2024" | — | — | Anthropic API over `fund_holdings` |
| 9 | Cross-fund signals | STATIC | `CROSS_OWN`/`CROSS_SOLD`/`CROSS_LONE` | — | — | Compute from `fund_holdings` ✅ (#10 already does) |
| 10 | Live overlap (CUSIP-matched) ✅labeled | API | `fund_holdings/{cik}/filings/{acc}/positions` | SEC EDGAR | 13F XML | — |
| 11 | View toggle | NONE | — | — | — | — |
| 12 | Filter & sort bars | NONE | — | — | — | — |

---

## B.13 Options — `app/iq/screens/options.tsx` · **5 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Stock search sidebar | STATIC | `movers` + `EXTRA_STOCKS` | — | — | `tickers` ✅ (already synced) |
| 2 | Stock header | STATIC | same list | — | — | `companies` ✅ |
| 3 | Expiry date tabs | STATIC | `EXPS` | — | — | `options_chains.contracts[].expirationDate` ✅ |
| 4 | Options chain table ✅labeled | GENERATED | `buildChain()` sinusoidal PRNG | — | — | **Tradier (token already provisioned, unwired)** · CBOE delayed · Alpaca |
| 5 | Live Options Reference ✅labeled | API | `options_chains` | Polygon | `/v3/reference/options/contracts` | Tradier — adds bid/ask, IV, greeks, OI that Polygon's plan lacks |

---

## B.14 Analyst — `app/iq/screens/analyst.tsx` · **7 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Tabs | NONE | — | — | — | — |
| 2 | Cluster alert card | STATIC | `computeClusters()` over static `analyst` | — | — | Finnhub `/stock/recommendation` ✅ history |
| 3 | Multiple-upgrades card | STATIC | same | — | — | Finnhub ✅ |
| 4 | Live consensus card ✅labeled | API | `analyst_actions` | FMP | `/stable/grades-consensus` | **Finnhub `/stock/recommendation` ✅ (adds monthly history)** |
| 5 | AI take · cluster | STATIC | hardcoded paragraph | — | — | Anthropic API |
| 6 | Filter bar | NONE | — | — | — | — |
| 7 | Full actions table | HYBRID | static `analyst` (**real firm names, invented ratings/PTs**) + live pill | FMP | `/stable/grades-consensus` | Benzinga (paid, key unwired) for real per-firm actions |

---

## B.15 Commentary — `app/iq/screens/commentary.tsx` · **9 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Tabs | NONE | — | — | — | — |
| 2 | Ticker search + suggestions | STATIC | `stockInfo`/`screenerStocks`/`movers` | — | — | `tickers` ✅ |
| 3 | Main feed | HYBRID | `news` + hardcoded `PREMARKET`/`AFTERHOURS`; live pilled | Polygon + Finnhub | `/v2/reference/news`, `/company-news` | Marketaux · GDELT · RSS |
| 4 | Quick lookup / tracked chips | STATIC | fixed list or `watch`/`folio` | — | — | — |
| 5 | Before the Bell | STATIC | hardcoded copy | — | — | Anthropic API over `news` |
| 6 | After the Close | STATIC | hardcoded copy | — | — | Anthropic API |
| 7 | General perspective | STATIC | hardcoded "Risk-On Rally… VIX at 14" | — | — | `market_indices` ✅ + Anthropic |
| 8 | News history drawer ✅labeled | HYBRID | `news` + `buildNewsHistory()` generated | Polygon + Finnhub | `/company-news` | Widen the news lookback |
| 9 | "No company associated" drawer | NONE | informational | — | — | — |

---

## B.16 EOD Recap — `app/iq/screens/recap.tsx` · **11 features**

⚠️ **Zero live wiring on this entire screen.** Always renders "Tuesday, May 21" content as today's recap.

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Today / This Week tabs | NONE | — | — | — | — |
| 2 | Hero headline + index chips | STATIC | `recap`, `WEEKLY` | — | — | `market_indices` ✅ |
| 3 | 60-sec audio recap | NONE | **no handler at all** | — | — | TTS vendor |
| 4 | Download PDF | GENERATED | one-line `.txt` blob | — | — | Real PDF lib |
| 5 | Key stories | STATIC | `recap.stories` | — | — | `news` ✅ + Anthropic |
| 6 | Up-next list | STATIC | `recap.tomorrow` | — | — | `earnings_events` + `macro_events` ✅ |
| 7 | News Briefing + social share | STATIC | `NEWS_DAILY`/`NEWS_WEEKLY`; footer claims "AI-generated" | — | — | Anthropic API over `news` |
| 8 | Sector heatmap | STATIC | `sectorList` (raw, not live-merged) | — | — | `sectors` ✅ |
| 9 | Biggest earnings movers | STATIC | `recap.movers` | — | — | `market_movers` ✅ |
| 10 | Market internals | STATIC | `recap.internals` | — | — | Compute from Polygon grouped-daily ✅ |
| 11 | Drill-down drawer | STATIC | `recap.movers` + `earnings` | — | — | — |

---

## B.17 IPOs — `app/iq/screens/ipos.tsx` · **6 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Stats strip | HYBRID | live rows have `cur`/`day1` = `null`, so stats **only populate from mock** | Polygon → Finnhub | `/vX/reference/ipos` | Join `ohlcv_bars` for aftermarket price ✅ |
| 2 | Sector filter ✅labeled | NONE | count line appends "· sample data" — **best-practice example** | — | — | — |
| 3 | Recent IPO performance table | HYBRID | live offer price; current/day1/return `—` | Polygon → Finnhub | `/vX/reference/ipos` | Join `ohlcv_bars` ✅ |
| 4 | Upcoming pipeline | STATIC | `PIPELINE` | — | — | SEC S-1/424B filings (free) |
| 5 | Live IPO Calendar ✅labeled | API | `ipos` | Finnhub | `/calendar/ipo` | Polygon `/vX/reference/ipos` ✅ (already primary) |
| 6 | Footnote | — | claims "SEC EDGAR + Polygon.io" — aspirational | — | — | — |

---

## B.18 Settings — `app/iq/screens/settings.tsx` · **8 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Account card | USER | Redux profile + Firebase Auth; "Pending" chip | — | — | — |
| 2 | Edit Profile / Sign Out | NONE | navigation | — | — | — |
| 3 | Dark-mode toggle | USER | `settings/{uid}.darkMode` + `localStorage` | — | — | — |
| 4 | Alerts toggle | USER | `settings/{uid}.alert` | — | — | — |
| 5 | Font picker | USER | `settings/{uid}.font` | — | — | — |
| 6 | Plan card | USER | `profile.tier` | — | — | — |
| 7 | **Schedule & share recap** | **FAKE** | shows "✓ Recap scheduled" for 4s; **no write, no email** | — | — | Cloud Scheduler + SendGrid/SES |
| 8 | Delete account | USER | real `deleteUser()`, typed-"DELETE" confirm | — | — | — |

---

## B.19 Manage Plan — `app/iq/screens/manage-plan.tsx` · **4 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Current Plan card | USER | `profile.tier` + Firebase Auth | — | — | — |
| 2 | Free/Premium pricing cards | STATIC | hardcoded $0/$19; **buttons have no `onClick`** | — | — | Stripe |
| 3 | Feature comparison table | STATIC | `FEATURES` | — | — | — (legitimate copy) |
| 4 | Billing & Support | NONE | **all three buttons have no handlers** | — | — | Stripe billing portal |

---

## B.20 App Shell — `app/iq/shell.tsx` + `notification-bell.tsx` · **16 features**

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Ticker marquee | HYBRID | `market_indices` over static `pulse` | Polygon | `/v2/aggs/…` | Finnhub `/quote` |
| 2 | Nav rail | STATIC | `menuItems` | — | — | — (legitimate config) |
| 3 | Command ⌘K search | HYBRID | live `tickers` query + `SEARCHABLE_STOCKS` | Polygon | `/v3/reference/tickers` | SEC `company_tickers.json` (free) |
| 4 | Notification bell | API | `users/{uid}/notifications` | Polygon + Finnhub (via news job) | `/v2/reference/news` | — |
| 5 | Theme toggle | USER | `settings/{uid}` | — | — | — |
| 6 | **AI Copilot** | GENERATED | 4 hardcoded replies cycled; panel claims "Connected to your portfolio · live data" | — | — | **Anthropic API (key provisioned, unused)** |
| 7 | Profile avatar + dropdown | HYBRID | Redux profile + Auth `photoURL` | — | — | — |
| 8 | Market status pill | GENERATED | browser clock, not an exchange feed | — | — | Polygon `/v1/marketstatus/now` ⚠️ |
| 9 | Nav clock "ET" | GENERATED | `new Date()` labeled ET **without timezone conversion** | — | — | `Intl.DateTimeFormat` w/ `America/New_York` |
| 10 | Stock drawer | STATIC | `movers`/`screenerStocks` | — | — | `companies` ✅ |
| 11 | Earnings drawer | STATIC | `earningsData`; "◆ AI Summary · conf. 91%" is a template | — | — | `earnings_events` ✅ + Anthropic |
| 12 | Sector drawer | STATIC | `sectorByName` + 3 hardcoded news items | — | — | `sectors` + `news` ✅ |
| 13 | Fund drawer | STATIC | `funds`/`fundDetail` | — | — | `fund_holdings` ✅ |
| 14 | Index drawer | HYBRID | day/52wk ranges **fabricated** as `×0.997`/`×1.06` of live price | Polygon | `/v2/aggs/…` | Compute from `ohlcv_bars` ✅ |
| 15 | Fear & Greed drawer | STATIC | hardcoded 62 + 7 component scores | — | — | `market_sentiment` ✅ |
| 16 | Mover detail drawer | — | embeds B.2 | — | — | — |

---

## B.21 Shared chart panel — `app/iq/stock-panel.tsx` · **7 features**

⚠️ **Nothing in this file ever passes real bars to `CandleChart`** — every chart here is synthetic. Affects **Screener, Watchlist, Portfolio, Themes**.

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | `StockRow` sparkline | GENERATED | `sparkSVG()` seeded 20-point path | — | — | `ohlcv_bars` ✅ |
| 2 | `StockListCard` | NONE | layout | — | — | — |
| 3 | `ChartCard` candlestick | GENERATED | `genOHLC()` — no `realBars` prop passed | — | — | `useOhlcvBars` ✅ (hook exists, unused here) |
| 4 | RSI pane | GENERATED | sine + random walk | — | — | Compute from `ohlcv_bars` |
| 5 | Earnings pane | GENERATED | `earnHistory()` | — | — | Finnhub `/calendar/earnings` ✅ |
| 6 | Expand-chart modal | GENERATED | same as #3 | — | — | — |
| 7 | `StockPanelLayout` | NONE | layout | — | — | — |

---

## B.22 Public landing page — `app/page.tsx` · **16 features**

Zero Firestore calls; all thumbnails render `data.ts` mocks + `genOHLC()`/`earnHistory()`. **Acceptable for a logged-out marketing page** — flagged for completeness, not as a defect.

| # | Feature | Type | Source | Provider | Endpoint | Free alternative |
|---|---|---|---|---|---|---|
| 1 | Nav bar | NONE | — | — | — | — |
| 2 | Hero section | STATIC | copy | — | — | — |
| 3 | Workspace marquee (8 cards) | STATIC | `WS_LIST` | — | — | — |
| 4–11 | Screen thumbnails (Dashboard, Movers, Stock, Heatmap, Earnings, Analyst, Portfolio, Recaps) | STATIC + GENERATED | `data.ts` + `genOHLC()`/`earnHistory()` | — | — | — |
| 12 | "And many more" card | NONE | — | — | — | — |
| 13 | Glance modal | STATIC | `WS_LIST[i]` copy | — | — | — |
| 14 | Auth modal + Google sign-in | API | real `signInWithPopup()` | Firebase Auth | — | — |
| 15 | Pricing section | STATIC | $0/$29/$79; buttons open signup, **no billing wired** | — | — | Stripe |
| 16 | Final CTA + WebGL background | NONE | decorative | — | — | — |

---

## B.23 Feature totals by screen

| Screen | Features | API/LIVE | HYBRID | STATIC | GENERATED | USER | NONE/FAKE |
|---|---|---|---|---|---|---|---|
| Dashboard | 17 | 0 | 9 | 2 | 2 | 0 | 4 |
| Stock Detail | 18 | 0 | 5 | 2 | 10 | 1 | 0 |
| Earnings Hub | 9 | 1 | 1 | 3 | 3 | 0 | 1 |
| **Earnings Calendar** | **6** | **4** | 0 | 0 | 0 | 0 | 2 |
| Movers | 7 | 0 | 3 | 0 | 2 | 0 | 2 |
| Screener | 6 | 0 | 2 | 1 | 1 | 1 | 1 |
| Watchlist | 5 | 0 | 1 | 0 | 2 | 2 | 0 |
| Portfolio | 8 | 0 | 1 | 1 | 1 | 4 | 1 (FAKE) |
| Heatmap | 4 | 0 | 2 | 0 | 0 | 0 | 2 |
| Themes | 4 | 0 | 1 | 1 | 2 | 0 | 0 |
| Macro | 10 | 3 | 3 | 3 | 1 | 0 | 0 |
| Insider & 13F | 12 | 1 | 4 | 3 | 2 | 0 | 2 |
| Options | 5 | 1 | 0 | 3 | 1 | 0 | 0 |
| Analyst | 7 | 1 | 1 | 3 | 0 | 0 | 2 |
| Commentary | 9 | 0 | 2 | 5 | 0 | 0 | 2 |
| EOD Recap | 11 | 0 | 0 | 8 | 1 | 0 | 2 |
| IPOs | 6 | 1 | 2 | 1 | 0 | 0 | 2 |
| Settings | 8 | 0 | 0 | 0 | 0 | 6 | 2 (1 FAKE) |
| Manage Plan | 4 | 0 | 0 | 2 | 0 | 1 | 1 |
| App Shell | 16 | 1 | 4 | 6 | 3 | 2 | 0 |
| Stock Panel | 7 | 0 | 0 | 0 | 5 | 0 | 2 |
| Landing page | 16 | 1 | 0 | 12 | 0 | 0 | 3 |
| **Total** | **~185** | **14** | **41** | **56** | **36** | **17** | **~33** |

**Reading of the totals:** only **14 features (~8%)** are purely live; **41 more (~22%)** are hybrid, where live numbers sit on static context. **92 features (~50%)** are STATIC or GENERATED. The Earnings Calendar is the only screen that is majority-live; EOD Recap, Stock Panel and the landing page have no live data at all.

---

# Part C — Free & alternative vendors by data domain

⚠️ **Read this first.** Everything below is marked ✅ only where it was probed against a live key on 2026-07-20. All other rows are ⚠️ from vendor documentation and **must be verified before you rely on them** — free tiers and rate limits change frequently, and several vendors have changed or withdrawn free access in the past. Redistribution rights are a separate question from access: several "free" APIs prohibit redistributing their data in a product you charge for. **Check each vendor's ToS before shipping.**

## C.1 Domain → current provider → alternatives

| Domain | Current | Free / alternative options | Notes |
|---|---|---|---|
| **Ticker universe** | Polygon | SEC `company_tickers.json` (free, no key) · Nasdaq symbol directory (free FTP) · Finnhub `/stock/symbol` | SEC is authoritative for US listings and already in use elsewhere here |
| **Daily OHLCV** | Polygon | Stooq (free CSV, no key) · Tiingo (free tier, EOD) · Alpha Vantage (free, low daily cap) · Twelve Data (free tier) · EODHD | ⚠️ Yahoo Finance's chart endpoint is widely used but **unofficial and against ToS** — not advisable for a paid product |
| **Real-time / delayed quotes** | Polygon (15-min delayed) | Finnhub `/quote` (already wired as fallback) · Alpaca Market Data (free IEX feed) · Twelve Data | Finnhub is already available on the existing key |
| **Company profile** | Polygon → FMP | Finnhub `/stock/profile2` · SEC XBRL `companyfacts` · Alpha Vantage `OVERVIEW` | |
| **Financial statements** | Polygon `/vX/` **(experimental)** | **SEC XBRL `companyconcept` / `frames` (free, authoritative, no key)** · Alpha Vantage `INCOME_STATEMENT` | **Recommended migration.** Removes dependence on an experimental namespace that can break without notice |
| **Earnings calendar** | FMP (**10 rows/week**) | **Finnhub `/calendar/earnings` — ✅ 488 rows for the same week, plus `hour` (bmo/amc) and `quarter`/`year`** · Nasdaq (unofficial) · Alpha Vantage `EARNINGS_CALENDAR` (CSV) | **See §C.3 — highest-value change available** |
| **Analyst ratings** | FMP `grades-consensus` (snapshot only) | **Finnhub `/stock/recommendation` — ✅ monthly history** · Benzinga (paid; key exists, unwired) | Would give the Analyst screen a real trend instead of a single snapshot |
| **Dividends** | Polygon → FMP | Finnhub `/stock/dividend` · Nasdaq · SEC | Polygon gives no yield; FMP does |
| **IPO calendar** | Polygon → Finnhub | Already dual-sourced · SEC S-1/424B filings for the pipeline | Neither source carries **aftermarket price**, which is why IPO performance stats only populate from mock data (B.17) |
| **News** | Polygon + Finnhub (aggregated) | Marketaux (free tier) · GDELT (free, no key) · NewsAPI (free dev tier, **non-commercial**) · publisher RSS (PR Newswire, Business Wire, GlobeNewswire) | Current aggregate setup is reasonable |
| **News importance / editorial rank** | Heuristic (headline regex + sentiment) | Benzinga `importance` 0–5 (paid — **returns 403 on current plan**) | The heuristic exists specifically because this is gated |
| **Macro / economic** | FRED | — | ✅ Already optimal: free, authoritative, no rate concern |
| **Insider (Form 4)** | SEC EDGAR | — | ✅ Already optimal |
| **Institutional (13F)** | SEC EDGAR | — | ✅ Already optimal |
| **Options chains** | Polygon (no bid/ask, IV, greeks, OI) | Tradier (key exists, **unwired**; sandbox gives delayed chains w/ greeks) · CBOE delayed quotes · Alpaca options | Tradier is the obvious unlock — the key is already provisioned |
| **Sector performance** | 11 SPDR ETFs (proxy) | FMP `sector-performance-snapshot` (already the fallback) | No vendor offers true cap-weighted sector aggregates on a cheap tier |
| **Fear & Greed** | Computed in-house from Polygon | CNN's unofficial endpoint | In-house computation is defensible and dependency-free — **keep it** |
| **Earnings transcripts** | None (hand-written mocks) | FMP transcripts (paid add-on) · API Ninjas | Currently `CALLS_DATA` is entirely hand-authored |
| **Institutional ownership %** | Static maps | Finnhub `/stock/ownership` (paid) · derive from 13F data already synced | Deriving from existing `fund_holdings` avoids a new vendor |

## C.2 Keys you already pay for / hold but do not use

| Key | Status | Opportunity |
|---|---|---|
| `FINNHUB_API_KEY` | ✅ Active, used for news/IPO/quote fallback | **Earnings calendar + analyst history — see C.3** |
| `TRADIER_ACCESS_TOKEN` | Service exists, **unwired** | Options chain greeks/IV/OI — the gap the Options screen fakes today |
| `BENZINGA_API_KEY` | Service exists, **unwired**; 403 on current plan | News importance, analyst actions |
| `UNUSUAL_WHALES_API_KEY` | Service exists, **unwired** | Options flow (marked Phase 2, not MVP) |
| `ANTHROPIC_API_KEY` | **Declared, zero references in `src/`** | Every "AI" feature in the app is currently a template string. This key is what would make them real |
| `ALPHAVANTAGE_API_KEY` | Declared, unused | Backup for OHLCV/fundamentals |
| `MEDIASTACK_API_KEY` | Declared, unused | Backup news source |

## C.3 ⭐ Highest-value change available: switch the earnings calendar to Finnhub

Both endpoints probed live on 2026-07-20 with the **existing** `FINNHUB_API_KEY`:

| | FMP (current) | Finnhub |
|---|---|---|
| Rows, Jul 20–24 2026 | **10** | **488** |
| Rows, Wed Jul 22 | **2** | (within the 488) |
| Session (BMO/AMC) | ❌ absent | ✅ `hour`: `bmo`=138, `amc`=169, blank=181 |
| Fiscal quarter/year | ❌ | ✅ `quarter`, `year` |
| Revenue est/actual | ✅ | ✅ |

**What this unlocks:**
1. **~49× earnings coverage.** For reference, EarningSpike shows 389 companies for that week — Finnhub's 488 exceeds it; FMP's 10 is why our calendar looks empty.
2. **The Before Open / After Close filter**, which had to be omitted from the new earnings calendar because FMP carries no session field. ~63% of rows have a usable `hour`.
3. Fiscal quarter labelling.

**Cost:** none — the key is already provisioned and Finnhub is already a wired vendor with an existing adapter pattern to slot into.

**Caveat:** ~37% of rows have a blank `hour`. The UI must treat blank as "unspecified" rather than defaulting to a session, or it will fabricate exactly the kind of claim this document is auditing.

---

# Part D — Gaps, risks and recommended order of work

## D.1 Correctness bugs (wrong data shown, not just missing)

| # | Issue | Location | Impact |
|---|---|---|---|
| 1 | **AMD cross-contamination.** Detail card falls back to `EARN_CAL[0]` (AMD) for any ticker outside the ~33-row mock, rendering AMD's name/sector/guidance under the selected real symbol | `earnings.tsx:725` | **High** — actively wrong, and now easily reachable since the new calendar can select any live ticker |
| 2 | **"Import from photo"** claims AI image scanning; reads no image, returns a fixed 3-row result | `portfolio.tsx:145` | **High** — simulates a capability that does not exist |
| 3 | **"Schedule & share recap"** shows "✓ Recap scheduled" but performs no write and sends nothing | `settings.tsx:193` | **High** — same class of issue |
| 4 | **Nav clock** labeled "ET" but uses the browser's local timezone with no conversion | `shell.tsx:798` | Medium — wrong for any non-ET user |
| 5 | **EOD Recap** permanently renders "Tuesday, May 21" content as today's recap | `recap.tsx` | Medium |
| 6 | **AI Copilot** claims "Connected to your portfolio · live data"; replies are 4 cycled hardcoded strings | `shell.tsx:681` | Medium |
| 7 | Dashboard **"PDF" recap** downloads a one-line `.txt` | `dashboard.tsx:433` | Low |
| 8 | Heatmap **Stocks/S&P 500 tabs** are a dead control | `heatmap.tsx:116` | Low |
| 9 | Manage-Plan upgrade/billing buttons have **no handlers** | `manage-plan.tsx` | Low |

## D.2 Unlabeled fabrication (the systemic issue)

Only **three** places in the app label non-live data honestly: `ipos.tsx` ("· sample data"), `options.tsx` ("Simulated data…"), and `insider.tsx` ("the rest are illustrative sample data"). Everywhere else, fabricated values render identically to real ones.

The most-reused fabricators:

| Function | Location | Renders on |
|---|---|---|
| `earnHistory()` | `utils.tsx:183` | Earnings, Stock, Commentary, every drawer chart, landing page |
| `genOHLC()` | `utils.tsx:310` | **All** charts in Screener/Watchlist/Portfolio/Themes; 1D/1W/5Y on Stock Detail |
| `RsiPane` | `utils.tsx:502` | Stock Detail + every embedded chart — renders beside a *real* RSI(14) number |
| `earnIncome()` | ×2 copies | Financial statements on Earnings + Stock |
| `divHistory()` | `macro.tsx:293` | Dividend history chart |
| `instMeta()` etc. | `insider.tsx:74` | Institutional tables and drawers |

## D.3 Recommended order

1. **Fix D.1 #1–#3** — these show wrong data or claim capabilities that don't exist. Small, contained changes.
2. **Switch earnings to Finnhub (C.3)** — biggest data win available, zero incremental cost, and restores the session filter.
3. **Label the rest** — adopt `ipos.tsx`'s "· sample data" pattern app-wide. Cheap, and converts a credibility problem into an honest one.
4. **Wire Tradier** for real options greeks/IV/OI, replacing `buildChain()`.
5. **Migrate financials to SEC XBRL** — removes reliance on Polygon's experimental `/vX/` namespace.
6. **Thread real bars through `stock-panel.tsx`** so Screener/Watchlist/Portfolio/Themes stop showing synthetic charts.
7. **Decide on the "AI" features** — either wire `ANTHROPIC_API_KEY` (already provisioned, currently unused) or stop labeling template strings as AI-generated.

## D.4 Open items not covered here

- `MACRO_SERIES` (which FRED series IDs are synced) was not enumerated — read `src/common/macro-series.ts` to complete §A.4.
- The `sectorFromSic()` mapping table was not verified row by row.
- Production values of the `<NAME>_SOURCE` env vars are set in Cloud Run / Secret Manager and are **not** knowable from this repo — §A.6 shows `.env.example` values, which may differ from what is deployed.
