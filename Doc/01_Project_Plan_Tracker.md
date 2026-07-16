**MarketCatalyst — Market Intelligence Terminal**

Project Plan \| v1.1 \| June 2026

> **⚠ Implementation status (updated 2026-07-09, first noted 2026-07-05):**
> This plan describes the original proposed stack — AWS ECS, Redis,
> ClickHouse, BullMQ, Fastify, Stripe billing. What was actually built is
> simpler: a single NestJS backend (`backend/`) syncing
> Polygon/FMP/Finnhub/FRED/SEC EDGAR directly into Firestore via 17 cron
> jobs, with no Redis/ClickHouse/BullMQ/Stripe/Fastify/ECS anywhere in the
> stack. No subscription billing exists yet; Firestore's tier-gating rules
> are relaxed to "any authenticated user" pending that decision. Since this
> note was first added, further build-out has continued in the same
> direction (not a stack change): full US ticker-universe price coverage,
> an IBD-style RS Rating computed from real OHLCV history, a Polygon-primary
> news adapter with automatic Finnhub fallback, materialized portfolio
> totals written back to Firestore, and backend ops tooling (per-job
> Firestore-collection/cron-schedule/next-run tracking, a manual
> "run all jobs" trigger) — the last of these is purely an internal ops
> dashboard, not a MarketCatalyst feature. For what's actually implemented, see
> `Doc/openapi.yaml` (the real API contract, with per-endpoint
> `x-status: live|planned`), `Doc/schema.sql` (relational schema if
> migrating off Firestore), `Doc/screen-data-sources.md` (per-screen live/
> static breakdown, most current), and `backend/src/sync/` (the real jobs).
> The phases/timelines below are kept for historical/roadmap context, not
> as a description of current reality.

1\. Executive Summary

This document is the master project plan for building a subscription-based active investor intelligence platform that consolidates Briefing.com, Earnings Hub, and MarketSurge into a single product with AI-powered insights. The platform targets active retail investors, swing traders, and portfolio investors who need live market intelligence, earnings research, analyst actions, 13F tracking, and peer/group context in one workflow.

The project (branded **MarketCatalyst**) is structured in two phases: MVP (18 weeks) delivering core market data, earnings workspace, and portfolio features; and Phase 2 (additional 20 weeks) adding institutional intelligence, AI Copilot, and mobile. The full UI shell, design system, auth pages, and marketing landing page are complete as of June 2026.

2\. Project Phases

2.1 Phase Overview

  ----------------------- ------------------------------------------------------- -------------- -------------- --------------------------------
  **Phase**               **Theme**                                               **Duration**   **Timeline**   **Success Metric**
  Phase 1 --- MVP         Core platform, live data, earnings, portfolio           18 weeks       Weeks 1--18    50 beta users, \<2s page loads
  Phase 2 --- Expansion   13F, Options, AI Copilot, Mobile, Story Stocks, Cmd+K   20 weeks       Weeks 19--38   500 paying subscribers
  Phase 3 --- Growth      Social, broker import, rotation alerts                  Ongoing        Weeks 39+      Churn \< 5% monthly
  ----------------------- ------------------------------------------------------- -------------- -------------- --------------------------------

2.2 Phase 1 --- MVP Epics (Weeks 1--18)

  ------------------------ ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- -------------- -------------- --------------
  **Epic / Area**          **Key Deliverables**                                                                                                                                                                                                                                                          **Duration**   **Owner**      **Priority**
  Data Layer               Polygon.io + FMP + Benzinga integrations, WebSocket real-time quotes, news feed ingestion, earnings calendar sync                                                                                                                                                             3 weeks        Backend        P0
  Auth & Infra             Firebase Authentication + Firestore setup, Redis cache, CI/CD pipeline, staging env. **UI complete:** landing page (/), login modal, /auth/login, /auth/signup, /auth/forgot-password. All routes return to / on logo click.                                  2 weeks        Infra          P0
  Home Dashboard           \"What Matters Now\" AI card, Market Pulse strip, session tabs (Today/Premarket/Live/AH/This Week), widget grid scaffold                                                                                                                                                      3 weeks        Full Stack     P0
  Earnings Workspace       Earnings calendar (list + Kanban BMO/AMC views), dense data table, tag pills, drawer panel, EPS/Revenue history chart, AI earnings summary, Earnings Setup Card (pre-announce), Earnings Movers Board, Before the Bell & After the Close briefings                            4 weeks        Full Stack     P0
  Market Movers Board      Gainers/Losers/Volume/Gap/High RVol views, catalyst labeling, filter system (index/sector/cap/float/session), peer reactions, technical context (MA posture), Weekly Movers page                                                                                              2 weeks        Full Stack     P0
  Analyst Actions Board    Real-time upgrades/downgrades/initiations/reiterations table, direction arrows, implied upside/downside, stock reaction since action, AI note per action (meaningfulness), portfolio/watchlist filter                                                                         2 weeks        Full Stack     P1
  Portfolio & Watchlists   Manual portfolio creation, per-holding stats (position size bucket, unusual options flag), Portfolio Pulse card, 12 alert types (earnings, analyst, volume, price, 52-wk breakout, peer move, macro event, block trade, 13F filing, group RS rank), email + in-app delivery   3 weeks        Full Stack     P0
  Stock Detail Page        Interactive price chart (overlaid earnings + analyst actions), key stats, earnings history, institutional ownership (top 10 holders, 13F overlap), options activity flags, block trades, peer view, group view (MarketSurge-style), AI TA section (Phase 2)                   3 weeks        Full Stack     P0
  EOD & Weekly Recap       Automated generation pipeline, article + bullets views, email digest delivery                                                                                                                                                                                                 2 weeks        Backend + FE   P0
  VIX & Macro Calendar     VIX widget, economic calendar table, market regime label, recent macro releases                                                                                                                                                                                               1.5 weeks      Full Stack     P1
  Subscription & Billing   Stripe integration, Free/Pro/Premium tier gates, upgrade flow                                                                                                                                                                                                                 2 weeks        Full Stack     P1
  ------------------------ ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- -------------- -------------- --------------

