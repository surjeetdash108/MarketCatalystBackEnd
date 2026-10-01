# Email to Financial Modeling Prep (FMP)

**To:** sales@financialmodelingprep.com (and/or your account rep)
**Subject:** MarketCatalyst — consolidating onto FMP as our single data vendor: coverage, plan tier & two gaps

---

Hi FMP team,

We operate **MarketCatalyst**, a market-intelligence application, already using your **`/stable/` API** for the fundamentals/analyst layer (earnings estimates & surprises, analyst consensus/grades/price-targets, institutional 13F ownership, earnings-call transcripts, economic calendar, sector performance, and stock news). We're planning to **consolidate our entire data stack onto FMP** and need to confirm coverage, the right plan tier, and clarify a couple of gaps.

## A) Please confirm the endpoint, the required plan tier, and symbol coverage for each — we intend to move these onto FMP:

1. **Quotes & prices** — real-time (or acceptable delayed) quotes, batch/full-market quotes, and a **WebSocket** — and which plan each needs.
2. **Historical bars** — daily EOD and intraday (1/5/30-min); how much **intraday history** per tier.
3. **Full-market EOD (batch)** — all US listings for a given day (we compute breadth/movers/recaps from this).
4. **Index quotes** — S&P 500, Nasdaq, Dow, Russell 2000, and **VIX** (`^GSPC`/`^IXIC`/`^DJI`/`^RUT`/`^VIX`) — confirm real index levels + VIX.
5. **Commodities** — WTI crude and gold spot.
6. **Crypto** — BTC/USD.
7. **Treasury rates.**
8. **Economic indicators** — CPI, core CPI, unemployment, nonfarm payrolls, fed funds, PPI, retail sales, initial jobless claims, GDP, industrial production, consumer sentiment.
9. **Movers** — biggest gainers / losers / most-active.
10. **Market hours & holidays.**
11. **Dividends & splits.**
12. **Company profile** — sector, industry, description, logo.
13. **Peers** — stock-peers.
14. **Insider trading** (SEC Form 4 equivalent).
15. **IPO calendar** and **IPO prospectus / registration pipeline** (S-1 / 424B) — confirm coverage.
16. **Ticker universe** (stock list) & **symbol search.**
17. **Financial statements** — income, balance sheet, cash flow.
18. **Technical indicators** (or we'll compute from your bars).

## B) Gaps / clarifications — for each, please tell us if it's available (with the endpoint), on the roadmap, or not offered:

1. **Short interest** — do you have any short-interest product or roadmap? *(This is our single hard gap.)*
2. **Revenue (sales) surprise** — actual-vs-estimate for **revenue** (your `/stable/earnings` appears EPS-only; is revenue surprise available?).
3. **Real-time depth** — do you offer true **tick / NBBO**, or quote-level only? Typical latency?
4. **Options** — coverage and depth of your options data.
5. **8-K filings** — do you expose SEC 8-Ks at **item level** (e.g. item 2.02, Results of Operations) with acceptance timestamps?
6. **Per-firm price targets** — coverage/completeness and firm-name normalization (we see gaps joining `grades` ↔ `price-target-news`).
7. **News sentiment** — reliability/coverage of the sentiment field.
8. **Commercial** — rate limits / burst behavior for a single-vendor production load, and **redistribution licensing** if FMP becomes our sole displayed feed.

Could you recommend the **plan tier** that covers the **(A)** items, confirm the **(B)** items, and share pricing? Glad to hop on a call.

Best regards,
[Your name] · [Title]
MarketCatalyst · [email] · [account ID]
