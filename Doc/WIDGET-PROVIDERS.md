# Widgets → Data Providers

**Generated:** 2026-07-21 · Companion to the exhaustive [FEATURE-DATA-MAP.md](./FEATURE-DATA-MAP.md).

Each widget maps to its **current provider** with an arrow. `A → B` means A is primary, B is the fallback. Endpoints marked ✅ were called live on the app's own keys (2026-07-20/21); alternatives are ⚠️ from vendor docs unless marked ✅.

---

## Legend

```
Widget  ──►  Provider            = current data source
A → B                            = primary → fallback chain in code
✅                               = verified live against the endpoint
⚠️                               = from vendor docs, NOT tested — verify before relying
```

---

## 1. Widgets backed by a real API

| Widget | Current provider | Current endpoint | Alternative provider → endpoint |
|---|---|---|---|
| **Earnings Calendar** | ──► **FMP** ⚠️ *(10 rows/wk)* | `GET /stable/earnings-calendar?from=&to=` ✅ | **Finnhub** → `GET /api/v1/calendar/earnings?from=&to=` ✅ *(488 rows + BMO/AMC)* |
| **Live price ticker** | ──► **Polygon** | `GET /v2/snapshot/locale/us/markets/stocks/tickers?tickers=` ✅ | Finnhub → `GET /api/v1/quote?symbol=` ✅ · Twelve Data → `/quote` ⚠️ |
| **Price chart (candles)** | ──► **Polygon** | `GET /v2/aggs/ticker/{sym}/range/1/day/{from}/{to}` ✅ | Stooq → CSV ⚠️ · Tiingo → `/tiingo/daily/{sym}/prices` ⚠️ · Twelve Data → `/time_series` ⚠️ |
| **Company header / profile** | ──► **Polygon → FMP** | `GET /v3/reference/tickers/{sym}` ✅ | Finnhub → `GET /api/v1/stock/profile2?symbol=` ⚠️ |
| **Market Movers** | ──► **FMP → Polygon** | `GET /stable/biggest-gainers` ✅ *(⚠️ no volume)* | Polygon → `GET /v2/snapshot/locale/us/markets/stocks/gainers` ✅ *(has volume)* |
| **Market Indices / VIX strip** | ──► **Polygon → Finnhub** | `GET /v2/aggs/ticker/{etf}/range/1/day/…` ✅ | Finnhub → `/api/v1/quote` ✅ · CBOE → delayed quotes ⚠️ |
| **Sector Heatmap** | ──► **Polygon (11 SPDR ETFs) → FMP** | ETF quotes / `GET /stable/sector-performance-snapshot?date=` ✅ | FMP is the stronger source here |
| **News feed + bell** | ──► **Polygon + Finnhub** *(merged)* | `GET /v2/reference/news?ticker=` ✅ + `GET /api/v1/company-news?symbol=` ✅ | Marketaux → `/v1/news/all` ⚠️ · GDELT → `/api/v2/doc/doc` ⚠️ *(no key)* |
| **Analyst consensus** | ──► **FMP** *(snapshot only)* | `GET /stable/grades-consensus?symbol=` ✅ | **Finnhub** → `GET /api/v1/stock/recommendation?symbol=` ✅ *(monthly history)* |
| **Dividends calendar** | ──► **Polygon → FMP** | `GET /v3/reference/dividends?ex_dividend_date.gte=` ✅ | FMP → `/stable/dividends-calendar` ✅ *(adds yield)* · Finnhub → `/api/v1/stock/dividend` ⚠️ |
| **IPO calendar** | ──► **Polygon → Finnhub** | `GET /vX/reference/ipos?listing_date.gte=` ✅ | Finnhub → `GET /api/v1/calendar/ipo` ✅ |
| **Options chain (Live Reference)** | ──► **Polygon** *(no greeks/IV/OI)* | `GET /v3/reference/options/contracts?underlying_ticker=` ✅ | **Tradier** → `GET /v1/markets/options/chains` ⚠️ *(token provisioned, unwired)* · Alpaca → `/v1beta1/options/…` ⚠️ |
| **Economic calendar** | ──► **FRED** | `GET /fred/series/observations?series_id=` ✅ | — *free & authoritative; keep* |
| **Insider (Form 4)** | ──► **SEC EDGAR** | `GET /submissions/CIK{cik}.json` ✅ | — *free & authoritative; keep* |
| **Institutional (13F)** | ──► **SEC EDGAR** | `GET /submissions/CIK{cik}.json` → filing XML ✅ | — *free & authoritative; keep* |
| **Fear & Greed gauge** | ──► **Polygon** *(computed in-house)* | `GET /v2/aggs/grouped/locale/us/market/stocks/{date}` ✅ | CNN → unofficial endpoint ⚠️ *(keep in-house)* |
| **RS Rating** | ──► *none — computed* | from `ohlcv_bars` in Firestore | — *own IBD-style calculation* |
| **Technical indicators (RSI/MACD)** | ──► *none — computed* | from `ohlcv_bars` in Firestore | — *own calculation* |

