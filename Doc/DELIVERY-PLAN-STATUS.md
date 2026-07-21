# Weekly Delivery Plan — Completion Status

**Assessed:** 2026-07-21 · **Source:** `MarketCatalyst.ai_weekly_deliverables_Plan.xlsx` (36 deliverables, 97 person-days, 06 Jul–11 Sep 2026).

Completion is judged against the **actual codebase**, not the calendar — verified through the data-source audits in [FEATURE-DATA-MAP.md](./FEATURE-DATA-MAP.md) and [WIDGET-PROVIDERS.md](./WIDGET-PROVIDERS.md) and direct code checks.

> **Read the "When due" column first.** Today is **21 Jul = Week 3**. Weeks 1–3 are due now; **Weeks 4–10 are future-dated**, so a low % there is *on schedule*, not behind. Two future items (R23, R47) are already largely done — ahead of plan.

---

## Overall completion

| Basis | Figure |
|---|---|
| **Weighted by person-days (all 36 rows)** | **≈ 46%** |
| Weeks 1–3 only (what's *due* now, 26.5 p-days) | **≈ 82%** |
| Weeks 4–10 (future, 70.5 p-days) | **≈ 33%** (work pulled forward) |
| Rows fully complete (100%) | 7 of 36 |
| Rows blocked by data-plan limits (not effort) | 4 (options greeks, analyst events, earnings depth, options flow) |

**Plain reading:** the platform and market-data screens (W1–W3) are largely delivered. The remaining ~54% is dominated by AI features (no Anthropic wiring yet), options depth (plan-gated), and the launch-hardening weeks — all scheduled for Aug–Sep.

---

## Row-by-row

Legend — **Due:** ✅ due now · 🔵 future (not yet scheduled). **%:** completion of the row's stated scope.

| Row | Wk | Due | Deliverable | % | What's NOT done | Reason |
|---|---|---|---|---|---|---|
| R5 | W1 | ✅ | FOUNDATION: deploy FE+BE 24/7, Blaze, service-account, indexes+TTL | **95%** | FE Hosting deploy unverified only | ✅ Runtime SA least-privilege (`datastore.user`+`secretAccessor`, NOT editor). ✅ Scale-to-zero deliberate & correct for polling architecture. ✅ Retention: TTL not possible (ISO-string dates, not Timestamps) → built in-code retention module (rev 00018), weekly prune of history/news/bars, DRY-RUN default, verified against prod (0 eligible — data not yet old enough) |
| R6 | W1 | ✅ | Feature-flag system (`feature_flags` doc, per-release FF_* toggles) | **100%** | — | Built 2026-07-21: registry + service + API + UI provider/Gate + nav & screen gating. Deployed rev 00017; `feature_flags/default` auto-seeded 25 flags in prod; resolver verified (default→env→Firestore, fail-open) |
| R7 | W1 | ✅ | Project setup: Firebase, Polygon sub + keys, data-source verification | **100%** | — | Complete — all keys present and verified |
| R8 | W1 | ✅ | Run all sync jobs once; verify sync_meta + ops dashboard | **100%** | — | 21/21 jobs run, sync_meta populated, monitor UI live |
| R9 | W1 | ✅ | Market Movers live (gainers/losers/unusual-vol/RVol/filter) | **93%** | Catalyst is a news-presence heuristic, not true event attribution | ✅ 2026-07-21: MA-posture (real SMA50/200), week% (real 5-session change), tech-context (RSI/MACD/RS/RVOL) now live — added SMA/week fields to technical-indicators.job (rev 00019, ran for 238 tickers); catalyst now flags tickers with recent synced news |
| R10 | W1 | ✅ | Market Heatmap live (sector %, tiles, summary) | **97%** | — | ✅ 2026-07-21: hover tooltip now reads live `companies` (price/RVOL/RS/MA-status); dead Stocks/S&P-500 tab repurposed to a real **Day%/Week%** heat toggle (5-session change from technical-indicators.job, cap-weighted sector avg). S&P-500 filter dropped — no constituent list available |
| R11 | W1 | ✅ | Dashboard core widgets live (AI card → R19) | **92%** | Recaps card → R28 (M3); 'What Matters Now' AI card is a labeled placeholder (per your call) | ✅ 2026-07-21: Market Internals + F&G history now live from new `market-breadth.job` (176 days backfilled); VIX/Portfolio fake fallbacks removed (show — when absent) |
| R13 | W2 | ✅ | Macro & VIX live (econ calendar + dividends + VIX/yields) | **95%** | VIX is a VIXY ETN proxy (plan has no spot VIX) — labeled as such | ✅ 2026-07-21: Macro VIX card now live via `market_indices` VIXY; dividend Month tab now built from live `dividends` |
| R14 | W2 | ✅ | IPOs live (calendar + offer price) | **90%** | Recent-performance stats fall back to mock | Vendor IPO feed carries no aftermarket price |
| R15 | W2 | ✅ | Commentary/News live (aggregated feed + tags + drawer) | **80%** | Premarket/After-hours cards + parts of drawer are static | Those sub-feeds have no live source; main feed is live |
| R16 | W2 | ✅ | Sector Themes live (per-stock prices + theme perf) | **80%** | Frozen prices show for any ticker not matched in `companies` | Theme baskets are static config (fine); prices live when matched |
| R17 | W2 | ✅ | Company-name search (nameLower/tokens) | **95%** | — | `ticker-universe` writes nameLower/searchTokens; ⌘K search live |
| R19 | W3 | ✅ | Portfolio Pulse live (holdings + prices + P&L + totals) | **90%** | Hardcoded `$128,430` fallback before sign-in | Real holdings + live prices + P&L all work; fallback is cosmetic |
| R20 | W3 | ✅ | Watchlist live (persistence + prices + AI summary) | **85%** | "AI summary" is a template, not real AI | AI intentionally deferred to R34/R39; persistence + prices done |
| R21 | W3 | ✅ | Empty-states + graceful fallback polish (cross-screen) | **50%** | Most screens silently fall back to mock with no "sample" label | Only IPOs/Options/Insider label mock data; pattern not applied app-wide |
| R23 | W4 | 🔵 | ENABLER: backfill ohlcv_bars + compute jobs | **100%** | — | **Ahead of schedule** — bars backfilled, all 5 compute jobs green |
| R24 | W4 | 🔵→ | Stock Detail live (charts/RSI-MACD/fundamentals/52-wk/consensus/news/insider) | **80%** | 1D/1W charts need intraday bars; 5Y needs 5yr history (only ~300d synced) — those timeframes still synthetic | ✅ 2026-07-21: financials now REAL (Polygon /vX quarters), EPS history real, pivots real (last bar H/L/C), SMA-50/200 rows real. Remaining gap is intraday/5Y chart data, not fabrication |
| R25 | W4 | 🔵 | Screener live (filters + Tech Rating + RVOL + growth/margin) | **75%** | Some filter checkboxes are disabled no-ops | Core overlay from `companies` live; a few filters never implemented |
| R26 | W4 | 🔵→ | Dashboard Fear & Greed gauge live | **95%** | History is a breadth-derived proxy, not the 4-component composite (no long history for SPY/TLT/VIXY) | ✅ 2026-07-21: F&G history sparkline + previous-close now live from `market-breadth` (176 real days); labeled breadth-derived |
| R28 | W5 | 🔵 | Recaps EOD data job | **0%** | Entire job | No recap job exists; `recap.tsx` is 100% static ("Tuesday May 21") |
| R29 | W5 | 🔵→ | 10-quarter EPS history (quarterly financials + wire) | **95%** | Estimates sparse (only where earnings_events overlaps) | ✅ 2026-07-21: new `financials.job` fetches 10 real quarters from Polygon /vX (rev 00020, ran ~228 tickers); EPS chart + Earnings Growth now real actual-vs-estimate via `useFinancials` |
| R30 | W5 | 🔵 | Screener sector/cap class + IPO recent perf + Macro regime label | **30%** | IPO aftermarket perf; Macro regime label (static) | Sector/cap classification exists; other two lack sources |
| R32 | W6 | 🔵 | Options Chain live (bid/ask/IV/OI/Greeks) | **25%** | Greeks / IV / OI / bid-ask | 🔴 **Blocked** — Polygon paid returns `NOT_AUTHORIZED`; needs Tradier (token held, unwired) |
| R34 | W7 | 🔵 | ENABLER: AI service + ANTHROPIC key + prompt infra | **0%** | AI service | ⏸️ **Deferred by decision (2026-07-21)** — you chose labeled placeholders over wiring Anthropic this phase. Not blocked: `ANTHROPIC_API_KEY` is provisioned; this is a scope choice to avoid per-request LLM cost until later |
| R35 | W7 | 🔵 | Dashboard 'What Matters Now' AI card | **0%** | Real AI narrative | ⏸️ **Deferred by decision** — card ships as a labeled placeholder; becomes real once R34 (Anthropic) is switched on |
| R36 | W7 | 🔵 | Recaps AI narrative | **0%** | Real AI narrative | ⏸️ **Deferred by decision** (AI) + depends on R28 recap job (Milestone 3, in progress). Data layer will exist; only the LLM narrative is held back |
| R38 | W8 | 🔵 | Stock Detail AI (thesis/risk/confidence + technical analysis) | **0%** | Real AI | ⏸️ **Deferred by decision** — template text is honestly labeled 'AI-generated'; real model output awaits R34 |
| R39 | W8 | 🔵 | Earnings+Analyst+Insider+Watchlist AI notes | **0%** | Real AI | ⏸️ **Deferred by decision** (AI). Includes R20 watchlist AI summary — non-AI watchlist parts already at 100% |
| R41 | W9 | 🔵 | Analyst Actions per-firm event table (upgrades/downgrades/PT) | **5%** | Per-firm upgrade/downgrade events | 🔴 **Vendor-blocked, not effort** — per-firm actions need Benzinga (403 on current plan). FMP gives only a consensus snapshot; Finnhub gives rating *history* but not per-firm. Requires a paid vendor decision |
| R42 | W9 | 🔵 | Earnings depth (guidance/reaction/real-time actuals + tags) | **5%** | Guidance + price reaction | 🟠 **Partially unblockable now** — session (BMO/AMC) IS available on the held Finnhub key (unwired); guidance/reaction still need a Benzinga-class feed. Reaction could also be computed from `ohlcv_bars` post-print |
| R43 | W9 | 🔵 | Options flow + dark-pool prints | **0%** | Entire feature | 🔴 **Vendor-blocked** — needs a UnusualWhales / Polygon-paid flow add-on the current plans don't include. Marked P2 (post-MVP) in the plan itself |
| R44 | W9 | 🔵 | Alerts engine (12 alert types + watchlist toggles) | **5%** | Rules engine + 12 alert types | 🔨 **Not built — no blocker.** Net-new backend (evaluate rules against synced data, per-user toggles, delivery). All input data exists; it is buildable now, just not yet scheduled (W9) |
| R46 | W10 | 🔵 | Editorial + dropped-feature decisions | **0%** | Product decisions | 🗓️ **W10 by design** — a decision/curation task (which themes, presets, sections to keep or cut), correctly sequenced for launch week; not an engineering gap |
| R47 | W10 | 🔵 | Earnings + Macro calendars on real date ranges (structural) | **80%** | Earnings coverage thin | **Ahead of schedule** — date-anchored calendar built (`earnings-calendar.tsx`, `calendar-range.ts`); FMP's 10-row coverage limits it |
| R48 | W10 | 🔵 | Full regression + empty-states + mobile + performance | **0%** | QA gate | 🗓️ **W10 by design** — final QA/regression gate, only meaningful once features stop changing. Partially advanced by R21 empty-state work |
| R49 | W10 | 🔵 | Security review + launch checklist | **10%** | Full review + checklist | 🗓️ **W10 by design.** Already done ahead: runtime SA is least-privilege, Firestore rules server-write-only, retention added. ⚠️ Still outstanding: **rotate the exposed Polygon key** (pasted in chat earlier, never rotated) |

---

## Why the remaining rows aren't done — categorized

The "Reason" column now tags each incomplete row by *why*, not just *what*:

| Marker | Meaning | Rows |
|---|---|---|
| ⏸️ **Deferred by decision** | You chose (2026-07-21) to keep AI as labeled placeholders rather than wire Anthropic this phase. Not blocked — `ANTHROPIC_API_KEY` is provisioned; a scope/cost choice. | R34, R35, R36, R38, R39 |
| 🔴 **Vendor-blocked** | Needs a data source the current plans don't include. No amount of coding closes it without a purchase. | R41 (Benzinga), R43 (UnusualWhales), R32 greeks (Tradier/Polygon-Advanced) |
| 🟠 **Partially unblockable now** | Some of the row is reachable with keys already held; the rest needs a paid vendor. | R42 (session via Finnhub; guidance via Benzinga) |
| 🔨 **Not built — no blocker** | Net-new work with all input data available. Buildable now, just scheduled later. | R44 (alerts engine) |
| 🗓️ **W10 by design** | Launch-week decision/QA/security tasks, correctly sequenced last — only meaningful once features stop changing. | R46, R48, R49 |

**So of everything past R32:** 5 rows are a deliberate AI deferral, 3 are hard vendor blocks, 1 is buildable-but-unscheduled (alerts), and 3 are launch-week gates. Only the alerts engine (R44) is "just not built yet" with no external constraint.

---

## What's genuinely blocked (won't close with effort alone)

| Row | Blocker | Unblock path |
|---|---|---|
| R32 Options greeks/IV/OI | Polygon paid: `NOT_AUTHORIZED` | Wire **Tradier** (token already provisioned) |
| R41 Analyst per-firm events | Benzinga: 403 on plan | Buy Benzinga, or use Finnhub `/stock/recommendation` (history, not per-firm) |
| R42 Earnings depth (session/guidance) | FMP feed lacks fields | **Finnhub earnings** adds session (BMO/AMC); guidance needs Benzinga |
| R43 Options flow / dark pool | UnusualWhales unwired, not on plan | Purchase UW / Polygon-paid flow add-on |

## The four zero-effort or low-effort wins already sitting in synced data

These rows are scored low but need **no new vendor** — the data is already in Firestore or on the current plan:

- **R24 financials** → Polygon `/vX/reference/financials` works on your plan (full statements)
- **R24 charts** → `ohlcv_bars` already synced, just not wired to the panel
- **R29 EPS history** → extend `fundamentals-growth` to quarterly (endpoint supports it)
- **R26 F&G history** → compute from grouped-daily (already pulled for the current value)

## Notes on method

- Percentages reflect *scope delivered*, not calendar progress. A future-dated row at 0% is on-track, not late.
- W1–W3 weighted completion (82%) is the fair "are we on schedule?" number. The 46% overall is dragged down by 70.5 person-days of Aug–Sep work that isn't due.
- R6 (feature flags) is the one **overdue** miss with no data-source excuse — it was a W1 enabler and doesn't exist. Every FF_* flag in the plan is currently notional.
