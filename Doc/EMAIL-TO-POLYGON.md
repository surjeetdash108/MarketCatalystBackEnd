# Email to Polygon.io

**To:** sales@polygon.io (and/or your account rep)
**Subject:** MarketCatalyst — evaluating Polygon as our single data vendor: availability, plans & pricing

---

Hi Polygon team,

We operate **MarketCatalyst**, a market-intelligence application, currently on your **Stocks Starter** plan (15-minute delayed, 5-year history). We're evaluating **consolidating our entire data stack onto Polygon** and need to confirm what's available — and at which plan/add-on and price — before we commit.

**What we already run on Starter today:** aggregates/bars, universal snapshots, grouped-daily (movers), dividends & splits, related-companies (peers), market status & holidays, treasury yields (`/fed/v1`), GAAP financials (`/vX/reference/financials`), IPO calendar, options contracts, ticker news, ticker details (name/SIC/market-cap/description/logo), and the full ticker reference/universe.

We'd appreciate your answers in two groups.

## A) Products we believe you offer — please confirm the exact endpoint, the plan/add-on required, and pricing:

1. **Real-time US equities** (removing the 15-min delay) + the **real-time WebSocket** (`wss://socket.polygon.io`).
2. **Indices** — real index levels for **S&P 500, Nasdaq-100, Dow, Russell 2000, and VIX** (e.g. `I:SPX`, `I:NDX`, `I:DJI`, `I:RUT`, `I:VIX`). *(We currently approximate these with ETFs.)*
3. **Short Interest / Short Volume** endpoints.
4. **Crypto** (e.g. `X:BTCUSD`).
5. **Historical aggregates beyond 5 years.**
6. The **non-experimental Financials API** (`/stocks/financials/v1/*`) — which plan/add-on it requires.

## B) Data we need but couldn't find in your catalog — for each, please tell us (a) whether it's available today with the endpoint + plan, or (b) if not, whether it's on your roadmap or can be provided:

7. **Analyst data** — consensus ratings (buy/hold/sell), rating changes (upgrades/downgrades), and **price targets** (consensus + per-firm).
8. **Forward earnings estimates** — consensus EPS/revenue estimates.
9. **Consensus / non-GAAP (adjusted) EPS** — actual-vs-estimate for beat/miss. *(Your Financials API is GAAP-from-filings; we need the Street/consensus basis that matches NASDAQ/IBD.)*
10. **Forward earnings calendar** — upcoming report dates for the full US market, with EPS/revenue estimates.
11. **Institutional ownership / 13F rollup** — ticker-indexed % owned and holder counts.
12. **Earnings-call transcripts.**
13. **Economic data** — a **forward economic-release calendar with consensus estimates**, plus a broad set of macro series (CPI, core CPI, unemployment, nonfarm payrolls, fed funds, PPI, retail sales, initial jobless claims, GDP, industrial production, consumer sentiment). *(Your `/fed/v1` appears limited to treasury yields + inflation.)*
14. **Commodities spot** — WTI crude and gold spot (not ETF proxies).

Could you share pricing for the plan/add-on combination that covers the **(A)** items, and indicate which **(B)** items you support (or plan to)? Happy to set up a call.

Best regards,
[Your name] · [Title]
MarketCatalyst · [email] · [account / current plan ID]