2.3 Phase 2 --- Expansion Epics (Weeks 19--38)

  -------------------------- ------------------------------------------------------------------------------------------------------------------------------------- -------------- ----------------- --------------
  **Epic / Area**            **Key Deliverables**                                                                                                                  **Duration**   **Owner**         **Priority**
  13F Intelligence           SEC EDGAR ingestion, per-fund page, quarterly digest, AI 13F summaries, cross-fund views                                              4 weeks        Backend + FE      P0
  Options & Block Trades     Unusual Whales API integration, options flow board, block trades board, filters                                                       3 weeks        Backend + FE      P0
  AI Market Copilot          Claude-powered chat panel, portfolio context injection, source citation links                                                         3 weeks        AI + Full Stack   P0
  Audio Recaps               TTS pipeline for EOD/weekly recaps, earnings call audio player (Intrinio)                                                             2 weeks        Backend           P1
  Mobile App                 React Native, bottom tab nav, push notifications, condensed views                                                                     6 weeks        Mobile            P0
  Broker Import              Plaid/SnapTrade OAuth, portfolio sync, position reconciliation                                                                        3 weeks        Backend           P1
  Industry Rotation Alerts   Group rank change detection, push/email notification rules                                                                            1.5 weeks      Backend           P1
  Social Sharing             Recap card image generation, share to Twitter/LinkedIn                                                                                1 week         Full Stack        P2
  **Story Stocks Section**   AI-tagged + manually curated story cards (what/why/catalyst date/peer impact), news cluster density trigger, story feed integration   2 weeks        AI + Full Stack   P1
  -------------------------- ------------------------------------------------------------------------------------------------------------------------------------- -------------- ----------------- --------------

3\. Milestones

  ----------------------------- ------------ ---------------------- -----------------------------------------------------------------------
  **Milestone**                 **Target**   **Audience**           **Definition of Done**
  Internal Alpha (MVP subset)   Week 6       Engineering team       Dashboard, earnings calendar, movers, auth working end-to-end
  Closed Beta (MVP complete)    Week 18      50 invited users       All 11 MVP features live, real data, basic alerts
  Public Launch --- Pro Tier    Week 22      General public         Stripe billing, Pro features, onboarding flow polished
  Phase 2 Launch                Week 36      Existing subscribers   13F, Options, Copilot, Audio, Story Stocks live; Mobile in TestFlight
  Mobile GA                     Week 42      App stores             iOS + Android apps publicly available with push alerts
  ----------------------------- ------------ ---------------------- -----------------------------------------------------------------------

4\. Team & Resource Plan

  ---------------------- ----------------- ---------------------------------------------------------------------------------
  **Role**               **Headcount**     **Responsibilities**
  Engineering Lead       1 FTE             Architecture, backend data pipeline, API integrations, AI feature orchestration
  Frontend Engineer      2 FTE             React SPA, component library, dashboard, charts, responsive design
  Backend Engineer       1 FTE             WebSocket server, alert engine, recap generation, broker integrations
  AI / Prompt Engineer   0.5 FTE           AI earnings summaries, Copilot prompts, 13F summaries, TA generation
  Mobile Engineer        1 FTE (Phase 2)   React Native app, push notifications, offline states
  Product / Design       1 FTE             UX flows, Figma designs, component specs, user research
  QA Engineer            0.5 FTE           Test plans, regression suites, data accuracy validation
  ---------------------- ----------------- ---------------------------------------------------------------------------------

