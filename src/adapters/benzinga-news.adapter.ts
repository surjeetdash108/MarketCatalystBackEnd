import { Injectable } from "@nestjs/common";
import { BenzingaService, type BenzingaWiimRow } from "../vendors/benzinga/benzinga.service";
import { AdapterResult, CanonicalNewsArticle, NewsAdapter } from "./types";

@Injectable()
export class BenzingaNewsAdapter implements NewsAdapter {
  readonly sourceName = "benzinga";

  constructor(private readonly benzinga: BenzingaService) {}

  get enabled(): boolean {
    return this.benzinga.enabled;
  }

  private toCanonical(row: BenzingaWiimRow, defaultTicker: string): CanonicalNewsArticle {
    const pubDate = row.created || row.updated || row.created_at || row.updated_at || new Date().toISOString();
    let publishedAt: string;
    try {
      publishedAt = new Date(pubDate).toISOString();
    } catch {
      publishedAt = new Date().toISOString();
    }

    const tickerSymbol =
      row.stocks?.[0]?.name ||
      row.stocks?.[0]?.symbol ||
      row.tickers?.[0] ||
      defaultTicker;

    return {
      id: `benzinga_${row.id}`,
      ticker: tickerSymbol.toUpperCase(),
      headline: row.title,
      summary: row.description || row.teaser || row.body || null,
      source: "Benzinga",
      vendor: "benzinga",
      url: row.url || "",
      category: "wiim",
      sentiment: null,
      sentimentReasoning: null,
      keywords: [],
      publishedAt,
      imageUrl: null,
    };
  }

  async fetchNews(
    ticker: string,
    _from: string,
    _to: string,
  ): Promise<AdapterResult<CanonicalNewsArticle[]>> {
    if (!this.enabled) {
      return { data: [], source: this.sourceName, warnings: [] };
    }

    // Try WIIM endpoint first for mover reasons, fallback to general news
    let rows = await this.benzinga.getWiim([ticker]);
    if (!rows.length) {
      rows = await this.benzinga.getNews([ticker]);
    }

    const data = rows.map((r) => this.toCanonical(r, ticker));
    return { data, source: this.sourceName, warnings: [] };
  }

  async fetchMarketNews(
    _from: string,
    _to: string,
  ): Promise<AdapterResult<CanonicalNewsArticle[]>> {
    if (!this.enabled) {
      return { data: [], source: this.sourceName, warnings: [] };
    }

    const rows = await this.benzinga.getWiim();
    const data = rows.map((r) => this.toCanonical(r, "MARKET"));
    return { data, source: this.sourceName, warnings: [] };
  }
}
