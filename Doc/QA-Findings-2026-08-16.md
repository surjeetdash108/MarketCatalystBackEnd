# MarketCatalyst — E2E QA Findings Log

Env: PROD. App=https://app.marketcatalyst.ai, Site=https://marketcatalyst.ai
Test user: test@test.com

## Public marketing site (marketcatalyst.ai)
- [OK] Homepage loads clean, no console errors. Scroll-narrative product showcase = static mock data (expected).
- [OK] /posts (Blogs) loads clean. Real posts grouped Stock 101 / Featured / Educational 101. Light theme + Dark toggle present.
- [OK] /posts/view?slug=10-moving-average-strategy renders article cleanly, "Back to blogs" works, no console errors.
- [FINDING UX-low] Invalid blog slug (/posts/view?slug=<bad>) → bare unstyled Next.js default 404 "This page could not be found." No site header/nav, no back-to-blogs link. Dead end except browser back. Confirmed once.

- [OK] /faqs accordion uses native <details>/<summary> — keyboard accessible (verified). Dark theme.
- [OK] Contact form empty submit blocked by native required validation (name/email/message required, company optional).
- [OK/SECURITY+] Contact form message with <script>/HTML → POST /api/contact returns 400 {"error":"invalid_input"}. Server-side Zod HTML rejection works. No record created.
- [FINDING UX-med] Contact form: on 400 invalid_input, UI shows generic "Something went wrong — please try again." No indication the MESSAGE field content was the problem. A legit user typing angle brackets ("priced < $50", "a > b") trips the HTML filter and cannot self-correct. Reproduced once. Suggest field-level error + clarify allowed content.
- [OK] Contact form happy path: valid submit → POST /api/contact 200, "Thanks — we'll get back to you shortly.", form replaced by confirmation. Creates record in /admin/contact-submissions (1 synthetic test entry: "QA Test Bot" / qa-test@example.com).
- [BUG MED] Footer "Terms of service" (/legal/terms) and "Privacy policy" (/legal/privacy) BOTH return 404. Dead links present in footer of EVERY public page. Compliance concern for a financial product (ToS/Privacy typically required). Confirmed twice.
- [TODO] /#pricing footer anchor — verify homepage has a pricing section target.
- [GAP] Contact form rate-limiting (rate-limit.ts exists) not stress-tested — form replaced by success state after submit.