---

## 2. Widgets with NO real API today *(fabricated in the browser)*

| Widget | Current | ──► should point to |
|---|---|---|
| **Charts** in Screener / Watchlist / Portfolio / Themes | `genOHLC()` synthetic | Polygon → `/v2/aggs/…` ✅ *(already synced, not wired)* |
| **Financial statements** (Stock / Earnings) | `earnIncome()` invented ratios | **SEC XBRL** → `GET /api/xbrl/companyconcept/CIK{cik}/us-gaap/{concept}.json` ⚠️ *(free)* |
| **RSI / EPS-surprise / pivot panes** | `earnHistory()` / sine wave | compute from `ohlcv_bars` ✅ |
| **AI Copilot / AI summaries** | 4 hardcoded strings / templates | **Anthropic** → `POST /v1/messages` ⚠️ *(ANTHROPIC_API_KEY provisioned, unused)* |
| **Earnings-call transcripts** | hand-written `CALLS_DATA` | FMP → `/stable/earning-call-transcript` ⚠️ *(paid)* · API Ninjas ⚠️ |
| **EOD Recap** | 100% static ("Tuesday, May 21") | `market_indices` + `news` + Anthropic |
| **VIX card (Macro screen)** | hardcoded `14.18` | `market_indices` VIXY ✅ *(already synced; Dashboard's VIX card uses it)* |
| **Institutional ownership tables** | `instMeta()` hash-fabricated | derive from `fund_holdings` ✅ *(already synced)* |

---

## 3. Base URLs

| Provider | Base URL | Auth |
|---|---|---|
| Polygon / Massive | `https://api.massive.com` | `?apiKey=` |
| FMP | `https://financialmodelingprep.com/stable` | `?apikey=` |
| Finnhub | `https://finnhub.io/api/v1` | `?token=` |
| FRED | `https://api.stlouisfed.org/fred` | `?api_key=` |
| SEC EDGAR | `https://data.sec.gov` + `https://www.sec.gov` | none *(User-Agent header required)* |
| SEC XBRL | `https://data.sec.gov/api/xbrl` | none |
| Tradier | `https://api.tradier.com` | `Bearer` token |
| Anthropic | `https://api.anthropic.com` | `x-api-key` |

---

## 4. The three highest-value swaps

| # | Widget | Change | Why | Cost |
|---|---|---|---|---|
| 1 | Earnings Calendar | FMP ──► **Finnhub** | 49× coverage (10 → 488 rows) + BMO/AMC session field | free — key already held |
| 2 | Options chain | Polygon ──► **Tradier** | real greeks / IV / open interest vs Polygon's none | token already provisioned |
| 3 | Financial statements | `earnIncome()` fabricated ──► **SEC XBRL** | free, authoritative, removes Polygon's experimental `/vX/` namespace risk | free |

---

## 5. Keys held but unused

| Key | Status | Opportunity |
|---|---|---|
| `TRADIER_ACCESS_TOKEN` | provisioned, unwired | options greeks/IV/OI (swap #2) |
| `ANTHROPIC_API_KEY` | declared, zero refs in code | every "AI" widget is a template string today |
| `BENZINGA_API_KEY` | 403 on current plan | news importance, per-firm analyst actions |
| `ALPHAVANTAGE_API_KEY` | declared, unused | backup OHLCV / fundamentals |
| `MEDIASTACK_API_KEY` | declared, unused | backup news |

---

## 6. Can every static widget go dynamic? — and does Polygon *paid* already cover it?

All probed live against the paid Polygon (Stocks Starter) key on **2026-07-21**. "Polygon paid?" = does your current plan return the data, tested — not assumed.

### Fabricated / static widgets → the API that fixes them

| Widget (currently fabricated) | Can go dynamic? | Best source | On Polygon **paid**? | Endpoint |
|---|---|---|---|---|
| Charts in Screener/Watchlist/Portfolio/Themes (`genOHLC`) | ✅ yes | Polygon | ✅ **yes** *(already synced to `ohlcv_bars`)* | `GET /v2/aggs/ticker/{sym}/range/1/day/{from}/{to}` ✅ |
| Financial statements (`earnIncome`) | ✅ yes | Polygon | ✅ **yes** — full income stmt, balance sheet, cash flow | `GET /vX/reference/financials?ticker=&timeframe=quarterly` ✅ |
| RSI / MACD / SMA panes (sine wave) | ✅ yes | Polygon | ✅ **yes** — dedicated indicator endpoints | `GET /v1/indicators/{rsi,macd,sma}/{sym}` ✅ *(also computed in-house from bars)* |
| Peers list (fabricated "change") | ✅ yes | Polygon | ✅ **yes** — returns real peer tickers | `GET /v1/related-companies/{sym}` ✅ *(e.g. AAPL → MSFT, AMZN, GOOGL, NVDA…)* |
| Dividend-history chart (`divHistory`) | ✅ yes | Polygon | ✅ **yes** — full history, date-ranged | `GET /v3/reference/dividends?ticker=&limit=1000` ✅ |
| Institutional ownership tables (`instMeta`) | ✅ yes | SEC EDGAR | ➖ n/a — derive from synced `fund_holdings` | already in Firestore ✅ |
| Insider ownership % / short interest (static maps) | ⚠️ partial | FINRA / SEC | ❌ not Polygon paid | FINRA short-interest files (free) ⚠️ |
| Earnings calendar (mock `EARN_CAL`) | ✅ yes | Finnhub | ❌ not Polygon *(no earnings product)* | `GET /api/v1/calendar/earnings` ✅ |
| Analyst ratings / clusters (mock `analyst`) | ✅ yes | FMP / Finnhub | ❌ not Polygon | FMP `/stable/grades-consensus` ✅ · Finnhub `/stock/recommendation` ✅ |
| **Options chain greeks / IV / OI** (`buildChain`) | ✅ yes | **Tradier** | ❌ **NOT on Polygon paid** — `NOT_AUTHORIZED`, "upgrade your plan" | Tradier `GET /v1/markets/options/chains` ⚠️ |
| AI Copilot / AI summaries (hardcoded) | ✅ yes | Anthropic | ❌ not a market-data vendor | `POST /v1/messages` ⚠️ *(key provisioned, unused)* |
| Earnings-call transcripts (`CALLS_DATA`) | ✅ yes | FMP (paid add-on) | ❌ not Polygon | FMP `/stable/earning-call-transcript` ⚠️ |
| EOD Recap (100% static) | ✅ yes | synced data + Anthropic | ➖ narrative needs Anthropic; numbers already synced | `market_indices` + `news` ✅ |
| VIX card on Macro (hardcoded `14.18`) | ✅ yes | Polygon | ✅ **yes** *(already synced as VIXY)* | `market_indices` doc ✅ |

### Verdict

- **Nearly every static widget can go dynamic.** The only ones with no free/current path are earnings-call transcripts (paid) and the "AI" widgets (need Anthropic).
- **Polygon paid covers more than the app currently uses.** Confirmed working on your plan but **not wired**: technical-indicator endpoints, `related-companies` (peers), and full financial statements (balance sheet + cash flow, not just the income figures the growth job reads).
- **Polygon paid does NOT cover:** options greeks/IV/OI (`NOT_AUTHORIZED`), real-time prices (delayed-only), tick trades/quotes, earnings calendar, analyst ratings, and news importance. Those need Finnhub / FMP / Tradier / SEC as noted.

### Corrections to earlier notes in this repo

1. **Polygon *does* have a peers product** — `GET /v1/related-companies/{ticker}` works on the paid plan and returns real tickers. Earlier docs (this file §1 and FEATURE-DATA-MAP §A.1.2) stated peers are "structurally null on Polygon." That was wrong; the `companies` job just never called it.
2. **Polygon paid exposes RSI/MACD/SMA indicator endpoints.** The app computes these in-house from `ohlcv_bars` instead — which is fine and cheaper, but the vendor path exists if ever wanted.
