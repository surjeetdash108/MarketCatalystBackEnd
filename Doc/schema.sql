-- ============================================================================
-- MarketCatalyst (FinApp26) — relational schema mirror
-- ============================================================================
-- Purpose: a drop-in relational model of the data MarketCatalyst currently keeps
-- in Firestore, so that migrating off Firestore (to Postgres, or adapted to
-- MySQL/SQLite) doesn't require redesigning the data model from scratch.
-- Every table below corresponds 1:1 to a schema in Doc/openapi.yaml and to a
-- real Firestore collection written by a backend/src/sync/*.job.ts — the
-- comment on each table cites both.
--
-- Target dialect: PostgreSQL 14+. Kept portable on purpose: no native arrays
-- (Firestore's string[] fields like `peers`/`tickers` are normalized into
-- join tables below, which is better relational practice anyway and ports
-- cleanly to MySQL/SQLite too), CHECK constraints instead of custom ENUM
-- types, BIGSERIAL only where Firestore had no natural key.
--
-- Two categories, clearly marked so you don't mistake a guess for a
-- verified shape:
--   LIVE    — mirrors a table that's actually implemented and populated by
--             a real sync job today. Field-for-field accurate as of the
--             OpenAPI spec's last edit.
--   PLANNED — mirrors an OpenAPI path marked x-status: planned (no backend
--             job exists yet). Shape is a reasonable guess based on the
--             named vendor's typical payload — NOT verified against real
--             data. Expect to revise once actually built. See each table's
--             comment for which vendor/blocker it's waiting on.
--
-- One deliberate improvement over Firestore, not just a mirror: several
-- Firestore collections only ever kept the LATEST snapshot (e.g.
-- market_movers/{gainer_NVDA} was overwritten every sync, no history). This
-- has since been fixed in the live backend too (market_movers_history,
-- sectors_history, market_indices_history — see backend/src/sync/*.job.ts),
-- not just here; the tables below mirror that fix rather than inventing a
-- new one. Where it applies, the table adds a date/time column to the
-- primary key so history accumulates naturally instead of being discarded.
--
-- WRITE-PATTERN TAXONOMY — every table below is one of three kinds. Getting
-- this right is what prevents both "duplicate rows" and "silently
-- overwritten history":
--   IMMUTABLE / APPEND-ONLY   Once a row's key exists, its data can never
--                             legitimately change (a closed trading day's
--                             bar, a filed Form 4, a published article).
--                             Write with `INSERT ... ON CONFLICT (key) DO
--                             NOTHING` — re-running a sync over a range you
--                             already have is then a cheap no-op, never a
--                             duplicate. Tables: ohlcv_bars,
--                             insider_transactions, fund_filings,
--                             fund_positions, news_articles,
--                             market_movers_history, sectors_history,
--                             market_indices_history.
--   MUTABLE / UPSERT-LATEST   A current-state snapshot that's expected to
--                             change on every sync (today's price, this
--                             ticker's consensus rating). Write with
--                             `INSERT ... ON CONFLICT (key) DO UPDATE SET
--                             ...`. Tables: companies, analyst_consensus,
--                             fund_holdings, sync_meta, market_movers,
--                             sectors, market_indices (these last three are
--                             the "latest" siblings of the history tables
--                             above — both get written in the same
--                             transaction by the same sync job).
--   HYBRID                   Starts mutable, becomes immutable once a
--                             specific field is filled in. earnings_events
--                             needs UPSERT while eps_actual is still null
--                             (pre-report) but never changes again once the
--                             actual is reported — safe to UPSERT
--                             unconditionally either way since a settled
--                             row will just overwrite itself with identical
--                             values.
-- Warnings (adapter_warnings) are a special case: NOT append-only. A given
-- entity's warning list is fully replaced on every sync (Firestore just
-- overwrites the `warnings` array field wholesale) — so write it as
-- `DELETE FROM adapter_warnings WHERE entity_table=... AND entity_key=...`
-- immediately followed by fresh INSERTs, in the same transaction. Otherwise
-- a warning that only ever fired once (e.g. a one-off vendor blip) would
-- accumulate forever instead of reflecting the current state.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- for gen_random_uuid() on tables that had a Firestore auto-id


-- ============================================================================
-- LIVE — Companies (Doc/openapi.yaml: Company; Firestore: companies/{ticker};
-- written by backend/src/sync/companies.job.ts)
-- ============================================================================

CREATE TABLE companies (
  ticker              TEXT PRIMARY KEY,
  name                TEXT,
  price               DOUBLE PRECISION,
  pct_change          DOUBLE PRECISION,
  market_cap          DOUBLE PRECISION,           -- USD, raw dollars (not billions)
  beta                DOUBLE PRECISION,
  sector              TEXT,
  industry            TEXT,
  exchange            TEXT,
  week52_range        TEXT,
  volume              DOUBLE PRECISION,
  average_volume      DOUBLE PRECISION,
  description         TEXT,
  pe_ratio            DOUBLE PRECISION,           -- null when FMP's ratios-ttm plan restriction rejects this symbol
  eps                 DOUBLE PRECISION,
  dividend_yield      DOUBLE PRECISION,
  dividend_per_share  DOUBLE PRECISION,
  source              TEXT,                       -- 'fmp' | 'polygon' — which CompanyProfileAdapter served THIS row (may differ from the configured primary; see warnings)
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  rs_rating           SMALLINT CHECK (rs_rating BETWEEN 1 AND 99),  -- written by rs-rating.job.ts, NOT companies.job.ts — see that job's docblock. An independent from-scratch approximation of an IBD-style score, not the literal proprietary IBD formula. NULL until enough real ohlcv_bars history exists.
  rs_rating_updated_at TIMESTAMPTZ,
  -- Computed indicator/score columns (added 2026-07-12), written by the
  -- no-vendor compute jobs, NOT companies.job.ts. All NULL until enough real
  -- ohlcv_bars history (or a Polygon financials call) exists.
  rsi14                DOUBLE PRECISION,   -- technical-indicators.job (RSI 14, from ohlcv_bars)
  macd                 DOUBLE PRECISION,   -- technical-indicators.job (MACD 12/26 line)
  macd_signal          DOUBLE PRECISION,   -- technical-indicators.job (9-period signal)
  macd_histogram       DOUBLE PRECISION,   -- technical-indicators.job (line - signal)
  rvol                 DOUBLE PRECISION,   -- technical-indicators.job (relative volume, latest ÷ 20-day avg)
  technicals_updated_at TIMESTAMPTZ,
  tech_rating          SMALLINT CHECK (tech_rating BETWEEN 1 AND 99),  -- tech-rating.job (composite momentum/trend/RSI percentile)
  sector_rank          INTEGER,            -- tech-rating.job (this stock's rank WITHIN its sector by tech_rating)
  sector_rank_total    INTEGER,            -- tech-rating.job (number of ranked stocks in the sector)
  tech_rating_updated_at TIMESTAMPTZ,
  revenue_growth_yoy   DOUBLE PRECISION,   -- fundamentals-growth.job (decimal, 0.064 = 6.4%; from Polygon financials)
  eps_growth_yoy       DOUBLE PRECISION,   -- fundamentals-growth.job (decimal)
  gross_margin         DOUBLE PRECISION,   -- fundamentals-growth.job (decimal, 0.469 = 46.9%)
  fundamentals_fiscal_year TEXT,           -- fiscal year the growth/margin figures are for
  fundamentals_updated_at  TIMESTAMPTZ
);
CREATE INDEX idx_companies_sector ON companies(sector);

-- Normalizes Company.peers (string[] in Firestore/OpenAPI)
CREATE TABLE company_peers (
  ticker       TEXT NOT NULL REFERENCES companies(ticker) ON DELETE CASCADE,
  peer_ticker  TEXT NOT NULL,
  PRIMARY KEY (ticker, peer_ticker)
);

-- Full US ticker universe (Doc/openapi.yaml: TickerListing;
-- Firestore: tickers/{ticker}). Reference columns written weekly by
-- backend/src/sync/ticker-universe.job.ts; price/pct_change/volume written
-- daily by backend/src/sync/market-quotes.job.ts (a near-free byproduct of
-- the same grouped-daily diff /market-movers already computes — see
-- backend/src/vendors/polygon/polygon-diff.util.ts). Still no fundamentals
-- (P/E, sector, etc.) for the full universe — deliberately NOT foreign-keyed
-- to companies(ticker), since most rows here won't have a matching companies
-- row (that stays limited to the curated 241-ticker fundamentals universe).
-- MUTABLE/upsert-latest either way — no history kept.
CREATE TABLE tickers (
  ticker              TEXT PRIMARY KEY,
  name                TEXT,
  name_lower          TEXT,               -- lowercased name for case-insensitive prefix search (added 2026-07-12)
  search_tokens       TEXT[] NOT NULL DEFAULT '{}', -- name words + ticker, for whole-word (array-contains) name search
  market              TEXT,
  locale              TEXT,
  primary_exchange    TEXT,               -- Polygon MIC code, e.g. XNAS, XNYS
  type                TEXT,               -- e.g. CS (common stock), ETF, ADRC, WARRANT
  active              BOOLEAN NOT NULL DEFAULT true,
  currency_name       TEXT,
  cik                 TEXT,
  composite_figi      TEXT,
  share_class_figi    TEXT,
  source              TEXT,               -- 'polygon'
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  price               DOUBLE PRECISION,    -- NULL until market-quotes.job.ts has run for this ticker
  pct_change          DOUBLE PRECISION,
  volume              DOUBLE PRECISION,
  as_of_date          DATE,
  quote_source        TEXT,               -- 'polygon'
  quote_updated_at    TIMESTAMPTZ
);
CREATE INDEX idx_tickers_type ON tickers(type);
CREATE INDEX idx_tickers_exchange ON tickers(primary_exchange);
CREATE INDEX idx_tickers_active ON tickers(active);

-- Shared AdapterWarning table (Doc/openapi.yaml: AdapterWarning) — polymorphic
-- because the same warning shape attaches to companies, market_movers, and
-- (in future) any other adapter-backed table. entity_table + entity_key
-- point at the row the warning describes.
CREATE TABLE adapter_warnings (
  id            BIGSERIAL PRIMARY KEY,
  entity_table  TEXT NOT NULL,          -- e.g. 'companies', 'market_movers'
  entity_key    TEXT NOT NULL,          -- natural key of the row this warning is attached to
  code          TEXT NOT NULL CHECK (code IN ('SUB_REQUEST_FAILED','FIELD_NOT_SUPPORTED','FALLBACK_USED','STALE_DATA')),
  field         TEXT,                   -- comma-separated canonical field name(s) affected, when applicable
  message       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_adapter_warnings_entity ON adapter_warnings(entity_table, entity_key);


-- ============================================================================
-- LIVE — Market movers (Doc/openapi.yaml: MarketMover;
-- Firestore: market_movers/{gainer_TICKER|loser_TICKER} [latest] +
-- market_movers_history/{date}_{direction}_{ticker} [history];
-- both written in the same transaction by backend/src/sync/market-movers.job.ts)
-- ============================================================================

-- Latest snapshot only — MUTABLE/UPSERT-LATEST. Mirrors Firestore's
-- gainer_TICKER/loser_TICKER doc id exactly: one row per ticker+direction,
-- overwritten every sync.
CREATE TABLE market_movers (
  ticker      TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('gainer','loser')),
  as_of_date  DATE NOT NULL,
  price       DOUBLE PRECISION NOT NULL,
  pct_change  DOUBLE PRECISION NOT NULL,
  volume      DOUBLE PRECISION NOT NULL,
  name        TEXT,
  sector      TEXT,
  cap         TEXT CHECK (cap IN ('Mega','Large','Mid','Small','Micro')),
  source      TEXT,                                -- 'polygon' | 'fmp' — which MoversAdapter served this row
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, direction)
);

-- Full history — IMMUTABLE/APPEND-ONLY. Same columns, but as_of_date joins
-- the key so a closed trading day's row is never touched again; write with
-- INSERT ... ON CONFLICT (ticker, direction, as_of_date) DO NOTHING.
CREATE TABLE market_movers_history (
  ticker      TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('gainer','loser')),
  as_of_date  DATE NOT NULL,
  price       DOUBLE PRECISION NOT NULL,
  pct_change  DOUBLE PRECISION NOT NULL,
  volume      DOUBLE PRECISION NOT NULL,
  name        TEXT,
  sector      TEXT,
  cap         TEXT CHECK (cap IN ('Mega','Large','Mid','Small','Micro')),
  source      TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, direction, as_of_date)
);
CREATE INDEX idx_market_movers_history_date ON market_movers_history(as_of_date DESC);


-- ============================================================================
-- LIVE — Sectors (Doc/openapi.yaml: Sector;
-- Firestore: sectors/{sectorSlug} [latest] + sectors_history/{date}_{sectorSlug}
-- [history]; both written by backend/src/sync/sectors.job.ts)
-- ============================================================================

-- MUTABLE/UPSERT-LATEST
CREATE TABLE sectors (
  sector      TEXT PRIMARY KEY,
  as_of_date  DATE NOT NULL,
  exchange    TEXT,
  pct_change  DOUBLE PRECISION,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- IMMUTABLE/APPEND-ONLY
CREATE TABLE sectors_history (
  sector      TEXT NOT NULL,
  as_of_date  DATE NOT NULL,
  exchange    TEXT,
  pct_change  DOUBLE PRECISION,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sector, as_of_date)
);
CREATE INDEX idx_sectors_history_date ON sectors_history(as_of_date DESC);


-- ============================================================================
-- LIVE — Market indices (Doc/openapi.yaml: MarketIndex;
-- Firestore: market_indices/{symbol} [latest] +
-- market_indices_history/{date}_{symbol} [history]; both written by
-- backend/src/sync/market-indices.job.ts)
-- ============================================================================

-- MUTABLE/UPSERT-LATEST
CREATE TABLE market_indices (
  symbol        TEXT PRIMARY KEY,                  -- SPX, NDX, DJI, RUT, GOLD, WTI, DXY, US10Y, VIX
  as_of         TIMESTAMPTZ NOT NULL,
  label         TEXT NOT NULL,
  proxy_ticker  TEXT,                               -- ETF used as a stand-in (e.g. SPY for SPX) — see is_proxy
  is_proxy      BOOLEAN NOT NULL DEFAULT true,
  note          TEXT,
  value         DOUBLE PRECISION NOT NULL,
  change        DOUBLE PRECISION,
  pct_change    DOUBLE PRECISION,
  open          DOUBLE PRECISION,
  prev_close    DOUBLE PRECISION
);

-- IMMUTABLE/APPEND-ONLY
CREATE TABLE market_indices_history (
  symbol        TEXT NOT NULL,
  as_of_date    DATE NOT NULL,
  label         TEXT NOT NULL,
  proxy_ticker  TEXT,
  is_proxy      BOOLEAN NOT NULL DEFAULT true,
  note          TEXT,
  value         DOUBLE PRECISION NOT NULL,
  change        DOUBLE PRECISION,
  pct_change    DOUBLE PRECISION,
  open          DOUBLE PRECISION,
  prev_close    DOUBLE PRECISION,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, as_of_date)
);
CREATE INDEX idx_market_indices_history_date ON market_indices_history(as_of_date DESC);


-- ============================================================================
-- LIVE — Market sentiment / Fear & Greed (Firestore: market_sentiment/fear_greed;
-- written by backend/src/sync/fear-greed.job.ts). A CNN-style 0-100 index
-- (approximation, not the licensed CNN index) composed from free Polygon data:
-- SPY-vs-125d-MA momentum, market breadth (share of names closing up), VIXY-vs-
-- 50d-MA volatility (inverted), and SPY-vs-TLT safe-haven. One row (id
-- 'fear_greed'); component sub-scores normalized into a child table.
-- ============================================================================
CREATE TABLE market_sentiment (
  id          TEXT PRIMARY KEY,            -- 'fear_greed'
  value       SMALLINT NOT NULL CHECK (value BETWEEN 0 AND 100),
  label       TEXT NOT NULL,              -- Extreme Fear | Fear | Neutral | Greed | Extreme Greed
  as_of_date  DATE,
  source      TEXT NOT NULL DEFAULT 'polygon',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE market_sentiment_components (
  sentiment_id  TEXT NOT NULL REFERENCES market_sentiment(id) ON DELETE CASCADE,
  component     TEXT NOT NULL,            -- momentum | breadth | volatility | safeHaven
  score         SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
  PRIMARY KEY (sentiment_id, component)
);


-- ============================================================================
-- LIVE — Macro events (Doc/openapi.yaml: MacroEvent; Firestore:
-- macro_events/{seriesId}; written by backend/src/sync/macro-events.job.ts)
-- Latest FRED observation + prior reading per curated indicator — NOT a
-- forward-looking calendar (Finnhub's /calendar/economic, which would give
-- one, is confirmed blocked on the current plan). `estimate` is always NULL:
-- FRED is a pure time-series API with no consensus-estimate concept.
-- ============================================================================

-- MUTABLE/UPSERT-LATEST (one row per curated series, not per observation)
CREATE TABLE macro_events (
  series_id     TEXT PRIMARY KEY,          -- FRED series id, e.g. CPIAUCSL
  name          TEXT NOT NULL,             -- e.g. 'CPI (All Items)'
  country       TEXT NOT NULL DEFAULT 'US',
  unit          TEXT NOT NULL,             -- '%', 'index', 'thousands', '$ millions', ...
  importance    TEXT NOT NULL CHECK (importance IN ('low','medium','high')),
  event_date    DATE NOT NULL,             -- date of the latest published observation
  actual        DOUBLE PRECISION,
  previous      DOUBLE PRECISION,
  estimate      DOUBLE PRECISION,          -- always NULL — see note above
  source        TEXT NOT NULL DEFAULT 'fred',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- LIVE — IPOs (Doc/openapi.yaml: IpoEvent; Firestore:
-- ipos/{date}_{symbol|slug}; written by backend/src/sync/ipos.job.ts)
-- Finnhub /calendar/ipo — verified 2026-07-07 as a separate endpoint from
-- Finnhub's blocked /calendar/economic, not FMP (whose ipos-calendar IS
-- confirmed restricted). PK is a point-in-time snapshot key, not a stable
-- per-company identity — the same real IPO can appear under more than one
-- row as its status changes (filed pre-ticker -> priced with a symbol).
-- ============================================================================

-- MUTABLE/UPSERT-LATEST
CREATE TABLE ipos (
  event_id            TEXT PRIMARY KEY,        -- '{date}_{symbol|slug}'
  event_date          DATE NOT NULL,
  symbol              TEXT,                    -- NULL for pre-ticker filings
  company_name        TEXT NOT NULL,
  exchange            TEXT,
  price_low           DOUBLE PRECISION,
  price_high          DOUBLE PRECISION,
  number_of_shares    DOUBLE PRECISION,
  total_shares_value  DOUBLE PRECISION,
  status              TEXT NOT NULL CHECK (status IN ('expected','priced','filed','withdrawn')),
  source              TEXT NOT NULL DEFAULT 'finnhub',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ipos_date ON ipos(event_date DESC);


-- ============================================================================
-- LIVE — Options chains, partial (Doc/openapi.yaml: OptionsChain; Firestore:
-- options_chains/{underlyingTicker}, one doc per ticker with a `contracts`
-- array; written by backend/src/sync/options-chains.job.ts). Flattened here
-- to one row per contract per this file's "no native arrays" convention.
-- Real strikes/expirations + delayed last close/volume only — NO bid/ask,
-- implied volatility, greeks, or open interest: Polygon's options snapshot
-- and NBBO quotes are confirmed 403 NOT_AUTHORIZED on the current plan
-- (verified 2026-07-07). Covers OPTIONS_UNIVERSE (8 curated tickers) only,
-- not every ticker options.tsx's picker lists.
-- ============================================================================

-- MUTABLE/UPSERT-LATEST
CREATE TABLE option_contracts (
  contract_ticker     TEXT PRIMARY KEY,        -- e.g. 'O:AAPL260717C00225000'
  underlying_ticker   TEXT NOT NULL,
  contract_type       TEXT NOT NULL CHECK (contract_type IN ('call','put')),
  strike              DOUBLE PRECISION NOT NULL,
  expiration_date     DATE NOT NULL,
  last_close          DOUBLE PRECISION,
  last_volume         DOUBLE PRECISION,
  last_bar_date       DATE,
  source              TEXT NOT NULL DEFAULT 'polygon',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_option_contracts_underlying ON option_contracts(underlying_ticker, expiration_date);


-- ============================================================================
-- LIVE — Dividends (Doc/openapi.yaml: Dividend; Firestore: dividends/{ticker};
-- written by backend/src/sync/dividends.job.ts). FMP /stable/dividends-
-- calendar — verified working 2026-07-07 (unlike the confirmed-restricted
-- economic-calendar/ipos-calendar on this same plan). One row per ticker
-- holding its next upcoming ex-dividend event, same forward-window-only
-- shape as earnings_events — not a full per-event history.
-- ============================================================================

-- MUTABLE/UPSERT-LATEST
CREATE TABLE dividends (
  ticker             TEXT PRIMARY KEY,
  ex_dividend_date   DATE NOT NULL,
  record_date        DATE,
  payment_date       DATE,
  declaration_date   DATE,
  dividend_amount    DOUBLE PRECISION NOT NULL,
  yield_pct          DOUBLE PRECISION,
  frequency          TEXT,
  source             TEXT NOT NULL DEFAULT 'fmp',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dividends_ex_date ON dividends(ex_dividend_date);


-- ============================================================================
-- LIVE — Historical OHLCV bars (Doc/openapi.yaml: OhlcvBar; Firestore:
-- ohlcv_bars/{ticker}_{date}; written by backend/src/sync/stock-history.job.ts).
-- Polygon EOD aggregates for TICKER_UNIVERSE, ~300-day backfill then
-- incremental via a per-ticker sync_watermarks entry — never re-fetches an
-- immutable historical bar already stored. Feeds Stock Detail's real chart
-- (3M/6M/1Y only — 1D/1W need intraday, 5Y needs more history than the
-- backfill covers) and is the prerequisite for a future Screener RS-Rating
-- computation (not built yet).
-- ============================================================================

-- IMMUTABLE/APPEND-ONLY
CREATE TABLE ohlcv_bars (
  ticker    TEXT NOT NULL,
  bar_date  DATE NOT NULL,
  timespan  TEXT NOT NULL DEFAULT 'day',   -- 'minute' | 'hour' | 'day' | ...
  open      DOUBLE PRECISION NOT NULL,
  high      DOUBLE PRECISION NOT NULL,
  low       DOUBLE PRECISION NOT NULL,
  close     DOUBLE PRECISION NOT NULL,
  volume    DOUBLE PRECISION NOT NULL,
  source    TEXT NOT NULL DEFAULT 'polygon',
  PRIMARY KEY (ticker, bar_date, timespan)
);
CREATE INDEX idx_ohlcv_ticker_date ON ohlcv_bars(ticker, bar_date DESC);


-- ============================================================================
-- LIVE — Earnings events (Doc/openapi.yaml: EarningsEvent;
-- Firestore: earnings_events/{ticker}_{date}; written by
-- backend/src/sync/earnings.job.ts)
-- ============================================================================

CREATE TABLE earnings_events (
  ticker            TEXT NOT NULL,
  event_date        DATE NOT NULL,
  eps_estimate      DOUBLE PRECISION,
  eps_actual        DOUBLE PRECISION,
  revenue_estimate  DOUBLE PRECISION,
  revenue_actual    DOUBLE PRECISION,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, event_date)
);
CREATE INDEX idx_earnings_events_date ON earnings_events(event_date);

-- NOTE: session (BMO/AMC), guidance status, and price reaction — shown in
-- the Earnings Hub UI — are NOT in this table because no live source
-- populates them (FMP's calendar doesn't carry them; needs Benzinga). If
-- you add that vendor later, extend this table rather than reshaping it:
--   ALTER TABLE earnings_events ADD COLUMN session TEXT CHECK (session IN ('BMO','AMC'));
--   ALTER TABLE earnings_events ADD COLUMN guidance_status TEXT CHECK (guidance_status IN ('raised','lowered','maintained'));
--   ALTER TABLE earnings_events ADD COLUMN price_reaction_pct DOUBLE PRECISION;


-- ============================================================================
-- LIVE — Analyst consensus (Doc/openapi.yaml: AnalystConsensus;
-- Firestore: analyst_actions/{ticker}; written by
-- backend/src/sync/analyst-actions.job.ts)
-- ============================================================================
-- NOTE: this is a Buy/Hold/Sell vote-count SNAPSHOT, not a per-firm event
-- feed — see analyst_action_events below (PLANNED) for the richer shape
-- the Analyst Actions screen's event table actually wants.

CREATE TABLE analyst_consensus (
  ticker       TEXT PRIMARY KEY,
  source       TEXT,                    -- e.g. 'fmp_consensus_interim'
  strong_buy   INTEGER NOT NULL DEFAULT 0,
  buy          INTEGER NOT NULL DEFAULT 0,
  hold         INTEGER NOT NULL DEFAULT 0,
  sell         INTEGER NOT NULL DEFAULT 0,
  strong_sell  INTEGER NOT NULL DEFAULT 0,
  consensus    TEXT,                    -- e.g. 'Buy'
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- LIVE — Insider transactions (Doc/openapi.yaml: InsiderTransaction;
-- Firestore: insider_transactions/{accessionNumber}_{i}; written by
-- backend/src/sync/sec-form4.job.ts)
-- ============================================================================

CREATE TABLE insider_transactions (
  id                    BIGSERIAL PRIMARY KEY,
  accession_number      TEXT NOT NULL,
  seq                   INTEGER NOT NULL,          -- the "_{i}" suffix from the Firestore doc id
  ticker                TEXT NOT NULL,
  issuer_name           TEXT,
  owner_name            TEXT,
  is_officer            BOOLEAN NOT NULL DEFAULT false,
  officer_title         TEXT,
  transaction_date      DATE NOT NULL,
  transaction_code      TEXT,                      -- raw SEC Form 4 transaction code, e.g. 'S', 'P', 'A'
  acquired_or_disposed  TEXT NOT NULL CHECK (acquired_or_disposed IN ('A','D')),
  shares                DOUBLE PRECISION NOT NULL,
  price_per_share       DOUBLE PRECISION,
  shares_owned_after    DOUBLE PRECISION,
  filing_date           DATE NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (accession_number, seq)
);
CREATE INDEX idx_insider_tx_ticker ON insider_transactions(ticker, transaction_date DESC);


-- ============================================================================
-- LIVE — Institutional 13F holdings (Doc/openapi.yaml: FundHoldings,
-- FundPosition; Firestore: fund_holdings/{cik}(/filings/{accessionNumber}
-- /positions/{cusip}); written by backend/src/sync/sec-13f.job.ts)
-- ============================================================================

CREATE TABLE fund_holdings (
  cik                      TEXT PRIMARY KEY,
  fund_name                TEXT NOT NULL,
  latest_filing_date       DATE,
  latest_accession_number  TEXT,
  total_positions          INTEGER,
  total_value              DOUBLE PRECISION,        -- USD, as reported (thousands per SEC convention)
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fund_filings (
  cik               TEXT NOT NULL REFERENCES fund_holdings(cik) ON DELETE CASCADE,
  accession_number  TEXT NOT NULL,
  filing_date       DATE NOT NULL,
  total_positions   INTEGER,
  total_value       DOUBLE PRECISION,
  PRIMARY KEY (cik, accession_number)
);

-- Keyed by CUSIP, not ticker — SEC's 13F schema has no ticker field.
-- Capped at 200 rows per filing in the source job (largest positions first).
CREATE TABLE fund_positions (
  cik               TEXT NOT NULL,
  accession_number  TEXT NOT NULL,
  cusip             TEXT NOT NULL,
  name_of_issuer    TEXT NOT NULL,
  value             DOUBLE PRECISION NOT NULL,
  shares            DOUBLE PRECISION NOT NULL,
  pct_of_portfolio  DOUBLE PRECISION,
  PRIMARY KEY (cik, accession_number, cusip),
  FOREIGN KEY (cik, accession_number) REFERENCES fund_filings(cik, accession_number) ON DELETE CASCADE
);
CREATE INDEX idx_fund_positions_value ON fund_positions(cik, accession_number, value DESC);


-- ============================================================================
-- LIVE — News (Doc/openapi.yaml: NewsArticle;
-- Firestore: news/{ticker}_{articleId}; written by backend/src/sync/news.job.ts)
-- As of 2026-07-12 the news adapter AGGREGATES multiple sources (NEWS_SOURCE=
-- aggregate): Polygon + Finnhub fetched in parallel and merged/de-duped per
-- ticker, rather than primary-or-fallback — so a ticker's rows can now come
-- from several vendors (each row's `source` says which). sentiment/keywords are
-- still Polygon-only (null/empty on Finnhub-sourced rows).
-- ============================================================================

CREATE TABLE news_articles (
  id            TEXT PRIMARY KEY,        -- Firestore doc id: {ticker}_{articleId}
  ticker        TEXT NOT NULL,
  headline      TEXT NOT NULL,
  summary       TEXT,
  source        TEXT,
  url           TEXT,
  category      TEXT,
  sentiment           TEXT CHECK (sentiment IN ('positive','negative','neutral')), -- Polygon-only; null when served via Finnhub fallback
  sentiment_reasoning TEXT,   -- Polygon-only; null when served via Finnhub fallback
  keywords            TEXT[] NOT NULL DEFAULT '{}', -- empty when served via Finnhub fallback
  published_at  TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_news_ticker_published ON news_articles(ticker, published_at DESC);
CREATE INDEX idx_news_published ON news_articles(published_at DESC);
CREATE INDEX idx_news_category ON news_articles(category);


-- ============================================================================
-- LIVE — Sync ops metadata (Doc/openapi.yaml: SyncMeta/SyncJobStatus;
-- Firestore: sync_meta/{jobName}; written by backend/src/common/sync-meta.service.ts)
-- ============================================================================

-- collections/cron_expression/time_zone (added 2026-07-09) are written on
-- every record() call, sourced from SyncRegistry.JobMeta — declared once
-- per job at registration time, right next to its @Cron(...) decorator, so
-- schedule and description can't drift apart. Answers "which table did
-- this job affect, and how often does it run" straight from Firestore
-- itself, without reading backend source. See backend/src/common/
-- sync-registry.service.ts.
CREATE TABLE sync_meta (
  job_name         TEXT PRIMARY KEY,     -- e.g. 'market-movers', 'companies', 'sec-13f', ...
  last_synced_at   TIMESTAMPTZ,          -- most recent attempt of ANY outcome (overwritten every run)
  last_status      TEXT CHECK (last_status IN ('ok','error')),  -- outcome of that most recent attempt = current health
  last_count       INTEGER,              -- doc count of the most recent attempt
  last_error       TEXT,                 -- error of the LAST FAILURE; persists across later successes (paired with last_failed_at)
  -- last_success_* and last_failed_at are written only on that outcome, so one
  -- never erases the other: after a job succeeds then later fails you can still
  -- read when it last succeeded, and after it recovers you can still read when
  -- it last failed. (Added 2026-07-12; see SyncMetaService.record.)
  last_success_at    TIMESTAMPTZ,        -- last successful run
  last_success_count INTEGER,            -- doc count of that last successful run
  last_failed_at     TIMESTAMPTZ,        -- last failed run (its message is in last_error)
  cursor           INTEGER,              -- rotating ticker-universe cursor for batched jobs (companies, analyst-actions, sec-form4, news)
  collections      TEXT[],               -- Firestore collection path(s) this job writes to, e.g. {'market_movers','market_movers_history'}
  cron_expression  TEXT,                 -- raw cron string, e.g. '*/30 9-16 * * 1-5'
  time_zone        TEXT                  -- e.g. 'America/New_York' — every job schedules in market-local time
);

