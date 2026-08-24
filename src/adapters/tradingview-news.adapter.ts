import { Logger } from "@nestjs/common";
import { fetchJson } from "../common/http.util";
import type {
  AdapterResult,
  CanonicalNewsArticle,
  NewsAdapter,
} from "./types";

/**
 * TradingView news, behind a CONFIGURED FEED URL.
 *
 * ⚠ WHY THIS DOES NOT SCRAPE tradingview.com
 * TradingView does not publish a news API. Its feed is licensed third-party
 * wire content (Reuters, Dow Jones, MT Newswires) served through internal
 * endpoints, and pulling it would breach their terms and redistribute content
 * we hold no licence for. This project already declines that trade elsewhere —
 * apphosting.yaml pins NEWS_SOURCE to polygon rather than "aggregate" because
 * "we hold a Massive/Polygon redistribution licence but not one for Finnhub,
 * so merging its articles would breach it". Scraping TradingView is the larger
 * version of that same exposure.
 *
 * So the adapter is real and complete against the NewsAdapter contract, but it
 * reads from whatever endpoint TRADINGVIEW_NEWS_URL points at — a licensed
 * partner feed, a syndication endpoint, or a self-hosted mirror. Unconfigured
 * it is inert: it returns an empty result with a warning and never blocks the
 * ingestion cycle (§12: one provider failing must not fail the others).
 *
 * Expected payload: a JSON array, or an object with an `items`/`data` array,
 * of records carrying at least a title/headline, a link/url and a published
 * timestamp. Field names vary by feed, so mapping is tolerant.
 */
export class TradingViewNewsAdapter implements NewsAdapter {
  readonly sourceName = "tradingview";
  private readonly logger = new Logger(TradingViewNewsAdapter.name);

  constructor(
    private readonly feedUrl: string | null,
    private readonly apiKey: string | null = null,
  ) {}

  get enabled(): boolean {
    return !!this.feedUrl;
  }

  async fetchNews(
    ticker: string,
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalNewsArticle[]>> {
    return this.pull({ ticker, from, to });
  }

  /** Market-wide pull — the feed's newest items, unfiltered by ticker. */
  async fetchMarketNews(
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalNewsArticle[]>> {
    return this.pull({ from, to });
  }

  private async pull(opts: {
    ticker?: string;
    from: string;
    to: string;
  }): Promise<AdapterResult<CanonicalNewsArticle[]>> {
    if (!this.feedUrl) {
      return {
        data: [],
        source: this.sourceName,
        warnings: [
          {
            code: "FIELD_NOT_SUPPORTED",
            field: "TRADINGVIEW_NEWS_URL",
            message:
              "TradingView news is not configured. Point TRADINGVIEW_NEWS_URL at a LICENSED feed to enable it — this adapter deliberately does not scrape tradingview.com.",
          },
        ],
      };
    }

    const url = new URL(this.feedUrl);
    if (opts.ticker) url.searchParams.set("symbol", opts.ticker);
    url.searchParams.set("from", opts.from);
    url.searchParams.set("to", opts.to);

    try {
      const raw = await fetchJson<unknown>(url.toString(), {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        retries: 0,
        timeoutMs: 15_000,
      });
      const rows = extractRows(raw);
      const data = rows
        .map((r) => toCanonical(r, opts.ticker ?? null))
        .filter((a): a is CanonicalNewsArticle => a !== null);
      return { data, source: this.sourceName, warnings: [] };
    } catch (err) {
      // Never throw: §12 requires one provider's failure to leave the others
      // running. The caller logs and carries on with Polygon/FMP.
      this.logger.warn(
        `TradingView news fetch failed: ${(err as Error).message}`,
      );
      return {
        data: [],
        source: this.sourceName,
        warnings: [
          {
            code: "SUB_REQUEST_FAILED",
            field: "news",
            message: (err as Error).message,
          },
        ],
      };
    }
  }
}

/** Feeds wrap their payload differently; accept the three common shapes. */
function extractRows(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  const o = (raw ?? {}) as Record<string, unknown>;
  for (const k of ["items", "data", "results", "news"]) {
    if (Array.isArray(o[k])) return o[k] as Array<Record<string, unknown>>;
  }
  return [];
}

const str = (v: unknown): string | null =>
  v == null || v === "" ? null : String(v);

/** Tolerant field mapping — licensed feeds differ in their key names. */
function toCanonical(
  r: Record<string, unknown>,
  fallbackTicker: string | null,
): CanonicalNewsArticle | null {
  const headline = str(r.title ?? r.headline ?? r.name);
  const url = str(r.url ?? r.link ?? r.storyPath);
  const publishedRaw = r.published ?? r.publishedAt ?? r.date ?? r.time;
  if (!headline || !url) return null;

  // Feeds send ISO strings or epoch seconds/millis.
  let publishedAt: string;
  if (typeof publishedRaw === "number") {
    const ms = publishedRaw > 1e12 ? publishedRaw : publishedRaw * 1000;
    publishedAt = new Date(ms).toISOString();
  } else {
    const t = Date.parse(String(publishedRaw ?? ""));
    if (!Number.isFinite(t)) return null;
    publishedAt = new Date(t).toISOString();
  }

  const symbols = Array.isArray(r.symbols)
    ? (r.symbols as unknown[]).map(String)
    : [];
  const ticker = (str(r.symbol) ?? symbols[0] ?? fallbackTicker ?? "").toUpperCase();
  if (!ticker) return null;

  return {
    // Prefer the provider's own article id (§3: "Prefer the provider's unique
    // article ID when available"); fall back to the URL, which is stable.
    id: str(r.id ?? r.storyId ?? r.guid) ?? url,
    ticker,
    headline,
    summary: str(r.summary ?? r.description ?? r.shortDescription),
    source: str(r.provider ?? r.source ?? r.publisher) ?? "TradingView",
    vendor: "tradingview",
    url,
    // The provider's OWN category is preserved here; news.job derives the
    // normalised bucket separately so both survive (§2).
    category: str(r.category ?? r.section ?? r.topic),
    sentiment: null,
    sentimentReasoning: null,
    keywords: Array.isArray(r.tags) ? (r.tags as unknown[]).map(String) : [],
    publishedAt,
    imageUrl: str(r.image ?? r.imageUrl ?? r.thumbnail),
  };
}
