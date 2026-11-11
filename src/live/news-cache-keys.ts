/**
 * Names shared by everything that touches the news caches. Kept in a file of
 * their own so the on-demand service, the refresh service and the controller can
 * all import them without importing each other.
 */

/** cache_status key for the market-wide news refresh. */
export const NEWS_BREAKING_KEY = "news:breaking";
/** The market-wide news is refreshed at most this often. */
export const NEWS_BREAKING_TTL_MS = 15 * 60_000;
/** Collection holding the market-moving subset of the news. */
export const NEWS_BREAKING_COLLECTION = "news_breaking";
/** cache_status key for one ticker's detail news. */
export const newsTickerKey = (symbol: string) => `news:ticker:${symbol}`;