## App auth (app.marketcatalyst.ai)
- [OK/SEC+] Unauth /dashboard → redirects to /auth/login (AuthGuard works).
- [OK/SEC+] Wrong password → "Email or password is incorrect." (generic, doesn't reveal if email exists).
- [OK] Valid login (test@test.com) → dashboard loads with live data (S&P/NASDAQ/etc.), full left-nav. Note: logged in Sat Aug 16 ~12:39 AM ET, "Markets Closed".
- [OK] All core data endpoints 200: /market-data/{companies,sectors,earnings,movers,news,insider-transactions,market-sentiment,analyst-actions,recaps,earnings-announcements}, /api/{profile,notifications,watchlist,watchlists,portfolio,settings}, /live/{tape,market-status,most-searched-tickers}.
- [FINDING LOW/cosmetic] /live/logo?ticker=VIXY → 404 for tickers/ETFs without a Polygon logo. UI degrades gracefully (img display:none, letter-badge fallback shows) BUT each logoless ticker logs a console error → console noise + likely Sentry noise. Recurs across app.
- [TODO/verify w/ dev] On dashboard load, cross-origin 400 + 404 to identitytoolkit.googleapis.com / firebase.googleapis.com (Firebase Auth/config). Bodies unreadable (cross-origin). Likely benign but confirm no failed token/config path.

- [OK] Session persists across refresh. /auth/login while authed → redirects to /dashboard (non-admin correctly NOT sent to /admin).
- [OK/SEC+] Logout works; clears session. Browser Back after logout → login form, NOT cached dashboard (secure).
- [FINDING UX-med] Auth forms use native alert() for errors/validation.
    * Login: fires BOTH a native alert("Email or password is incorrect.") AND inline red text (redundant/jarring).
    * Signup: validation surfaced ONLY via alert() e.g. "Select at least one preferred asset class." → in browsers that suppress dialogs, submit silently does nothing with ZERO user feedback (repro'd: my JS submit blocked, no visible error). Confirmed via window.alert hook.
    * Fix: replace alert() with inline field-level validation consistent with app design.
- [FINDING LOW] Signup form: no confirm-password field (single "Create a password", minLength=6). Typo in password → account created with unintended password, only recoverable via reset. Consider confirm field.
- [OBS] Signup email <input> has HTML required=false (validation is JS/alert-based, not native). "Preferred asset class" is a required multi-select. Long investor-profile form (name,email,mobile,age,income,experience,goals,risk,asset class,+image ≤650KB).
- [OBS] User menu: "My Profile" shows a "Pending" badge for test@test.com (investor profile incomplete). Menu: My Profile, Settings, Manage Account, Feature Requests, Logout.

- [OK] Forgot-password page loads; email required=true + native format validation ("Please include an '@'..."). Malformed email blocked, no send. NOTE inconsistency: signup email required=false but forgot-password email required=true.
- [GAP] Did NOT trigger a real password-reset email (outward-facing). Delivery/inbox path untested by request.
- [GAP] Google OAuth login/signup ("Continue with Google") not exercised (needs real Google account/redirect).

## App data screens (app.marketcatalyst.ai/menu/*)
- [LIKELY BUG MED/High] Movers: "Top Gainers" tab shows negative movers at top (CAPR -1.97%, BANL -10.80%); "Top Losers" tab shows positive movers at top (AMPG +0.88%, DWSN +2.60%, SSTI +1.45%). Displayed Change% contradicts the tab and isn't sorted by it. Header: "ranked by session move · live prices" → ranking likely by Fri session move while Change col shows frozen weekend ~0% live change = mismatch. MUST re-test during market hours. If reproduces intraday = High (misleads users on winners/losers). Repro'd both tabs while Markets Closed Sat Aug 16.
- [OBS] Movers filters present: Sector (huge SIC-style list), Market cap, tabs Gainers/Losers/Unusual Volume. "100 names · top 50 gainers + 50 losers".

- [OK] Dashboard, Earnings Hub (good empty state Sun), Heatmap (sector treemap + index tabs), Analyst Actions, Macro & VIX (econ calendar + live VIX/Polygon) — all render cleanly with data.
- [OK] Screener: filtering works (RS≥90 → 390→38 matches). Rich filters + embedded candle chart + presets + Save screen.
- [FINDING UX/data-med] Sector dropdown (Screener AND Movers) mixes taxonomies: clean GICS sectors ("Financial Services","Healthcare","Energy") interleaved alphabetically with raw uppercase SIC industries ("BLANK CHECKS","AIR TRANSPORTATION, SCHEDULED","CHEMICALS & ALLIED PRODUCTS"). Confusing/duplicative sector selection.
- [FINDING A11y-med] Screener filter toggles ("RS ≥ 90" etc.) are non-semantic <div> (role=null, aria-checked=null, tabindex=null). Not keyboard-focusable, not announced as checkboxes to screen readers. Likely pattern across custom controls.

- [BUG LOW] Unguarded empty-ticker chart fetch: GET /live/bars?ticker=&tf=3M → 400 "ticker must be 1-10 chars". Fires on chart-bearing screens (Themes, Screener, Stock) before any ticker is selected. Functionally masked ("Select a stock to see chart") but errors every mount → console/Sentry noise + wasted call. Guard: skip fetch when ticker empty. Confirmed multiple times.
- [FINDING LOW/MED] GET /live/tape/stream (SSE) → 503 intermittently. REST-poll fallback (/live/tape) works so tape still updates. Likely Cloud Run/CDN SSE issue. Confirmed once this session.
- [OK] Themes screen renders (Magnificent Seven + theme tabs, AI theme summary, auto-selects a stock). Selecting a ticker loads full stock-detail data layer (bars/company/financials/dividends/splits/news all 200).
- [CONFIRMED cosmetic] Logo 404s widespread: /live/logo?ticker=<X> 404 for many tickers (SNDG,QBTX,NBIG,NBIL,NEBX,CRWG,VIXY,...). UI falls back to letter badge; console/Sentry noise only.

- [OK] IPOs: "Upcoming pipeline" has data (SEC-EDGAR S-1/424B filings w/ SEC filing links). Tabs: Recent perf / Upcoming / Live calendar.
- [POTENTIAL data-gap] IPOs "Recent IPO performance" tab = empty ("0 of 0 shown", stat cards "—") with Sector=All. Likely data-window gap (Polygon IPO perf) but verify pipeline populates recent IPOs.
- [OK] Ownership: Insider activity + 13F tabs, All/Buys/Sells + ticker search, 2290 Form-4 filings (live SEC EDGAR), sorted by $ value.
- [FINDING data-med] Ownership insider row dated 2010-07-29 (SY BUY, $3.79B) interleaved among 2026 filings. Likely date-parse bug or stale filing ingested. Verify against source Form 4.

## Authorization / access control (SECURITY)
- [OK/SEC+] Non-admin /admin (client) → redirects to /dashboard.
- [OK/SEC+] /api/profile without token → 401 (backend enforces auth, not client-only).
- [OK/SEC+] /api/admin/users with VALID non-admin token → 403. Backend AdminGuard enforces role server-side. This is the key check and it PASSES.
- [OK] /plans → 200 (public), /api/profile with token → 200.
- [OK] Global search autocomplete works (live prices, fuzzy matches, star-to-watchlist). NVDA quick-pick → correct stock detail (company desc + chart + indicators).
- [UNCONFIRMED] Clicking "NVDA" in search dropdown once opened "ANV" (NVDA ETF) instead — likely imprecise click on adjacent tight-spaced row; NOT reproduced. Re-verify suggestion click target maps to intended row.
- [GAP] Cross-user data isolation not fully tested (API scopes to token uid by design; needs 2nd account to prove another uid's portfolio/watchlist can't be read).

## CRUD — Watchlist (test user)
- [OK] Create: UI "Add stock" modal + POST /api/watchlists/default/tickers → 201. Read/Delete → 200. Full CRUD works. Cleaned test data back to [AAPL].
- [OK] Duplicate ticker deduped (re-adding AAPL kept count same, 201).
- [BUG MED] Free-tier 5-item watchlist limit NOT enforced. Added 6th/7th ticker → 201 (count 6,7). Docs/architecture say "Free tier limit 5 at API layer" but not enforced (ties to disabled tier-gating). Monetization/plan-differentiation gap.
- [BUG MED] No ticker-existence validation: POST ticker "ZZZZZZ" (nonexistent) → 201, added to watchlist. Only format checked (1-10 chars A-Z0-9.-), not whether symbol exists. Users can pollute watchlist w/ invalid tickers → downstream chart/quote errors.

## CRUD — Portfolio (test user)
- [OK] Add holding: UI modal (ticker search + Position size Small/Med/Large + Conviction High/Med/Low + optional avg cost). POST /api/portfolio/holdings → 201. Delete → 200. CRUD works; test data cleaned.
- [FINDING UX-low] Empty-ticker "Add to portfolio": button is ENABLED but clicking with no ticker silently does nothing (no error message). Same missing-inline-feedback pattern as auth forms.
- [OBS] Entered avg cost "-50" but stored costBasis=null (negative not persisted — either stripped server-side or input not captured; NOT a confirmed bug). "Small" qualitative position stored shares:10 by default.
- [FEATURE noted] Portfolio "Import from photo" (OCR) — file-upload feature not deep-tested (needs image).
- [GAP] Alerts (12 types) create/edit/delete not tested this pass (UI entry point not in main nav; likely per-stock or settings). Recommend follow-up.

## Responsive (mobile 375x812)
- [OK] Sidebar collapses to hamburger; page has NO horizontal page-scroll (canScrollX=false).
- [BUG MED] Dashboard 2-column card grids (index cards + "Most Searched Tickers") do NOT collapse to 1 column on mobile. Right-column cards extend past the 375px viewport and are CLIPPED with no horizontal scroll. Confirmed: AVGO "Most Searched" card right edge = 518px (143px beyond viewport) → its price/change are cut off and unreachable. Index right column (NASDAQ/RUSSELL/10Y) sparklines/badges clipped (values still visible). Fix: single-column stack < ~600px.
- [OK] Top ticker-tape marquee overflow is intentional CSS animation (not a bug).
- [BUG MED/High-for-mobile-users] SYSTEMIC: wide desktop layouts don't adapt to mobile. Movers data TABLE columns (PRICE/CHANGE/RVOL/CATALYST) are fully off-screen right with NO horizontally-scrollable ancestor (scrollableAncestor=null) → core data unreachable on mobile. Industry filter chips also clip. Same root cause as dashboard card grids. Likely affects all table/multi-col screens (screener, analyst, ownership, earnings). Severity High if mobile is a supported target; the app appears desktop-first.
- [OK] Branded full-screen loading state ("MARKETCATALYST" spinner) on full navigation — good loading UX.

- [OK] Live Feed (commentary): Live/Premarket/AfterHours/My names/Macro tabs, feed search+filters, sentiment tags, Polygon news, Before/After the Bell. "Live streaming" indicator.
- [OK] Daily Recap: index perf, 60-sec audio recap, EOD download, Top Headlines, Up Next econ calendar.
- [FINDING data-med] News→ticker mis-tagging + duplication: same "Alphabet Is Facing Thousands of Lawsuits" article shown as separate headlines under PM (Philip Morris), MSFT, and GOOG; "Elon Musk/SpaceX" article duplicated under GOOG and GOOGL. Over-broad entity mapping surfaces irrelevant tickers' headlines to users + clutters feed/recap. Seen on Live Feed AND Recap.

- [OK] Options: curated 8-ticker universe (AAPL,MSFT,NVDA,TSLA,AMZN,META,SPY,QQQ). AAPL loads real delayed chain (strikes/vol/last); Bid/Ask/IV/greeks N/A with clear "needs Options add-on" messaging. Out-of-universe tickers show clear empty state.
- [OK] Settings: clear "Incomplete profile" banner + per-field Pending badges. Edit Profile form loads (fix path).
- [FINDING LOW] Edit Profile: Email field not pre-filled with account email (test@test.com). Should prefill known data.
- [OK] Deep-link/refresh works: direct nav to /menu/* and /settings /profile/edit all load via SPA fallback + branded loader. Back/forward fine.
- [OK] Loading states: branded full-screen spinner on cold nav; per-screen skeletons/placeholders present.

## Website admin CMS (marketcatalyst.ai/admin)
- [OK/SEC+] CMS RBAC rejection works: Google account dash.surjeet@gmail.com authenticated OK but NOT in website_members → CMS blocked login with clear message "isn't an authorized admin or editor. Sign in with an account that has been granted access." Confirms authenticated≠authorized enforcement (requireEditorOrAdmin). No client bypass observed. (Observed via user's real Chrome.)
- [BLOCKED] Remaining CMS tests (blog/FAQ CRUD, media, contact inbox, member RBAC) need a Google account seeded into website_members as ADMIN/EDITOR.

## GAPS (not tested — need creds/tools/market hours)
- Website admin CMS (marketcatalyst.ai/admin): blog CRUD, FAQ CRUD, contact submissions, media upload, member RBAC — NO CMS creds provided.
- App admin console (app /admin): needs admin@marketcatalyst.ai creds.
- Alerts (12 types) CRUD; Manage Plan screen; Feature Requests screen.
- Google OAuth sign-in; password-reset email delivery; Portfolio "Import from photo" OCR upload.
- Movers Gainers/Losers correctness during MARKET HOURS (tested weekend/closed).
- Cross-user data isolation (needs 2nd account).
- Multi-tab session sync; heavy rapid-click race conditions.

## Observations to verify later
- Blog posts include admin test content ("image upload test", "NVDA 10 Page Analysis with REAL Images 9MB") — real published prod content.
- Blog dates show AUGUST 13/2026 (future-ish relative to some content) — admin-set, likely fine.
