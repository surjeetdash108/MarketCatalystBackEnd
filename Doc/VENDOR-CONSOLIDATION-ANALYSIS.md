# MarketCatalyst — Single-Vendor Consolidation Analysis

**Question:** If we wanted **one** market-data vendor to supply **100%** of what the MarketCatalyst app needs, what is missing / what would we have to ask that vendor to provide?

Two scenarios are analysed:
- **Scenario A — Polygon only**
- **Scenario B — FMP only**

This document is grounded in a full code inventory of the running app (every Polygon, FMP, FRED and SEC-EDGAR call), **not** on a generic vendor comparison. Date: 2026-08-18.

---

## 0. Bottom line (read this first)

| | Polygon-only | FMP-only |
|---|---|---|
| **Can it reach 100% as the app is designed today?** | **No** — even with every paid upgrade | **Almost** — ~95%+, one true blocker |
| **Hard blockers (no product exists at the vendor)** | Consensus/**non-GAAP EPS & estimates**, analyst ratings & price targets, institutional/13F rollup, earnings-call transcripts, forward earnings calendar | **Short interest** only |
| **Solvable by paying/upgrading the same vendor** | Real-time (drop 15-min delay), real index & VIX levels, short interest, crypto, >5yr history, non-experimental financials | Real-time tick stream, deeper intraday history, options depth |
| **Net verdict** | Not viable without dropping ~4 feature areas (Analyst Actions, Earnings estimates, Institutional, Transcripts). Polygon does not sell that data. | Viable. FMP is effectively a super-set of what we use; the work is *wiring* the price/quote/macro/commodity feeds we currently take from Polygon/FRED/SEC. Short interest stays unsolved (it's unsolved **today** too). |

**One-line summary:** *Polygon is a market-**infrastructure** vendor (prices, bars, corporate actions) and has no analyst/estimates/ownership products — so Polygon-only cannot power the fundamentals side of the app. FMP is a **fundamentals + analyst + everything** vendor that also carries prices, indices, commodities and macro — so FMP-only is achievable except for short interest.*

---

## 1. Current architecture — who supplies what today

The app uses **exactly four** external sources. Everything else is computed in our own jobs.

| Vendor | Plan / access | Supplies today |
|---|---|---|
| **Polygon.io** | Stocks **Starter**, 15-min delayed, 5-yr rolling history | Prices/quotes/bars/snapshots, Top Movers (grouped daily), dividends & splits, related-companies (peers), market status & holidays, treasury yields (`/fed/v1`), **GAAP** financials (`/vX/reference/financials`), IPO calendar, options contracts, news (+sentiment insights), ticker details (name/sector-via-SIC/market-cap/description/logo), full ticker universe & search |
| **FMP** | `/stable/` API (v3/v4 deprecated → 403) | **Non-GAAP earnings** (actual-vs-estimate, the beat/miss basis), forward EPS/revenue estimates, upcoming earnings calendar, analyst consensus / grades / price targets, **institutional (13F) ownership rollup**, earnings-call transcripts, forward economic calendar, cap-weighted sector performance, stock news |
| **FRED** | free key | Header tape: **WTI** (`DCOILWTICO`), **Bitcoin** (`CBBTCUSD`); 12 macro series (CPI, Core CPI, unemployment, payrolls, fed funds, PPI, retail sales, jobless claims, GDP, industrial production, consumer sentiment, DGS10); macro-regime inputs (yield-curve spread, VIX, HY credit spread, S&P level, unemployment) |
| **SEC-EDGAR** | free (public) | **Form 4 insider transactions**, **13F fund holdings** (fund-indexed, CUSIP-level), **8-K filings wire** + earnings announcements (item 2.02 → BMO/AMC + reaction), **S-1/424B IPO registration pipeline** |

**Everything computed in-house (from Polygon bars):** RS rating, technical rating, RSI/MACD/SMA/EMA/Stochastic/ADX, beta, 52-week hi/lo, realized vol, key-level pivots, relative volume, Fear & Greed, market breadth/internals (advancers, decliners, TRIN, McClellan), recaps, sector ranks.

### Gaps that already exist today (no vendor supplies them)
These are missing **regardless** of consolidation — the honest baseline:
- **Short interest** — no field anywhere (Polygon 404s, FMP has no product).
- **Guidance / implied move / post-earnings reaction** — fields exist on the earnings calendar but are always null.
- **Revenue (sales) surprise** — FMP `/stable/earnings` is EPS-only, so the Sales %surp column renders "—".
- **Real index levels** (SPX/NDX/DJI/RUT), **spot gold**, **spot VIX**, **DXY** — approximated with ETF-proxy × multiplier because Polygon index snapshots are `NOT_AUTHORIZED` on Starter (gold specifically = GLD × 10.89).

---

## 2. Scenario A — Polygon only

### 2.1 What Polygon already covers (no change needed)
Prices/quotes/bars, movers, dividends, splits, peers, market status/holidays, treasury yields, GAAP financials, IPO calendar (priced), options, news, company profile/sector/logo, ticker universe/search, and everything we compute from bars (technicals, RS, pivots, breadth, Fear & Greed). This is the majority of the *screens*, but **not** the fundamentals depth.

### 2.2 Solvable by paying / upgrading Polygon (product exists — just entitle it)
Ask Polygon to enable these; they exist in Polygon's catalog:

| Need | Polygon product to request | Removes today's hack |
|---|---|---|
| **Real-time** (drop 15-min delay) | Real-time Stocks plan + real-time WebSocket (`wss://socket.polygon.io`) | Currently `NOT_AUTHORIZED`; uses `delayed.polygon.io` |
| **Real index levels + VIX** | **Indices** cluster / add-on (`I:SPX`, `I:NDX`, `I:DJI`, `I:RUT`, `I:VIX`) | Removes SPY×10 / QQQ×36.3 / DIA×100 / IWM×10 ETF proxies and gives a real VIX |
| **Short interest** | **Short Interest / Short Volume** endpoint (add-on) | Fills the one field that's blank today — *Polygon can do this, FMP cannot* |
| **Bitcoin / crypto** | Crypto cluster (`X:BTCUSD`) | Removes FRED `CBBTCUSD` dependency |
| **History > 5 years** | Higher history tier | Removes `planHistoryFloor()` clamp |
| **Stable financials** | `/stocks/financials/v1/*` — needs **Advanced** or **Financials add-on** | Off the experimental `/vX/` namespace (still GAAP, see blocker below) |

### 2.3 Hard blockers — Polygon has **no product** for these
No amount of upgrading fixes these; Polygon simply does not sell this data. Each maps to a live feature:

| Missing data | Feature that breaks | Why Polygon can't |
|---|---|---|
| **Consensus / non-GAAP EPS actual** (the app's whole EPS/P/E/growth/beat-miss basis, matching NASDAQ/IBD) | EPS everywhere, P/E, EPS growth, beat/miss, Earnings Playbook | Polygon financials are **GAAP from SEC filings** only. It has no consensus/adjusted-EPS product. Using Polygon GAAP produces the spurious huge beats/misses we specifically moved *off* (PANW case). |
| **Forward EPS/revenue estimates** ("what street expects", `annualEstimates`, upcoming-calendar estimates) | Earnings Hub estimates, forward `*YYYY` columns | Polygon has no estimates/consensus feed at all. |
| **Analyst ratings** — consensus buy/hold/sell, grades, upgrades/downgrades | **Analyst Actions** screen, consensus card | Polygon has no analyst product. |
| **Price targets** — consensus high/low/avg/median, per-firm targets, PT trend | Price-target cards & upside | Polygon has no price-target product. |
| **Institutional / 13F ownership rollup** (ticker-indexed % owned, holder counts) | **Institutional** card & screen | Polygon has no ownership/13F product. |
| **Earnings-call transcripts** | Transcript viewer / "Earnings call" | Polygon has no transcripts. |
| **Forward earnings calendar** (upcoming report dates for the whole market) | Earnings Hub calendar (upcoming) | Polygon only knows *past* report dates (via filing_date). No forward calendar. |
| **Forward economic calendar w/ consensus estimates** + broad macro series | Macro screen "this/next week" + most macro tiles | Polygon `/fed/v1` has only treasury yields & inflation — not payrolls/GDP/PPI/retail/claims/sentiment, and no forward release schedule with estimates. |
| **Commodities spot** (WTI, gold) | WTI & Gold tape tiles | Polygon has no commodities/futures product; only ETF proxies (USO/GLD). |

**Still-free fallbacks that are NOT Polygon** (only relevant if "Polygon only" is taken literally): insider Form 4, 13F fund positions, 8-K wire, IPO registration pipeline all come from **SEC-EDGAR** (free/public). Broad macro comes from **FRED** (free). If "Polygon only" means "drop FRED & SEC too," add insider, 13F drill-down, filings wire, IPO pipeline and macro to the blocker list. SEC/FRED can *partially* substitute (insider, 13F, GAAP financials, macro history) but **cannot** supply estimates, analyst ratings, transcripts, or non-GAAP EPS.

### 2.4 Polygon "ask list" (what to request from Polygon)
1. Real-time entitlement (stocks) + real-time WebSocket.
2. **Indices** add-on (SPX/NDX/DJI/RUT + **VIX**).
3. **Short Interest / Short Volume** endpoint.
4. Crypto cluster (BTC).
5. History beyond 5 years.
6. `/stocks/financials/v1/*` (Advanced/Financials add-on).
7. **Ask whether Polygon has any roadmap for: analyst estimates/ratings, price targets, institutional/13F, transcripts, forward earnings & economic calendars, commodities.** *(Expected answer: no — these are outside Polygon's product line.)*

### 2.5 Verdict — Polygon only
**Not viable for the app as designed.** Polygon can be made excellent for *price/market-structure* data (and can uniquely add short interest and real index/VIX levels), but it fundamentally cannot power **Analyst Actions, forward Earnings estimates, Institutional ownership, or Transcripts**, and cannot supply the **non-GAAP EPS** basis the whole fundamentals layer is built on. Going Polygon-only means deleting those features or bolting on SEC/FRED (which still can't cover estimates, ratings, or transcripts).

---

## 3. Scenario B — FMP only

FMP is a full-stack financial-data API: it already gives us the hardest parts (estimates, analyst, ownership, transcripts). To go FMP-only we mostly need to **move the price/market/macro feeds we currently take from Polygon/FRED/SEC onto FMP endpoints that already exist**.

### 3.1 What FMP already covers (live in the app today)
Non-GAAP earnings & surprises, forward estimates, upcoming earnings calendar, analyst consensus/grades/price-targets, institutional 13F rollup, transcripts, forward economic calendar, sector performance, news. This is the entire fundamentals + analyst + ownership layer — the part Polygon can't do.

### 3.2 What must be *wired* onto FMP (FMP has the product; app just doesn't call it yet)
These are currently Polygon/FRED/SEC. FMP has equivalents — this is integration work, not a vendor gap:

| Need (currently) | FMP endpoint(s) to add | Notes / upside |
|---|---|---|
| Quotes & prices (Polygon snapshot) | `/stable/quote`, `/stable/batch-quote` | Delayed/EOD on lower tiers; real-time needs a higher plan |
| Daily & intraday bars (Polygon aggs) | `/stable/historical-price-eod/*`, `/stable/historical-chart/{interval}` | Intraday history depth is plan-limited |
| **Real index levels + VIX** (proxies today) | `/stable/quote?symbol=^GSPC,^IXIC,^DJI,^RUT,^VIX` | **Solves the ETF-proxy hack for free** — real S&P/Nasdaq/Dow/Russell/VIX |
| **Commodities spot** WTI, gold (FRED/GLD proxy) | `/stable/quote` for commodity symbols (WTI, gold) | **Real spot** — removes the GLD × 10.89 workaround |
| Bitcoin/crypto (FRED) | `/stable/quote` crypto (`BTCUSD`) | Removes FRED `CBBTCUSD` |
| Treasury yields (Polygon `/fed/v1`) | `/stable/treasury-rates` | — |
| Macro series (FRED, 12 series) | `/stable/economic-indicators` (GDP, CPI, unemployment, etc.) | Replaces FRED observations; verify each series is offered |
| Movers (Polygon grouped daily) | `/stable/biggest-gainers`, `/biggest-losers`, `/most-actives` | — |
| Market hours / holidays (Polygon) | `/stable/exchange-market-hours`, holidays | — |
| Dividends & splits (Polygon) | `/stable/dividends`, `/stable/splits` | — |
| Company profile/sector/logo (Polygon) | `/stable/profile` (has description, sector, industry, beta, image) | — |
| Peers (Polygon related-companies) | `/stable/stock-peers` | Curated list vs Polygon's algorithmic — quality differs |
| Insider Form 4 (SEC) | `/stable/insider-trading/*` | Replaces SEC Form 4 parsing |
| IPO calendar + pipeline (Polygon + SEC) | `/stable/ipos-calendar`, IPO prospectus/disclosure feeds | Verify pipeline (S-1/424B) coverage vs SEC |
| Ticker universe & search (Polygon) | `/stable/stock-list`, `/stable/search-symbol` | — |
| GAAP statements (Polygon `/vX/`) | `/stable/income-statement`, `/balance-sheet-statement`, `/cash-flow-statement` | FMP already gives us the non-GAAP EPS too |
| Technicals (computed from Polygon bars) | keep computing from **FMP** bars, or `/stable/technical-indicators/*` | No change to logic if we just swap the bar source |
| Breadth / Fear & Greed / recaps (computed) | compute from **FMP** EOD/index series | Heavier (needs full-market EOD) but feasible |

### 3.3 Hard gaps / caveats with FMP-only
| Item | Severity | Detail |
|---|---|---|
| **Short interest** | **Hard blocker** | FMP has no short-interest product on `/stable`. Unsolved today too. Would still need FINRA (or Polygon's short-interest add-on, ironically). |
| **True real-time tick / NBBO** | Medium | FMP is not a tick-data/market-infrastructure provider. Real-time quotes need FMP's paid WebSocket; there is no full trade/quote tick feed like Polygon's. Fine for the current 15-min-delayed design; a limitation if we ever want true real-time depth. |
| **Options depth** | Low | The app's options chain (8 curated tickers) comes from Polygon contracts. FMP options coverage is thin — may not fully replace it. |
| **8-K filings wire + item-2.02 earnings-announcement classification & reaction** | Medium | Uses SEC acceptance-time → BMO/AMC logic. FMP has SEC-filings/press-release RSS but not the same item-level 2.02 classification; would need re-implementation or approximation. |
| **Per-firm price targets** | Quality | Already flaky on FMP (`price-target-news` drops ~30% on name mismatch, errors swallowed to `[]`). Not a missing product — a completeness issue. |
| **News sentiment** | Quality | FMP article sentiment is frequently null (vs Polygon's per-ticker insights). |
| **Silent empty 200s** | Reliability | FMP returns empty 200 (not 429) under burst; we already pace requests and preserve prior values. Consolidating *more* load onto FMP raises the importance of that pacing/caching. |
| **News redistribution licensing** | Commercial | Already accepted for FMP news; confirm it covers broader redistribution if FMP becomes the sole feed. |

### 3.4 FMP "ask list" (what to request / confirm with FMP)
1. **Short interest** data — do they have any product or roadmap? *(Likely no.)*
2. Plan tier that includes: **real-time (or acceptable delayed) quotes + WebSocket**, adequate **intraday history depth**, and **full-market EOD** (for breadth/movers/recaps).
3. Confirm coverage & symbols for: **index quotes (^GSPC/^IXIC/^DJI/^RUT/^VIX)**, **commodities spot (WTI, gold)**, **crypto (BTC)**, **treasury rates**, and each **economic indicator** we show (CPI, Core CPI, unemployment, payrolls, fed funds, PPI, retail sales, jobless claims, GDP, industrial production, consumer sentiment).
4. **IPO registration pipeline** (S-1/424B) coverage vs our SEC pipeline.
5. **Options** coverage for our 8-ticker chain (or accept dropping it).
6. **8-K / filings feed** granularity (item 2.02) — or accept computing earnings-announcement sessions/reactions ourselves from price + calendar.
7. Rate limits / burst behaviour for a single-vendor load; redistribution licensing for sole-feed use.

### 3.5 Verdict — FMP only
**Viable (~95%+).** FMP already owns the hard half (estimates, analyst, ownership, transcripts, earnings/econ calendars). The remaining work is integration: repoint prices, indices, commodities, crypto, treasury, macro, insider, movers, market-hours, IPO and universe onto FMP endpoints that already exist — and this actually **removes** several of today's hacks (real index & VIX levels, real spot gold, real BTC). The single unavoidable hole is **short interest**, which is a gap **today** anyway. Real-time tick data and options depth are the quality trade-offs to accept.

---

## 4. Side-by-side gap matrix

Legend: ✅ native / already used · 🟡 needs wiring or paid upgrade (product exists) · ❌ hard gap (no product)

| Data area | Polygon-only | FMP-only |
|---|---|---|
| Real-time/delayed quotes & bars | ✅ (🟡 real-time = upgrade) | 🟡 wire (🟡 real-time = upgrade) |
| Movers / grouped market | ✅ | 🟡 wire (`biggest-gainers`…) |
| Dividends & splits | ✅ | 🟡 wire |
| Company profile / sector / logo | ✅ | 🟡 wire (`profile`) |
| Peers / related companies | ✅ | 🟡 wire (`stock-peers`) |
| Technicals / RS / pivots (computed) | ✅ | 🟡 recompute from FMP bars |
| **Index levels + VIX** | 🟡 Indices add-on | 🟡 wire (`^GSPC…^VIX`) — real levels |
| **Commodities spot (WTI, gold)** | ❌ (proxy only) | 🟡 wire (real spot) |
| **Bitcoin / crypto** | 🟡 crypto cluster | 🟡 wire |
| Treasury yields | ✅ (`/fed/v1`) | 🟡 wire (`treasury-rates`) |
| **Broad macro series** | ❌ (only treasury/inflation) | 🟡 wire (`economic-indicators`) |
| **Forward economic calendar + estimates** | ❌ | ✅ |
| News (+sentiment) | ✅ (sentiment ✅) | ✅ (sentiment 🟡 often null) |
| **GAAP financial statements** | ✅ (🟡 stable API = add-on) | 🟡 wire |
| **Non-GAAP / consensus EPS** | ❌ | ✅ |
| **Forward EPS/revenue estimates** | ❌ | ✅ |
| **Earnings surprises (beat/miss)** | ❌ (GAAP only → wrong) | ✅ |
| **Forward earnings calendar** | ❌ | ✅ |
| **Analyst ratings / grades** | ❌ | ✅ |
| **Price targets (consensus + per-firm)** | ❌ | ✅ (per-firm 🟡 ~30% gaps) |
| **Earnings-call transcripts** | ❌ | ✅ |
| **Institutional / 13F rollup** | ❌ | ✅ |
| Insider (Form 4) | ❌ (SEC today) | 🟡 wire (`insider-trading`) |
| 13F fund positions (CUSIP drill-down) | ❌ (SEC today) | 🟡 verify FMP fund-level 13F |
| 8-K filings wire / earnings announcements | ❌ (SEC today) | 🟡 approximate / recompute |
| IPO calendar (priced) | ✅ | 🟡 wire |
| IPO registration pipeline (S-1/424B) | ❌ (SEC today) | 🟡 verify FMP coverage |
| Market status / holidays | ✅ | 🟡 wire |
| **Short interest** | 🟡 add-on (Polygon *can*) | ❌ (no product) |
| Options chains | ✅ | 🟡 thin coverage |
| Ticker universe & search | ✅ | 🟡 wire |

**Reading the matrix:** Polygon-only has **many ❌ in the fundamentals/analyst rows that cannot be resolved**. FMP-only has **mostly 🟡 (integration work on existing endpoints)** and only **one ❌ (short interest)**.

---

## 5. Recommendation

- **A single-vendor Polygon build is not achievable** for MarketCatalyst as designed. Polygon should remain the **market-data/price/technical backbone** (and is the *only* one of the two that can add real index/VIX levels and short interest), but it cannot supply estimates, analyst data, ownership or transcripts.
- **A single-vendor FMP build is achievable (~95%+).** It would consolidate the hard fundamentals we already depend on and let us retire several proxy hacks, at the cost of (a) losing **short interest** entirely, (b) accepting FMP's non-tick real-time and thinner options, and (c) re-implementing the 8-K earnings-announcement logic. If true real-time and short interest matter, a **Polygon (prices + short interest + indices) + FMP (fundamentals + analyst + ownership)** split — essentially today's model, tightened — remains the most complete option.
- **The lone data point neither vendor solves is short interest** — that needs FINRA (or Polygon's short-interest add-on specifically).

---

### Appendix — source of every claim
This analysis was built from a line-level inventory of the codebase:
- **Polygon:** 17 REST endpoints + 1 WebSocket via `src/vendors/polygon/polygon.service.ts` (Starter plan, 15-min delay, 5-yr history; `NOT_AUTHORIZED` on real-time, indices, short interest, >5yr, stable financials).
- **FMP:** 14 `/stable/` endpoints via `src/vendors/fmp/fmp.service.ts` (v3/v4 deprecated → 403; no short interest; EPS-only surprises; per-firm PT ~30% drop).
- **FRED:** `src/vendors/fred/fred.service.ts` + `src/common/macro-series.ts` (WTI, BTC, 12 macro series, regime inputs; gold = GLD × 10.89, not FRED).
- **SEC-EDGAR:** `src/vendors/sec-edgar/sec-edgar.service.ts` + `src/sync/{sec-form4,sec-13f,edgar-8k,edgar-ipo-pipeline}.job.ts` (Form 4, 13F, 8-K/2.02, IPO pipeline).
- **Data-point catalog:** `MarketCatalystUI/app/iq/types/*.ts` + `app/iq/screens/*.tsx`.

> Vendor-catalog capabilities (what each vendor *could* provide beyond what we call today) reflect Polygon.io and FMP published API product lines; the specific FMP `/stable` paths in §3.2 and the Polygon add-ons in §2.2 should be confirmed against current vendor docs and your plan entitlements before commercial commitment.
