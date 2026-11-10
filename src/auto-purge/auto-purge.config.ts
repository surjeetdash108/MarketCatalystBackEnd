/**
 * Auto-purge of EPHEMERAL intraday data (nightly).
 *
 * WHAT COUNTS AS EPHEMERAL — and why only these collections
 * These are ticker-keyed CURRENT-SNAPSHOT collections whose writer only ever
 * writes the *current* set and never removes entries that drop out. When a
 * stock stops being a top mover (or a ticker stops being covered), its doc
 * lingers in Firestore forever — stale and irrelevant. This service removes
 * those abandoned entries.
 *
 * DELIBERATELY EXCLUDED:
 *   - Fixed-key snapshots (market_indices, sectors, market_sentiment, tickers,
 *     companies): the same keys are overwritten each run, so nothing
 *     accumulates — purging them would delete LIVE data.
 *   - History / append collections (ohlcv_bars, *_history, news): intentionally
 *     retained for months; handled by the separate retention job.
 *
 * WHY `updatedAt`, NOT `createdAt`
 * `createdAt` is preserved from the FIRST write and carried forward on every
 * update (firestore-batch.util.ts). So a stock that has been a top mover for a
 * week has an OLD createdAt but a FRESH doc — deleting by createdAt would wipe
 * still-current entries. `updatedAt` is refreshed on every write, so it is the
 * true "last seen in the current set" signal.
 *
 * WHY A CUTOFF RELATIVE TO THE LATEST WRITE
 * The cutoff is `(latest updatedAt in the collection) − maxAgeHours`, not an
 * absolute "now − 12h". This means the CURRENT batch (all sharing ~the latest
 * updatedAt) is always kept, even across weekends when no job has run for days;
 * only genuinely-abandoned older entries are removed. Matches the request:
 * "fetch the latest, delete the 12-hours-old data".
 */

export interface EphemeralTarget {
  collection: string;
  /** Staleness field — must be a written-every-update ISO timestamp. */
  field: string;
  /** Delete docs whose field is older than (latest − this many hours). */
  maxAgeHours: number;
  note: string;
}

export const EPHEMERAL_TARGETS: EphemeralTarget[] = [
  {
    collection: "market_movers",
    field: "updatedAt",
    maxAgeHours: 12,
    note: "Top gainers/losers change daily; tickers that fall off the list leave abandoned docs the movers job never deletes.",
  },
  {
    collection: "options_chains",
    field: "updatedAt",
    maxAgeHours: 12,
    note: "Per-ticker option chains; a ticker no longer covered leaves a stale doc.",
  },
];
