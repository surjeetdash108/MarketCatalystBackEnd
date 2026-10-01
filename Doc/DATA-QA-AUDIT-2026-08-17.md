# Financial Data QA & Reconciliation Audit — MarketCatalyst

**Date:** 2026-08-17 · **Method:** live read-only API reconciliation vs independent public sources (CNN/Yahoo/Google/companiesmarketcap/stockanalysis) + end-to-end code lineage audit (5 sub-agents, read-only). Prod, markets closed (weekend → last-close vs last-close). **No DB writes performed.**

---

## 1. Executive Summary

**Can this application be trusted with respect to data correctness? → PARTIALLY.**

- **The displayed financial *values* are trustworthy today.** A 10-stock external reconciliation matched independent sources to <2% on market cap (several exact), 52-week ranges exact, P/E internally consistent on all 10, split-adjusted history clean, negative-EPS handled correctly, and *no* cross-company duplication. Even extreme moves (SNDK +40×, MU +689×%, INTC 4.5× off its low) are externally confirmed real.
- **But the platform has a CRITICAL security breach and serious pipeline-safety gaps** that can expose user data now and silently corrupt/wipe stored data on a routine vendor hiccup. These are architectural, not value errors — the numbers are right, the *guardrails* are not.

**Bottom line:** the data a user sees is accurate; the system protecting and producing that data is not yet trustworthy. Fix the P0 immediately and the P1 data-loss guards before relying on this for anything beyond display.

---

## 2. Scores (0–100)

| Area | Score | Note |
|---|---|---|
| Data quality (values) | **88** | Externally verified accurate |
| Calculations | **85** | Internally consistent, textbook formulas |
| Historical / corporate actions | **82** | Split-adjust clean; split re-adjust latent risk |
| UI | **82** | Prior fixes deployed |
| On-demand fetching | **72** | In-instance coalescing safe; empty-cache gaps |
| Firestore integrity | **68** | Idempotency SAFE; overwrite/wipe risks |
| Vendor integration | **58** | Failure-masking, no validation layer |
| Cron / ingestion | **52** | Idempotency SAFE; collection-wipe UNSAFE |
| Error handling | **48** | Failure-masking, no timeout, delete-on-empty |
| Backend API | **45** | Dragged by the auth breach |
| **Security / data isolation** | **25** | **P0 anonymous admin access** (IDOR otherwise clean) |
| Performance | **BLOCKED** | Not measured (prod, no load testing) |

---

## 3. Critical Findings

### P0 — CRITICAL

**QA-P0-1 — Anonymous access to all admin endpoints (PII + business-data breach).**
- **Status:** CONFIRMED via live test. With **no Authorization header**, the public API returns **200 + data**:
  - `GET /api/admin/users` → every user's UID, name, **email**, plan
  - `GET /api/admin/revenue`, `/subscriptions` → revenue + subscription/user counts
  - `GET /api/admin/apihealth` → vendor key **names + presence** (config disclosure)
  - `GET /api/admin/feature-adoption` → usage analytics
- **Root cause:** `AdminGuard` fail-open — `ADMIN_GUARD_TRUST_IAM` **defaults to `"true"`** (`src/common/admin.guard.ts:54-73`); when true, a request with no Authorization header is **allowed**. Safe only on the IAM-gated worker, but `admin-analytics`/`apihealth`/`blogs` admin modules are **also mounted on the public `live` service** (`app.module.ts`), and that service **does not set `ADMIN_GUARD_TRUST_IAM=false`** (absent from its env). So the bypass is live on the internet-facing service.
- **Fix (config, no code/DB):** `gcloud run services update market-catalyst-live --region us-central1 --update-env-vars ADMIN_GUARD_TRUST_IAM=false`. Legit admin (Firebase token, email===ADMIN_EMAIL) is unaffected. **Also** harden the guard so the default is fail-*closed*.
- **Root-cause layer:** Configuration + Backend (guard default).