5\. Technology Stack

Frontend (Current)

-   **Next.js 14 (App Router)** + TypeScript, static export (`output: 'export'`)

-   **Redux Toolkit** for global state (auth slice + profile slice); no Zustand, no React Query

-   **MarketCatalyst custom CSS design system** (`iq.css`) with CSS custom properties — no TailwindCSS for MarketCatalyst screens. Branding: "Stock**Wise**" wordmark with `--ai` cyan accent on "Wise"; logo uses brand→ai gradient with SVG bolt icon.

-   Recharts / D3 for charts and heatmaps (Phase 2 — static data currently)

-   **Firebase Hosting** for static site deployment (project: `fin-app26`)

-   **Firebase Authentication** — email/password + Google OAuth

-   **Cloud Firestore** — user profiles (`users/{uid}`), settings (`settings/{uid}`)

Backend (Planned — Phase 1/2)

-   Node.js + Fastify (API server), Python (data ingestion workers)

-   Firestore (domain document DB), Redis (cache + pub/sub for WS), ClickHouse (time-series market data)

-   BullMQ for background job queues (recap generation, alert dispatch)

-   **Anthropic Claude API** (claude-sonnet-4-6 or latest) for AI summaries, Copilot, TA generation

Infrastructure (Planned)

-   AWS: ECS Fargate (API + workers), ElastiCache Redis, S3 (audio, exports), CloudFront, Route 53

-   Firebase Hosting (frontend — already live), Firebase Authentication + Firestore (auth + data store)

-   Stripe for subscription billing (Free / Pro / Premium tiers)

-   Datadog for observability, PagerDuty for alerting (planned). **Error monitoring is already scaffolded** via Sentry — `@sentry/browser` (frontend, `app/sentry-init.tsx`) + `@sentry/node` (backend, `main.ts`), wired into the error boundaries + process handlers; DSN-gated (no-op until `NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_DSN` are set).

Data Vendors

-   Polygon.io --- real-time quotes, OHLCV, block trades

-   Financial Modeling Prep --- earnings calendar, fundamentals, sector/group data

-   Benzinga --- news, analyst actions, earnings actuals

-   Unusual Whales API --- options flow and unusual activity

-   SEC EDGAR --- 13F filings (free)

-   Finnhub --- macro/economic calendar

6\. Risks & Mitigations

  ------------------------------------------ ---------------------------------- ---------------- -------------------------------------------------------------------------
  **Risk**                                   **Category**                       **Likelihood**   **Mitigation**
  Real-time data API costs exceed budget     API vendor pricing                 High             Negotiate volume pricing early; add caching layer to reduce call volume
  AI summary latency \>2 min post-earnings   Model inference speed              Medium           Pre-stage prompts; use async queue with in-app loading state
  Earnings transcript availability gaps      Motley Fool / Refinitiv coverage   Medium           Fallback to press release parsing; surface \'transcript pending\' state
  SEC EDGAR rate limits for 13F parsing      EDGAR API limits                   Low              Batch overnight ingestion; cache quarterly filings in own DB
  WebSocket connection drops under load      Infra scalability                  High             Load test to 10k concurrent; implement reconnect with state sync
  ------------------------------------------ ---------------------------------- ---------------- -------------------------------------------------------------------------

7\. Subscription Model

Tier Structure

  ---------- ----------- ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Tier**   **Price**   **Included Features**
  Free       \$0/mo      Delayed data, limited movers view, daily recap (read-only), watchlist up to 5 names, no AI features
  Pro        \$TBD/mo    Real-time data, full movers board, AI earnings summaries, AI technical analysis (4 tone modes), analyst actions board, portfolio/watchlist with 12 alert types, macro dashboard, VIX widget, Before the Bell + After the Close briefings, EOD and weekly recap
  Premium    \$TBD/mo    Everything in Pro plus: 13F intelligence with AI summaries, unusual options activity, block trades, AI Market Copilot, audio recaps, expanded alerts (SMS + push), industry rotation alerts, story stocks, social sharing, weekly deep recap with portfolio view
  ---------- ----------- ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

8\. Definition of Done --- MVP

-   All 11 MVP features have passed QA and are deployed to production

-   Real-time data latency \< 1 second (WebSocket feed)

-   Page load time \< 2 seconds on desktop (LCP)

-   AI earnings summaries generated within 5 minutes of transcript availability

-   Email alert delivery \< 60 seconds from event trigger

-   50 beta users onboarded with at least 10 active daily users

-   No P0/P1 bugs open at launch

-   Stripe billing live with Free and Pro tiers gated
