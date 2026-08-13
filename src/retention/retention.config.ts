/**
 * Data-retention rules (delivery-plan R5 "TTL" item, done in-code).
 *
 * WHY NOT NATIVE FIRESTORE TTL
 * Firestore TTL requires a `Timestamp`-typed field. Every date in this app is
 * stored as an ISO STRING (`new Date().toISOString()`, `'YYYY-MM-DD'`), so a
 * native TTL policy cannot attach to any of them. Rather than rewrite every
 * write to emit parallel Timestamp fields, retention is enforced here by a
 * scheduled prune that understands the string formats.
 *
 * WHAT IS AND IS NOT PRUNED — the critical safety rule
 * ONLY append-only historical snapshots and genuinely-stale rows are eligible.
 * Forward-looking calendars (earnings_events, dividends, ipos, macro_events)
 * are DELIBERATELY ABSENT: their date field holds FUTURE dates, so a
 * "delete older than N days" pass is meaningless for them and a mistake here
 * would erase upcoming events the UI depends on. Current-snapshot collections
 * (companies, tickers, market_movers, …) are upserted by key and never grow
 * unbounded, so they need no retention either.
 */

export interface RetentionRule {
  /** Collection name — must exist in the purge registry. */
  collection: string;
  /** Field carrying the row's own date. */
  dateField: string;
  /** 'date' → 'YYYY-MM-DD'; 'datetime' → full ISO. Controls the cutoff format. */
  dateFormat: "date" | "datetime";
  /** Delete rows whose dateField is older than this many days. */
  retentionDays: number;
  /** Why this window — keeps the choice auditable. */
  note: string;
}

export const RETENTION_RULES: RetentionRule[] = [
  {
    collection: "market_movers_history",
    dateField: "asOfDate",
    dateFormat: "date",
    retentionDays: 400,
    note: "Daily mover snapshots; ~13 months covers YoY comparisons.",
  },
  {
    collection: "market_indices_history",
    dateField: "asOfDate",
    dateFormat: "date",
    retentionDays: 400,
    note: "Daily index snapshots; 13 months.",
  },
  {
    collection: "sectors_history",
    dateField: "asOfDate",
    dateFormat: "date",
    retentionDays: 400,
    note: "Daily sector snapshots; 13 months.",
  },
  {
    collection: "news",
    dateField: "publishedAt",
    dateFormat: "datetime",
    retentionDays: 120,
    note: "Articles age out of relevance; 4 months is generous for a news feed.",
  },
  {
    collection: "ohlcv_bars",
    dateField: "barDate",
    dateFormat: "date",
    retentionDays: 800,
    // NOTE: keep > 2 years. rs-rating and the 1Y chart read a full year of
    // bars; trimming below ~500 days would silently corrupt those.
    note: "Price history; >2yr so RS-rating and 1Y charts stay intact.",
  },
];

/** Cutoff string for a rule, `retentionDays` before `now`. */
export function cutoffFor(rule: RetentionRule, now: Date): string {
  const d = new Date(now.getTime() - rule.retentionDays * 86_400_000);
  const iso = d.toISOString();
  // 'date' fields compare as 'YYYY-MM-DD'; 'datetime' as a full ISO instant.
  return rule.dateFormat === "date" ? iso.slice(0, 10) : iso;
}