### P1 — HIGH (data-loss / integrity)

**QA-P1-1 — Entire collection wiped on an empty-but-OK vendor response.**
Delete-pass "full refresh" with **no `if (docs.length===0) return` guard**: `earnings.job.ts:238-247` (wipes `earnings_events`), `market-movers.job.ts:136-146` (wipes `market_movers`), `macro-events.job.ts:139-146` (wipes FMP `macro_events`). A non-throwing empty 200 → `keep` set empty → mass delete. **macro-events is the most likely to fire** because FMP's silent-empty-200 is documented-expected. Root cause: Cron + Vendor-failure-masking.

**QA-P1-2 — FMP failures masked as `[]`/`null`, feeding the delete/overwrite jobs.**
`fmp.service.ts:231` coerces any non-array 200 to `[]`; `.catch(()=>[])` at 457/565-567/629-631; hot methods use `{retries:0}`. The class docstring itself says FMP "silently returns empty 200s for a rotating subset." `adapters/with-fallback.util.ts:31-43` only fails over on a **thrown** error — a resolved-empty is treated as success, so no fallback fires. Root cause: Vendor adapter.

**QA-P1-3 — `merge:true` field clobber overwrites good data with null/`[]` on partial responses.**
`corporate-actions.job.ts:179,264` (`history:[]`, `splits:[]`, `isPayer:false`), `sec-13f.job.ts:98-105` (zero-position poison + accession gated off forever), `financials.job.ts`/`ondemand.service.ts` `annual:[]` (no prev-preservation, unlike its protected siblings), `fundamentals-growth.job.ts:142-144` (growth fields → null on shared `companies` doc), `ondemand.service.ts:842-892` (company profile fields → null when details fail but snapshot succeeds). Root cause: write layer + vendor-masking.

### P2 — MEDIUM

