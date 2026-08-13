import { Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { ConfigService } from "@nestjs/config";
import { fetchJson } from "../common/http.util";

/**
 * Live-direct price snapshot: one vendor call per request, mapped to the
 * SnapshotQuote shape. There is NO caching — every request hits Polygon's v3
 * universal snapshot. Repeat views are absorbed by the controller's edge/browser
 * Cache-Control + ETag (304) headers rather than a server-side cache.
 *
 * The underlying feed is ~15 minutes delayed on the current plan, so the
 * response is at most one round-trip newer than the previous cached design.
 */

export interface SnapshotQuote {
  ticker: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  previousClose: number | null;
  open: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayVolume: number | null;
  dayVwap: number | null;
  /** Last minute-bar close and its timestamp (epoch ms). */
  minuteClose: number | null;
  minuteAt: number | null;
  /** Vendor's own "updated" clock (epoch ms), converted from nanoseconds. */
  vendorUpdatedAt: number | null;
  earlyTradingChangePct: number | null;
  lateTradingChangePct: number | null;
  regularTradingChangePct: number | null;
  /** "open" | "closed" | "early_trading" | "late_trading" per the vendor. */
  marketStatus: string | null;
}

@Injectable()
export class SnapshotService {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get("POLYGON_API_KEY", "");
    this.baseUrl = this.config
      .get("POLYGON_API_BASE_URL", "https://api.polygon.io")
      .replace(/\/$/, "");
  }

  /** ONE upstream call for the requested tickers, mapped to SnapshotQuote. */
  async get(
    tickers: string[],
  ): Promise<{ quotes: SnapshotQuote[]; ageMs: number }> {
    if (tickers.length === 0 || !this.apiKey) return { quotes: [], ageMs: 0 };
    const list = tickers.join(",");
    const url =
      `${this.baseUrl}/v3/snapshot` +
      `?ticker.any_of=${encodeURIComponent(list)}&limit=250&apiKey=${this.apiKey}`;
    const res = await fetchJson<{ results?: any[] }>(url);
    const quotes = (res.results ?? []).map((t) => this.map(t));
    // Data is fetched fresh on this request; the "age" of the cache is zero.
    return { quotes, ageMs: 0 };
  }

  /** Weak ETag over the payload, so unchanged intervals return 304. */
  etagFor(quotes: SnapshotQuote[]): string {
    const h = createHash("sha1")
      .update(JSON.stringify(quotes))
      .digest("hex")
      .slice(0, 16);
    return `W/"${h}"`;
  }

  private map(t: any): SnapshotQuote {
    const s = t.session ?? {};
    const min = t.last_minute ?? {};
    // `last_updated` is NANOSECONDS since epoch on this endpoint; dividing by
    // 1e6 yields ms. Treating it as ms would place it ~56,000 years ahead.
    const toMs = (v: unknown) =>
      typeof v === "number" ? Math.round(v / 1e6) : null;
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    const price = num(s.price) ?? num(min.close) ?? num(s.previous_close);
    return {
      ticker: t.ticker,
      price,
      change: num(s.change),
      changePct: num(s.change_percent),
      previousClose: num(s.previous_close),
      open: num(s.open),
      dayHigh: num(s.high),
      dayLow: num(s.low),
      dayVolume: num(s.volume),
      dayVwap: num(s.vwap),
      minuteClose: num(min.close),
      minuteAt: toMs(min.last_updated),
      vendorUpdatedAt: toMs(s.last_updated),
      earlyTradingChangePct: num(s.early_trading_change_percent),
      lateTradingChangePct: num(s.late_trading_change_percent),
      regularTradingChangePct: num(s.regular_trading_change_percent),
      marketStatus: t.market_status ?? null,
    };
  }
}
