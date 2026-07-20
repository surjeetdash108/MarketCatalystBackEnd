/**
 * Which collections may be purged, and how a date range is applied to each.
 *
 * `sync_meta` and `sync_watermarks` are deliberately ABSENT and must never be
 * added: they are the only record of what has run (including the run counters
 * the monitor UI reads), and wiping them makes every job report "Never run".
 * Purge still *resets* the relevant entries as a side effect — see `jobs` —
 * but they can never be a target.
 *
 * `notifications` is also absent, for a different reason: it is no longer a
 * top-level collection. Notifications are per-user at
 * users/{uid}/notifications/{id}, and this registry only addresses top-level
 * collections. They self-prune to 100 docs / 30 days per user; a manual reset
 * would need to walk each user's subcollection.
 */
export interface PurgeTarget {
  /** Firestore collection name. */
  collection: string;
  /** Human label for the UI. */
  label: string;
  /**
   * Field a date range filters on. `null` means the collection carries no
   * usable date, so only a full purge is possible — the API rejects a
   * date-filtered request rather than silently matching nothing.
   */
  dateField: string | null;
  /**
   * 'date'     → field holds 'YYYY-MM-DD', compared as-is.
   * 'datetime' → field holds a full ISO timestamp, so an inclusive end date
   *              must be widened to the end of that day (see toBound()).
   */
  dateFormat: 'date' | 'datetime';
  /**
   * True when documents own subcollections and need a recursive delete.
   * A plain batch delete would orphan the children — they stay readable and
   * keep costing storage while their parent is gone.
   */
  recursive: boolean;
  /**
   * Sync jobs whose watermark/cursor state must be reset when this collection
   * is purged. Without this the next run sees a watermark past the purged
   * range, decides it is already synced, and the data never comes back.
   */
  jobs: string[];
  /** Shown in the UI when the date semantics are non-obvious. */
  note?: string;
}

export const PURGE_TARGETS: PurgeTarget[] = [
  {
    collection: 'tickers',
    label: 'Ticker universe + quotes',
    dateField: 'asOfDate',
    dateFormat: 'date',
    recursive: false,
    jobs: ['ticker-universe', 'market-quotes'],
    note: 'asOfDate is written only by market-quotes. Reference docs written by ticker-universe have no date and are matched ONLY by a full purge.',
  },
  {
    collection: 'companies',
    label: 'Company profiles + ratings',
    dateField: 'updatedAt',
    dateFormat: 'datetime',
    recursive: false,
    jobs: ['companies', 'rs-rating', 'tech-rating', 'technical-indicators', 'fundamentals-growth'],
    note: 'Written by 5 jobs into disjoint field sets. A purge removes the whole document, including ratings the other 4 jobs computed.',
  },
  {
    collection: 'ohlcv_bars',
    label: 'Daily OHLCV bars',
    dateField: 'barDate',
    dateFormat: 'date',
    recursive: false,
    jobs: ['stock-history'],
  },
  {
    collection: 'news',
    label: 'News articles',
    dateField: 'publishedAt',
    dateFormat: 'datetime',
    recursive: false,
    jobs: ['news'],
  },
  {
    collection: 'earnings_events',
    label: 'Earnings calendar',
    dateField: 'date',
    dateFormat: 'date',
    recursive: false,
    jobs: ['earnings'],
  },
  {
    collection: 'analyst_actions',
    label: 'Analyst consensus',
    dateField: 'updatedAt',
    dateFormat: 'datetime',
    recursive: false,
    jobs: ['analyst-actions'],
  },
  {
    collection: 'market_movers',
    label: 'Market movers (current)',
    dateField: 'asOfDate',
    dateFormat: 'date',
    recursive: false,
    jobs: ['market-movers'],
  },
  {
    collection: 'market_movers_history',
    label: 'Market movers (history)',
    dateField: 'asOfDate',
    dateFormat: 'date',
    recursive: false,
    jobs: ['market-movers'],
  },
  {
    collection: 'market_indices',
    label: 'Market indices (current)',
    dateField: 'updatedAt',
    dateFormat: 'datetime',
    recursive: false,
    jobs: ['market-indices'],
    note: 'The current doc carries no asOfDate — only its history twin does — so a date range here filters on write time, not market date.',
  },
  {
    collection: 'market_indices_history',
    label: 'Market indices (history)',
    dateField: 'asOfDate',
    dateFormat: 'date',
    recursive: false,
    jobs: ['market-indices'],
  },
  {
    collection: 'sectors',
    label: 'Sector performance (current)',
    dateField: 'asOfDate',
    dateFormat: 'date',
    recursive: false,
    jobs: ['sectors'],
  },
  {
    collection: 'sectors_history',
    label: 'Sector performance (history)',
    dateField: 'asOfDate',
    dateFormat: 'date',
    recursive: false,
    jobs: ['sectors'],
  },
  {
    collection: 'dividends',
    label: 'Dividend calendar',
    dateField: 'exDividendDate',
    dateFormat: 'date',
    recursive: false,
    jobs: ['dividends'],
  },
  {
    collection: 'ipos',
    label: 'IPO calendar',
    dateField: 'date',
    dateFormat: 'date',
    recursive: false,
    jobs: ['ipos'],
  },
  {
    collection: 'macro_events',
    label: 'Macro events (FRED)',
    dateField: 'updatedAt',
    dateFormat: 'datetime',
    recursive: false,
    jobs: ['macro-events'],
  },
  {
    collection: 'market_sentiment',
    label: 'Fear & Greed index',
    dateField: 'asOfDate',
    dateFormat: 'date',
    recursive: false,
    jobs: ['fear-greed'],
  },
  {
    collection: 'options_chains',
    label: 'Options chains',
    dateField: 'updatedAt',
    dateFormat: 'datetime',
    recursive: false,
    jobs: ['options-chains'],
  },
  {
    collection: 'insider_transactions',
    label: 'Insider transactions (Form 4)',
    dateField: 'filingDate',
    dateFormat: 'date',
    recursive: false,
    jobs: ['sec-form4'],
  },
  {
    collection: 'fund_holdings',
    label: 'Fund holdings (13F)',
    dateField: 'updatedAt',
    dateFormat: 'datetime',
    recursive: true,
    jobs: ['sec-13f'],
    note: 'Each fund owns filings/{id}/positions subcollections; deleted recursively so children are not orphaned.',
  },
];

export const PURGE_TARGETS_BY_NAME = new Map(
  PURGE_TARGETS.map((t) => [t.collection, t]),
);

/**
 * Inclusive upper bound for a range query. A 'datetime' field stores a full ISO
 * timestamp, so `<= '2026-07-19'` would exclude everything written that day —
 * widen it to the last instant of the day instead.
 */
export function toBound(target: PurgeTarget, to: string): string {
  return target.dateFormat === 'datetime' ? `${to}T23:59:59.999Z` : to;
}
