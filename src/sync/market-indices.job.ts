import { Injectable, Logger } from "@nestjs/common";
import { PolygonService } from "../vendors/polygon/polygon.service";

// Same multiplier convention as TAPE_INDICES in tape-universe.ts — kept in
// sync deliberately (this job and the tape render the same instruments from two
// independent code paths; any divergence shows up as two tiles disagreeing
// about "S&P 500" on the same screen).
const INDEX_PROXIES = [
  {
    symbol: "SPX",
    label: "S&P 500",
    proxyTicker: "SPY",
    isProxy: true,
    note: "ETF proxy for the S&P 500 index",
    multiplier: 10,
  },
  {
    symbol: "NDX",
    label: "Nasdaq",
    proxyTicker: "QQQ",
    isProxy: true,
    note: "ETF proxy for the Nasdaq-100 index",
    multiplier: 36.3,
  },
  {
    symbol: "DJI",
    label: "Dow",
    proxyTicker: "DIA",
    isProxy: true,
    note: "ETF proxy for the Dow Jones index",
    multiplier: 100,
  },
  {
    symbol: "RUT",
    label: "Russell 2K",
    proxyTicker: "IWM",
    isProxy: true,
    note: "ETF proxy for the Russell 2000 index",
    multiplier: 10,
  },
  {
    symbol: "GOLD",
    label: "Gold",
    proxyTicker: "GLD",
    isProxy: true,
    note: "ETF proxy for spot gold",
  },
  {
    symbol: "WTI",
    label: "WTI Crude",
    proxyTicker: "USO",
    isProxy: true,
    note: "ETF proxy for WTI crude oil",
  },
  {
    symbol: "DXY",
    label: "Dollar (DXY)",
    proxyTicker: "UUP",
    isProxy: true,
    note: "ETF proxy for the US Dollar Index",
  },
  {
    symbol: "VIX",
    label: "VIX",
    proxyTicker: "VIXY",
    isProxy: true,
    note: "Decaying VIX futures ETN — directional proxy only, not the spot VIX level",
  },
];

@Injectable()
export class MarketIndicesJob {
  private readonly logger = new Logger(MarketIndicesJob.name);

  constructor(private readonly polygon: PolygonService) {}

  /**
   * Live-direct: the current index proxies (+ the US10Y treasury yield) computed
   * fresh from Polygon per request, WITHOUT reading or writing Firestore.
   * Returns the same `{id: symbol, ...data}` shape a `market_indices` doc read
   * yielded. ONE universal-snapshot call for the proxies plus one treasury call.
   */
  async fetchLive(): Promise<Record<string, unknown>[]> {
    const now = new Date().toISOString();
    const out: Record<string, unknown>[] = [];

    try {
      const rows = await this.polygon.getUniversalSnapshot(
        INDEX_PROXIES.map((i) => i.proxyTicker),
      );
      const bySymbol = new Map(rows.map((r) => [r.ticker, r]));
      for (const idx of INDEX_PROXIES) {
        const r = bySymbol.get(idx.proxyTicker);
        if (!r) continue;
        const mult = idx.multiplier ?? 1;
        out.push({
          id: idx.symbol,
          label: idx.label,
          proxyTicker: idx.proxyTicker,
          isProxy: idx.isProxy,
          note: idx.note ?? null,
          value: r.price != null ? r.price * mult : null,
          change: r.change != null ? r.change * mult : null,
          pctChange: r.changePercent,
          open: r.open != null ? r.open * mult : null,
          dayHigh: r.high != null ? r.high * mult : null,
          dayLow: r.low != null ? r.low * mult : null,
          prevClose: r.previousClose != null ? r.previousClose * mult : null,
          source: "polygon",
          updatedAt: now,
        });
      }
    } catch (err) {
      this.logger.error(
        `Failed fetching index proxy snapshot: ${(err as Error).message}`,
      );
    }

    // US10Y — the actual constant-maturity yield from Polygon's treasury feed.
    try {
      const curve = await this.polygon.getTreasuryYields(2);
      const latest = curve[0];
      const prior = curve[1];
      if (latest?.yield10Year != null) {
        const value = latest.yield10Year;
        const pc = prior?.yield10Year ?? null;
        const change = pc == null ? null : Math.round((value - pc) * 1000) / 1000;
        out.push({
          id: "US10Y",
          label: "10Y Yield",
          proxyTicker: null,
          isProxy: false,
          note: "US Treasury 10-year constant-maturity yield, in percent",
          unit: "percent",
          value,
          change,
          pctChange:
            pc && pc !== 0 && change != null
              ? Math.round(((value - pc) / pc) * 10000) / 100
              : null,
          open: null,
          prevClose: pc,
          asOfDate: latest.date,
          curve: latest,
          source: "polygon-fed",
          updatedAt: now,
        });
      }
    } catch (err) {
      this.logger.error(
        `Failed fetching treasury yields for US10Y: ${(err as Error).message}`,
      );
    }

    return out;
  }
}
