import { Injectable } from "@nestjs/common";
import { FmpService } from "../vendors/fmp/fmp.service";
import { AdapterResult, CanonicalNewsArticle, NewsAdapter } from "./types";

/** FMP sentiment may arrive as a label ("Positive"/"Bearish"/…) or a score. */
function normSentiment(
  s: string | null,
): "positive" | "negative" | "neutral" | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (t.includes("pos") || t.includes("bull")) return "positive";
  if (t.includes("neg") || t.includes("bear")) return "negative";
  if (t.includes("neu")) return "neutral";
  const n = Number(s);
  if (Number.isFinite(n)) return n > 0.15 ? "positive" : n < -0.15 ? "negative" : "neutral";
  return null;
}

/** Stable id from the article URL so re-runs update in place and dedup. */
function idFromUrl(url: string): string {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (Math.imul(31, h) + url.charCodeAt(i)) | 0;
  return `fmp_${(h >>> 0).toString(36)}`;
}

/**
 * FMP news source (supplementary to Polygon). Emits the same canonical shape
 * with `vendor: "fmp"` so the merged feed can badge each article by vendor.
 * Dormant when FMP is disabled (no key) — returns an empty result.
 */
@Injectable()
export class FmpNewsAdapter implements NewsAdapter {
  readonly sourceName = "fmp";

  constructor(private readonly fmp: FmpService) {}

  async fetchNews(
    ticker: string,
    from: string,
    to: string,
  ): Promise<AdapterResult<CanonicalNewsArticle[]>> {
    if (!this.fmp.enabled) {
      return { data: [], source: this.sourceName, warnings: [] };
    }
    const rows = await this.fmp.getStockNews(ticker, from, to);
    const data = rows
      .filter((r) => r.url && r.title)
      .map((r) => this.toCanonical(r, ticker));
    return { data, source: this.sourceName, warnings: [] };
  }

  /**
   * BULK latest news across every symbol — the market-wide sibling of
   * `fetchNews`, so the sync can cover the whole universe in a couple of calls
   * instead of one per ticker. Each row already carries its own `symbol`, so the
   * caller filters to the tickers it tracks. Rows without a symbol (FMP's macro
   * "general" items) are skipped: this feed is per-company by design.
   *
   * `from`/`to` are accepted for interface parity but FMP's latest-news endpoint
   * has no date range — it returns newest-first, which is what a 30-minute sweep
   * wants anyway; the caller drops anything older than its lookback.
   */
  async fetchMarketNews(): Promise<AdapterResult<CanonicalNewsArticle[]>> {
    if (!this.fmp.enabled) {
      return { data: [], source: this.sourceName, warnings: [] };
    }
    const rows = await this.fmp.getLatestStockNews();
    const data = rows
      .filter((r) => r.url && r.title && r.symbol)
      .map((r) => this.toCanonical(r, r.symbol as string));
    return { data, source: this.sourceName, warnings: [] };
  }

  /** One FMP row -> the canonical shape both fetch paths emit. */
  private toCanonical(
    r: {
      url: string; title: string; text: string | null; site: string | null;
      sentiment: string | null; publishedDate: string; image: string | null;
    },
    ticker: string,
  ): CanonicalNewsArticle {
    return {
      id: idFromUrl(r.url),
      ticker,
      headline: r.title,
      summary: r.text ? r.text.slice(0, 400) : null,
      source: r.site ?? "FMP",
      vendor: "fmp",
      url: r.url,
      category: null,
      sentiment: normSentiment(r.sentiment),
      sentimentReasoning: null,
      keywords: [],
      publishedAt: r.publishedDate
        ? new Date(r.publishedDate.replace(" ", "T") + "Z").toISOString()
        : new Date().toISOString(),
      imageUrl: r.image ?? null,
    };
  }
}