-- High-water mark for incremental time-series ingestion (Firestore:
-- sync_watermarks/{jobName}__{entityKey}; written by
-- backend/src/common/sync-meta.service.ts's getWatermark/setWatermark).
-- Lets a future job (e.g. ohlcv_bars) ask "what's the last date I already
-- have for ticker X" and only fetch what's new, instead of re-requesting a
-- whole range from the vendor and re-checking every row for duplicates on
-- every run. Distinct from sync_meta's single rotating `cursor` int, which
-- tracks position through a ticker UNIVERSE, not a per-entity date/value.
CREATE TABLE sync_watermarks (
  job_name             TEXT NOT NULL,
  entity_key           TEXT NOT NULL,     -- e.g. a ticker for ohlcv_bars, a CIK for fund filings
  last_synced_through  TEXT NOT NULL,     -- typically an ISO date/timestamp string; kept TEXT since the "unit" varies by job
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_name, entity_key)
);


-- ============================================================================
-- LIVE — User-owned data (Doc/openapi.yaml: Watchlist, Holding, HoldingInput,
-- UserSettings, StockComment; Firestore: users/{uid}/..., settings/{uid},
-- stock_comments/{id} — written directly by the client SDK, not a sync job)
-- ============================================================================

-- No formal "User" Firestore document/OpenAPI schema exists today — every
-- user-owned path is scoped by Firebase Auth uid alone. This table exists
-- purely as the FK parent for everything below; add columns as you migrate
-- real user profile data off Firebase Auth.
CREATE TABLE users (
  uid         TEXT PRIMARY KEY,
  email       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE watchlists (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,  -- Firestore doc id was always literally "default"
  uid         TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT 'My Watchlist',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (uid, name)
);

-- Normalizes Watchlist.tickers (string[] in Firestore/OpenAPI)
CREATE TABLE watchlist_tickers (
  watchlist_id  TEXT NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  ticker        TEXT NOT NULL,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (watchlist_id, ticker)
);

-- Parent doc of `holdings` below (Firestore: users/{uid}/portfolios/default).
-- One row per user, same flattening as `holdings.uid` — Firestore's "default"
-- portfolio-id segment is dropped since only one portfolio per user exists.
-- total_value/day_pl/day_pl_pct/holdings_count/updated_at are a materialized
-- summary written client-side (debounced ~3s) by portfolio.tsx whenever
-- holdings or live prices change meaningfully — see Doc/openapi.yaml's
-- Portfolio schema for the full write-pattern note. The app's own UI never
-- reads this cached summary back (recomputes live on every render); it
-- exists for anything outside the browser to read portfolio value cheaply.
CREATE TABLE portfolios (
  uid             TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  name            TEXT NOT NULL DEFAULT 'My Portfolio',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_value     DOUBLE PRECISION,
  day_pl          DOUBLE PRECISION,
  day_pl_pct      DOUBLE PRECISION,
  holdings_count  INTEGER,
  updated_at      TIMESTAMPTZ
);

CREATE TABLE holdings (
  id             BIGSERIAL PRIMARY KEY,
  uid            TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  ticker         TEXT NOT NULL,
  shares         DOUBLE PRECISION NOT NULL,
  position_size  TEXT NOT NULL DEFAULT 'Small' CHECK (position_size IN ('Small','Medium','Large')),
  conviction     TEXT NOT NULL DEFAULT 'Medium' CHECK (conviction IN ('High','Medium','Low')),
  added_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (uid, ticker)   -- Firestore doc id was users/{uid}/portfolios/default/holdings/{ticker} — one row per ticker per user
);

CREATE TABLE user_settings (
  uid    TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  alert  BOOLEAN NOT NULL DEFAULT true,
  font   TEXT NOT NULL DEFAULT 'geist'
);

CREATE TABLE stock_comments (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  uid         TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  sym         TEXT NOT NULL,
  name        TEXT NOT NULL,
  comment     TEXT NOT NULL CHECK (char_length(comment) <= 2000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_comments_uid_sym ON stock_comments(uid, sym, created_at DESC);


-- ============================================================================
-- PLANNED — nothing below this line is implemented in the backend today
-- (x-status: planned in Doc/openapi.yaml). Shapes are a reasonable guess
-- from the named vendor's typical payload, NOT verified against real data.
-- Revise once each is actually built.
-- ============================================================================

-- PLANNED: Unusual Whales WebSocket flow feed — blocked, UNUSUAL_WHALES_API_KEY not set.
CREATE TABLE options_flow (
  id                   BIGSERIAL PRIMARY KEY,
  ticker               TEXT NOT NULL,
  strike_price         DOUBLE PRECISION,
  expiration_date      DATE,
  option_type          TEXT CHECK (option_type IN ('call','put')),
  contract_size        DOUBLE PRECISION,
  premium              DOUBLE PRECISION,
  total_value          DOUBLE PRECISION,
  implied_volatility   DOUBLE PRECISION,
  vol_oi_ratio         DOUBLE PRECISION,
  side                 TEXT CHECK (side IN ('bid','ask','mid')),
  direction_flag       TEXT CHECK (direction_flag IN ('bullish','bearish','neutral')),
  is_sweep             BOOLEAN,
  is_unusual           BOOLEAN,
  is_block             BOOLEAN,
  trade_time           TIMESTAMPTZ,
  source               TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_options_flow_ticker_time ON options_flow(ticker, trade_time DESC);
CREATE INDEX idx_options_flow_unusual ON options_flow(is_unusual, trade_time DESC);

-- PLANNED: Unusual Whales dark-pool print feed — blocked, no key. FINRA
-- ADF/OTC Transparency data is a free alternate but T+1 delayed.
CREATE TABLE block_trades (
  id                 BIGSERIAL PRIMARY KEY,
  ticker             TEXT NOT NULL,
  trade_value        DOUBLE PRECISION,
  shares             DOUBLE PRECISION,
  price              DOUBLE PRECISION,
  vwap               DOUBLE PRECISION,
  vwap_diff_pct      DOUBLE PRECISION,
  exchange           TEXT,
  direction_context  TEXT CHECK (direction_context IN ('above_ask','below_bid','at_mid')),
  trade_time         TIMESTAMPTZ,
  source             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_block_trades_ticker_time ON block_trades(ticker, trade_time DESC);

-- PLANNED: Benzinga Ratings API (blocked, no key) — or FMP /stable/grades-historical
-- as an interim, non-real-time source (key already active). This is the
-- event-level feed analyst_consensus above cannot provide.
CREATE TABLE analyst_action_events (
  id                     BIGSERIAL PRIMARY KEY,
  ticker                 TEXT NOT NULL,
  firm                   TEXT NOT NULL,
  action_type            TEXT CHECK (action_type IN ('upgrade','downgrade','initiation','reiteration','coverage_dropped')),
  previous_rating        TEXT,
  new_rating             TEXT,
  previous_price_target  DOUBLE PRECISION,
  new_price_target       DOUBLE PRECISION,
  published_at           TIMESTAMPTZ,
  price_change_since     DOUBLE PRECISION,
  source                 TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_analyst_action_events_ticker ON analyst_action_events(ticker, published_at DESC);

-- PLANNED: Polygon EOD index/sector data + Anthropic Claude narrative —
-- blocked, ANTHROPIC_API_KEY not set. Nested arrays normalized into child tables.
CREATE TABLE recaps (
  id                BIGSERIAL PRIMARY KEY,
  recap_type        TEXT NOT NULL CHECK (recap_type IN ('daily','weekly')),
  recap_date        TEXT NOT NULL,          -- "YYYY-MM-DD" (daily) or "YYYY-Www" (weekly)
  title             TEXT,
  subtitle          TEXT,
  news_lead         TEXT,
  audio_url         TEXT,
  audio_duration_s  INTEGER,
  audio_script      TEXT,
  email_sent_at     TIMESTAMPTZ,
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recap_type, recap_date)
);

CREATE TABLE recap_index_cards (
  recap_id    BIGINT NOT NULL REFERENCES recaps(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  value       DOUBLE PRECISION,
  change      DOUBLE PRECISION,
  open        DOUBLE PRECISION,
  prev_close  DOUBLE PRECISION,
  PRIMARY KEY (recap_id, label)
);

CREATE TABLE recap_news_items (
  id          BIGSERIAL PRIMARY KEY,
  recap_id    BIGINT NOT NULL REFERENCES recaps(id) ON DELETE CASCADE,
  headline    TEXT NOT NULL,
  body        TEXT,
  ticker      TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE recap_stories (
  id          BIGSERIAL PRIMARY KEY,
  recap_id    BIGINT NOT NULL REFERENCES recaps(id) ON DELETE CASCADE,
  story_text  TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE recap_tomorrow_events (
  id          BIGSERIAL PRIMARY KEY,
  recap_id    BIGINT NOT NULL REFERENCES recaps(id) ON DELETE CASCADE,
  event_time  TEXT,
  event_name  TEXT NOT NULL
);

CREATE TABLE recap_movers (
  id          BIGSERIAL PRIMARY KEY,
  recap_id    BIGINT NOT NULL REFERENCES recaps(id) ON DELETE CASCADE,
  ticker      TEXT NOT NULL,
  reason      TEXT,
  pct_change  DOUBLE PRECISION
);

CREATE TABLE recap_internals (
  id         BIGSERIAL PRIMARY KEY,
  recap_id   BIGINT NOT NULL REFERENCES recaps(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  value      TEXT,
  direction  SMALLINT CHECK (direction IN (-1, 0, 1))
);

CREATE TABLE recap_sector_performance (
  id           BIGSERIAL PRIMARY KEY,
  recap_id     BIGINT NOT NULL REFERENCES recaps(id) ON DELETE CASCADE,
  sector_name  TEXT NOT NULL,
  pct_change   DOUBLE PRECISION
);

-- ============================================================================
-- Summary: 32 LIVE tables mirroring implemented Firestore collections
-- (incl. market_sentiment + market_sentiment_components, added 2026-07-12)
-- (including the market_movers/sectors/market_indices "latest" + "_history"
-- pairs, sync_watermarks, and tickers), 11 PLANNED tables for the
-- x-status: planned OpenAPI paths. No helper views needed — the "latest"
-- tables ARE the latest-only view now, mirroring Firestore's actual
-- two-collection shape instead of deriving "latest" from a history table
-- at query time.
-- Verified against a real PostgreSQL 18 instance — every CREATE TABLE/INDEX
-- statement runs clean; CHECK constraints, composite foreign keys,
-- gen_random_uuid() defaults, and the ON CONFLICT DO NOTHING no-op-on-
-- re-sync behavior were all exercised with real inserts.
-- Cross-check against Doc/openapi.yaml if either drifts from the other.
-- ============================================================================
