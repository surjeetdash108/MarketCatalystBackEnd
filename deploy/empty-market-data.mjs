#!/usr/bin/env node
/**
 * Empties the MARKET-DATA collections for the on-demand redesign (2026-07-24).
 *
 * The DB then starts empty and grows strictly with usage: on-demand endpoints
 * write what users actually request; the premarket job warms the hot set.
 *
 * ── WHAT IS KEPT (never touched by this script) ─────────────────────────────
 * users (+ subcollections: watchlists, portfolios/holdings, sessions, alerts,
 * notifications), settings, plans, feature_flags, feature_adoption, payments,
 * subscriptions, api_usage, audit_logs, revenue_summary, system_metrics.
 * Deleting those would destroy real user accounts/config — unrecoverable.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *   node deploy/empty-market-data.mjs           # DRY RUN — counts only
 *   CONFIRM_DELETE=yes node deploy/empty-market-data.mjs   # actually deletes
 *
 * Credentials: service-account.json in the repo root, or gcloud ADC
 * (`gcloud auth application-default login`). Project via FIREBASE_PROJECT_ID
 * (defaults to market-catalyst-502415).
 */

import { existsSync, readFileSync } from 'node:fs';
import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.FIREBASE_PROJECT_ID ?? 'market-catalyst-502415';
const DRY_RUN = process.env.CONFIRM_DELETE !== 'yes';

/** Market-data collections — safe to empty; all re-fetchable from vendors. */
const PURGE = [
  'companies', 'tickers', 'ohlcv_bars', 'intraday_bars', 'stock_bars',
  'market_indices', 'market_indices_history',
  'market_movers', 'market_movers_history',
  'sectors', 'sectors_history',
  'market_breadth', 'market_sentiment', 'market_sentiment_history',
  'earnings_events', 'ipos', 'macro_events', 'news', 'recaps',
  'analyst_actions', 'insider_transactions', 'fund_holdings',
  'dividends', 'dividend_history', 'splits',
  'financials', 'options_chains', 'ticker_usage', 'sync_meta',
];

const app = (() => {
  if (existsSync('./service-account.json')) {
    const sa = JSON.parse(readFileSync('./service-account.json', 'utf8'));
    return initializeApp({ credential: cert(sa), projectId: PROJECT });
  }
  return initializeApp({ credential: applicationDefault(), projectId: PROJECT });
})();
const db = getFirestore(app);

let totalDeleted = 0;
for (const name of PURGE) {
  const col = db.collection(name);
  const countSnap = await col.count().get();
  const n = countSnap.data().count;
  if (n === 0) {
    console.log(`  ${name}: empty`);
    continue;
  }
  if (DRY_RUN) {
    console.log(`  ${name}: ${n} docs (would delete)`);
    totalDeleted += n;
    continue;
  }
  process.stdout.write(`  ${name}: deleting ${n} docs `);
  // recursiveDelete handles batching + any subcollections.
  await db.recursiveDelete(col);
  totalDeleted += n;
  console.log('✓');
}

console.log(
  DRY_RUN
    ? `\nDRY RUN — ${totalDeleted} docs would be deleted. Re-run with CONFIRM_DELETE=yes to execute.`
    : `\nDone — ${totalDeleted} docs deleted. Collections now fill on demand + premarket warm.`,
);