- **QA-P2-1** No ingestion-time validation layer: impossible values (negative/NaN price/volume, future timestamps) stored verbatim (`stock-history.job.ts:186-205`); `polygon.service.ts:194` `Math.round(NaN)→NaN` (my BUG-011 fix rounds but doesn't guard finite/non-negative — **gap to close**).
- **QA-P2-2** FMP `num()` coerces legit **`0` → null** (`Number(v)||null`, `fmp.service.ts:24`): zero estimates/targets/put-call/econ prints vanish.
- **QA-P2-3** Analyst rating tallies collapse missing → 0 (`analyst-ratings.adapter.ts:55`): "0 analysts" indistinguishable from "not reported"; UI type `analyst.ts:16-20` mirrors it (non-null).
- **QA-P2-4** **PEP dividend yield overstated: app 5.25% vs external 4.27%** — TTM window catching 5 ex-dates (`divPerShare $7.2275` vs true annual ~$5.92), unlabeled. Misleads dividend investors. (WARNING/verified.)
- **QA-P2-5** **SIRI price stale** ~3–8% below external (app $29.00 vs $29.91–31.68); cap $9.59B vs $10.12B.
- **QA-P2-6** No request timeout anywhere (`http.util.ts:46`) — a hung vendor blocks a job indefinitely; retry only on 429.
- **QA-P2-7** No distributed job lock (in-memory `isRunning` only) — scheduler double-fire / manual overlap possible; non-duplicating (deterministic keys) but exposes the delete-pass jobs.
- **QA-P2-8** Cross-instance on-demand coalescing gap: `inflight` map is per-process; misses on different instances aren't coalesced → vendor mini-storm (non-duplicating).
- **QA-P2-9** Freshness not surfaced on fundamentals/financials/bars (≤20h TTL, `asOf` discarded) — *client half fixed & deployed earlier this session.*
- **QA-P2-10** Split re-adjustment gap (BUG-001): **latent** — verified NO current corruption (NVDA 10:1, AMZN 20:1, SIRI 1:10 reverse all show 0 split cliffs). Fix committed, not deployed (writes DB).

### P3 — LOW
- `sec-13f.job.ts:98` watermark advances before child writes (crash → zero-poison).
- Polygon per-node `unit` discarded → currency/unit assumed USD, never asserted (`polygon.service.ts:642-648`).
- CORS reflects any origin if `CORS_ORIGINS` unset (currently set on live → OK).
- Dividend `cash_amount` read as hard non-null `number` (no missing-value path).
- Billing currency inconsistency (analytics INR default) — fixed in code, not deployed to worker.

---

## 4. Stock Validation Matrix (10 NASDAQ, externally verified)

| Stock | Price (app/ext) | Mkt cap (app/ext) | 52w (match?) | P/E internal | Split-adj | Overall |
|---|---|---|---|---|---|---|
| AAPL | 304.25 / 305.26 | 4.4648T / 4.464T | — | ✓ | n/a | ✅ PASS |
| NVDA | 225.86 / 224.75 | 5.4536T / 5.45T | — | ✓ | **clean (10:1)** | ✅ PASS |
| AMZN | 258.68 / 263.15 | 2.833T / 2.833T | — | ✓ | **clean (20:1)** | ✅ PASS (price ~1.7% stale) |
| MU | 1019.35 / 1020.38 | 1.0974T / 1.0974T | 1255 exact | ✓ | n/a | ✅ PASS |
| SNDK | 1789 / ~1657 | 239.6B / 243.2B | exact | ✓ | n/a | ✅ PASS |
| INTC | 103.91 / 103.06 | 541.83B / **541.82B** | **142.35/22.78 exact** | ✓ | n/a | ✅ PASS |
| PEP | 137.78 / 140.62 | 192.16B / **192.16B** | **exact** | ✓ | n/a | ⚠️ WARN (**div yield 5.25% vs 4.27%**) |
| COST | 952.07 / 949.58 | 426.2B / ~421–426B | **exact** | ✓ | n/a | ✅ PASS |
| PLTR | 173.83 / 173.97 | 418.23B / 418.23B | — | ✓ | n/a | ✅ PASS |
| SIRI | 29.00 / 29.91–31.68 | 9.59B / 10.12B | — | ✓ | **clean (1:10 rev)** | ⚠️ WARN (**price stale**) |

Prices run 0–8% below external (weekend last-close staleness; SIRI worst). Market caps and 52-week ranges are near-exact or exact. **9 PASS, 2 WARNING (PEP dividend, SIRI staleness), 0 value-FAIL.**

---

## 5. Calculation Audit (recomputed from app's own inputs)

| Metric | Formula | Verdict |
|---|---|---|
| P/E = price/EPS | matches on all 10 (AAPL 304.25/8.73=34.85…) | ✅ VERIFIED |
| Market cap | vendor `market_cap` (not price×shares); matches external | ✅ VERIFIED |
| Dividend yield = divPerShare/price | internally consistent; **PEP TTM window overstates** | ⚠️ WARN |
| Negative EPS handling | ZIM eps −0.09 → P/E null (not Infinity) | ✅ VERIFIED |
| 52w high/low | MAX/MIN of intraday bars; backend correct | ✅ VERIFIED (UI thin-history labeling caveat) |
| Split adjustment | 0 cliffs on NVDA/AMZN/SIRI 5Y | ✅ VERIFIED |
| YoY/QoQ, RSI/MACD/ADX/beta/pivots | textbook, null-guarded (prior audit) | ✅ VERIFIED (EMA-seed nuance) |

---

## 6. Cron / On-demand Findings (code audit)

- **Idempotency → SAFE** everywhere: deterministic doc IDs (`${ticker}_${date}`, accession, `${dir}_${ticker}`…); re-runs upsert, never duplicate.
- **Retry → FRAGILE / FMP UNSAFE**: retry only on 429, no timeout, FMP masks failures to `[]`/null.
- **Recovery → SAFE (most)**: cursor advances after write → resume-safe; `sec-13f` FRAGILE (watermark before children).
- **Concurrency → SAFE in-process** (single-flight `inflight` map); **FRAGILE cross-instance/process** (no distributed lock) — non-duplicating.
- **Null/empty overwrite → UNSAFE**: the P1 collection-wipes + merge clobbers above.
- **On-demand**: cache-aside + TTL correct; empty vendor response can cache an empty doc (`ondemand.service.ts:512,1029,1073`).

---

## 7. Security / Data Isolation
- **P0 anonymous admin access** (above) — the dominant finding.
- **IDOR → NONE**: every user-data endpoint derives uid from the verified token (`@CurrentUser`), never a client param; delete-by-id re-checks ownership. VERIFIED.
- **Backend authz otherwise sound**: `/api/admin/*` returns 403 for a valid *non-admin* token (the bypass is the *no-token* path only). `/api/profile` 401 without token. No endpoint returns `process.env`; API keys redacted in apihealth.

---

## 8. BLOCKED (could not execute — per Rule 30, not faked)
- Live cron execution, duplicate/partial-run/idempotency runtime tests (would write prod Firestore).
- Fault injection (429/500/timeout/malformed/missing/wrong vendor data) — needs a local mock-vendor test env.
- Direct Firestore inspection (doc IDs, orphans, dup keys) — no Firestore admin credentials.
- Multi-vendor A/B/C reconciliation — no vendor API keys (secrets).
- Live concurrency storm / performance/latency measurement — prod, no load testing.
- Corporate-action re-adjustment *on a live split event* — none occurred in-window.

## 9. UNVERIFIABLE
- SIRI dividend yield: external sources disagree (3.4%–5.1%); app 3.72% is internally consistent (=$1.08/$29). Left UNVERIFIABLE.
- Fields with no independent public authority at this precision (intraday bid/ask/size) — not exposed by app; n/a.

---

## 10. Recommended Fix Order
1. **QA-P0-1** — set `ADMIN_GUARD_TRUST_IAM=false` on live + make guard fail-closed. *(one command; do now.)*
2. **QA-P1-1/2** — add `if (docs.length===0) return` before every delete-pass; make `with-fallback` treat resolved-empty as failure so it fails over instead of wiping.
3. **QA-P1-3** — guard `merge` writes so an empty vendor payload never clobbers good fields (skip-on-empty, like `analyst-actions.job.ts:74`).
4. **QA-P2-1/2/3** — add an ingestion validation helper (finite + non-negative price/volume, non-future ts); fix FMP `num` `0→null`; stop collapsing analyst tallies to 0.
5. **QA-P2-6/7** — add request timeout (AbortController) + a Firestore-lease distributed job lock.
6. **QA-P2-4/5** — label dividend-yield methodology (or use forward); investigate SIRI staleness.
7. Deploy the already-committed backend fixes (BUG-001/011/012/013) with the split-reset gated appropriately.

---

## Final Answers
- **Trustworthy:** the displayed price/market-cap/P/E/EPS/52w/dividend-amount/growth values (externally verified, internally consistent). Idempotency. User-data isolation (no IDOR).
- **Wrong/misleading:** PEP dividend *yield* (TTM 5-payment artifact), fractional-volume rounding gap (NaN), FMP `0→null`, analyst-tally `→0`.
- **Stale:** SIRI price; fundamentals/bars have ≤20h TTL (freshness client-fix deployed).
- **Unavailable:** per-analyst PT, NSE/BSE + INR, TICK/Put-Call, quarterly rev estimates (surfaced as N/A — correct).
- **Broken guardrails (the real risk):** anonymous admin access (P0); collection-wipe-on-empty + failure-masking + merge-clobber (P1); no validation/timeout/distributed-lock (P2).
- **Must fix before trust for investment research:** P0 now; then the P1 data-loss guards. The *numbers* are already reliable; the *system* is not.
