/**
 * Identifies syndicated filler — stories that carry a ticker but no news.
 *
 * Measured on the live feed: of 300 served articles, 96 came from
 * defenseworld.net and 105 from The Motley Fool. The bulk of both are
 * auto-generated 13F holdings notes ("$AAPL Shares Acquired by Balefire LLC")
 * and listicle clickbait ("2 Top Growth Stocks to Buy Right Now"). Together
 * they are roughly two thirds of the feed, and they are why the "Other"
 * category sits near 75%.
 *
 * These are FLAGGED, never dropped at ingest. Dropping would make the decision
 * irreversible and hide a vendor going bad behind a suddenly-thin feed; a flag
 * lets the UI default to hiding them while the rows stay auditable.
 */

/** 13F/holdings boilerplate: a disclosure, not an event. */
const HOLDINGS_BOILERPLATE =
  /\bshares?\s+(acquired|sold|bought|purchased)\s+by\b|\b(stake|position|holdings?)\s+(raised|lowered|trimmed|boosted|cut|increased|decreased)\s+by\b|\b(buys|sells)\s+[\d,]+\s+shares\b|\bhas\s+\$[\d.,]+\s+(million|billion)\s+(stake|position|holdings)\b/i;

/** Ranked-list clickbait with no company event behind it. */
// "The Smartest ETF to Buy" has no leading count, so the superlative alone has
// to qualify — a digit prefix is common but not required.
const LISTICLE =
  /\b(\d+|the)\s+(top|best|smartest|unstoppable|incredible|no[- ]brainer|magnificent)\b[^.]{0,50}\b(stock|etf|fund|compan)/i;

/** Generic "should you buy" opinion pieces. */
const OPINION_BAIT =
  /\b(stock|etf|share|fund)s?\s+to\s+buy\b|\btime\s+to\s+buy\b|\bis\s+it\s+(a\s+)?(buy|too\s+late)\b|\bshould\s+you\s+buy\b|\bbetter\s+buy\b|\bwhere\s+will\s+\w+\s+(stock\s+)?be\s+in\b|\bprediction:\s/i;

/** Publishers whose output is overwhelmingly auto-generated syndication. */
const FILLER_PUBLISHERS = /(^|\.)defenseworld\.net$|(^|\.)marketbeat\.com$|(^|\.)tickerreport\.com$|(^|\.)themarketsdaily\.com$|(^|\.)modernreaders\.com$/i;

/**
 * Shared with news-category.util: a headline matching this must never reach the
 * M&A rules, because "acquired"/"to buy" here mean a holdings line or a
 * listicle, not a transaction.
 */
export function looksLikeDealButIsNot(text: string): boolean {
  return HOLDINGS_BOILERPLATE.test(text) || LISTICLE.test(text) || OPINION_BAIT.test(text);
}

/**
 * @param source publisher/outlet as stored on the article (e.g. "defenseworld.net").
 */
export function isFillerNews(
  headline: string | null | undefined,
  summary?: string | null,
  source?: string | null,
): boolean {
  const src = (source ?? "").trim().toLowerCase();
  if (src && FILLER_PUBLISHERS.test(src)) return true;
  // Headline only: a passing mention of a holdings change inside a real
  // article's body should not bury the article.
  const head = (headline ?? "").replace(/\s+/g, " ").trim();
  if (!head) return false;
  return looksLikeDealButIsNot(head);
}
