import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { fetchJson } from "../../common/http.util";

export interface BenzingaWiimRow {
  id: string | number;
  title: string;
  description?: string | null;
  teaser?: string | null;
  body?: string | null;
  created?: string;
  updated?: string;
  created_at?: string;
  updated_at?: string;
  url?: string | null;
  stocks?: Array<{ name?: string; symbol?: string; exchange?: string }>;
  channels?: Array<{ name?: string }>;
  tickers?: string[];
}

@Injectable()
export class BenzingaService {
  private readonly logger = new Logger(BenzingaService.name);
  private readonly apiKey: string | null;
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>("BENZINGA_API_KEY")?.trim() || null;
    this.baseUrl = (
      this.config.get<string>("BENZINGA_BASE_URL") ?? "https://api.benzinga.com/api/v2"
    ).replace(/\/+$/, "");
  }

  get enabled(): boolean {
    return !!this.apiKey;
  }

  /**
   * Fetch WIIM ("Why Is It Moving?") stories for specific tickers or general feed.
   */
  async getWiim(tickers?: string[]): Promise<BenzingaWiimRow[]> {
    if (!this.enabled) {
      return [];
    }

    try {
      const targetTicker = tickers && tickers.length > 0 ? tickers[0].toUpperCase() : null;

      // 1. Fetch recent WIIM channel stories
      const wiimUrl = new URL(`${this.baseUrl}/news`);
      wiimUrl.searchParams.set("token", this.apiKey!);
      wiimUrl.searchParams.set("displayOutput", "full");
      wiimUrl.searchParams.set("channels", "WIIM");
      wiimUrl.searchParams.set("pageSize", "100");

      const wiimRes = await fetchJson<BenzingaWiimRow[]>(wiimUrl.toString(), {
        headers: { accept: "application/json" },
        timeoutMs: 10_000,
        retries: 1,
      });

      const wiimList = Array.isArray(wiimRes) ? wiimRes : [];

      if (targetTicker) {
        // Filter WIIM stories matching target ticker
        const matched = wiimList.filter((row) =>
          row.stocks?.some((s) => (s.name || s.symbol)?.toUpperCase() === targetTicker),
        );
        if (matched.length > 0) return matched;

        // 2. Fallback: Query news for target ticker and check for WIIM or ticker news
        const symbolNews = await this.getNews([targetTicker]);
        const symbolWiim = symbolNews.filter((row) =>
          row.channels?.some((c) => c.name?.toUpperCase() === "WIIM"),
        );
        return symbolWiim.length > 0 ? symbolWiim : [];
      }

      return wiimList;
    } catch (err) {
      this.logger.warn(`Benzinga WIIM request failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * General Benzinga news fetch for specific tickers.
   */
  async getNews(tickers?: string[]): Promise<BenzingaWiimRow[]> {
    if (!this.enabled) {
      return [];
    }

    try {
      const url = new URL(`${this.baseUrl}/news`);
      url.searchParams.set("token", this.apiKey!);
      url.searchParams.set("displayOutput", "full");
      if (tickers && tickers.length > 0) {
        url.searchParams.set("symbols", tickers.join(","));
      }
      url.searchParams.set("pageSize", "50");

      const res = await fetchJson<BenzingaWiimRow[]>(url.toString(), {
        headers: { accept: "application/json" },
        timeoutMs: 10_000,
        retries: 1,
      });

      const list = Array.isArray(res) ? res : [];
      if (tickers && tickers.length > 0) {
        const target = tickers[0].toUpperCase();
        const matched = list.filter((row) =>
          row.stocks?.some((s) => (s.name || s.symbol)?.toUpperCase() === target),
        );
        return matched.length > 0 ? matched : list;
      }
      return list;
    } catch (err) {
      this.logger.warn(`Benzinga news request failed: ${(err as Error).message}`);
      return [];
    }
  }
}
