import { Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { tapeStocks } from "../live/tape-universe";
import { capBucket } from "../adapters/types";
import { LiveCoalescer } from "../common/live-coalescer";

/**
 * Live replacement for the `companies` sync job + Firestore `companies`
 * collection. The bulk companies feed backs 14 screens' ticker→name/sector/
 * price/marketCap lookups (Movers rvol, Heatmap tiles, Themes, sector lists,
 * Screener universe, watchlist/portfolio rows, …).
 *
 * The old collection was assembled by a whole pipeline of daily jobs
 * (companies + rs-rating + tech-rating + technical-indicators +
 * fundamentals-growth). Those per-universe COMPUTED metrics (RS/tech ratings,
 * RSI/MACD/SMA/52w, revenue/EPS growth, sector ranks, peers) are inherently a
 * whole-universe batch — they can't be produced live per request — so in the
 * live feed they are null. When a user opens a stock, GET /live/company fills
 * that ticker's full profile on demand (the per-ticker analog).
 *
 * What IS served live and cheaply, per request:
 *   - universe: resolved dynamically from the tape + every user's watchlists &
 *     holdings + the ticker_usage hot list (NO `companies` collection — that
 *     goes away with the worker), deduped and capped.
 *   - price / pctChange: ONE batched Polygon universal-snapshot call.
 *   - name / sector / marketCap: one ticker-details call each (parallel).
 *
 * Coalesced 60s: heavier than the price-only endpoints and this data (names,
 * sectors, caps) barely moves intraday; still an in-memory window, no cache/cron.
 */

// Snapshot takes ticker.any_of with limit 250 — one call covers the universe.
const UNIVERSE_CAP = 250;
const DETAIL_CONCURRENCY = 40;
const HOT_USAGE_LIMIT = 150;
const REUSE_MS = 60_000;
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

@Injectable()
export class LiveCompaniesService {
  private readonly logger = new Logger(LiveCompaniesService.name);
  private readonly coalescer = new LiveCoalescer(REUSE_MS);

  constructor(
    private readonly polygon: PolygonService,
    private readonly firebase: FirebaseAdminService,
  ) {}

  /**
   * The dynamic universe — the same sources premarket used to grow `companies`,
   * read live instead of from the (now-removed) collection: tape stocks + every
   * watchlist + every holding + the usage hot list. Deduped, validated, capped.
   */
  private async resolveUniverse(): Promise<string[]> {
    const hot = new Set<string>();
    for (const s of tapeStocks()) hot.add(s.id);

    const db = this.firebase.firestore;
    try {
      const watchlists = await db.collectionGroup("watchlists").get();
      for (const d of watchlists.docs) {
        for (const t of (d.data().tickers ?? []) as string[]) {
          if (typeof t === "string" && t) hot.add(t.toUpperCase());
        }
      }
    } catch (err) {
      this.logger.warn(`watchlists read failed: ${(err as Error).message}`);
    }
    try {
      const holdings = await db.collectionGroup("holdings").get();
      for (const d of holdings.docs) hot.add(d.id.toUpperCase());
    } catch (err) {
      this.logger.warn(`holdings read failed: ${(err as Error).message}`);
    }
    try {
      const usage = await db
        .collection("ticker_usage")
        .orderBy("count", "desc")
        .limit(HOT_USAGE_LIMIT)
        .get();
      for (const d of usage.docs) hot.add(d.id.toUpperCase());
    } catch (err) {
      this.logger.warn(`ticker_usage read failed: ${(err as Error).message}`);
    }

    return [...hot].filter((t) => TICKER_RE.test(t)).sort().slice(0, UNIVERSE_CAP);
  }

  async getCompanies() {
    return this.coalescer.run("companies", async () => {
      const universe = await this.resolveUniverse();
      if (universe.length === 0) return [];

      const snapshots = await this.polygon.getUniversalSnapshot(universe);
      const snapByTicker = new Map(snapshots.map((s) => [s.ticker, s]));

      // name/sector/marketCap — one ticker-details call each, bounded fan-out.
      const details = new Map<
        string,
        { name: string | null; sector: string | null; marketCap: number | null }
      >();
      for (let i = 0; i < universe.length; i += DETAIL_CONCURRENCY) {
        const chunk = universe.slice(i, i + DETAIL_CONCURRENCY);
        await Promise.all(
          chunk.map(async (ticker) => {
            try {
              const d = await this.polygon.getTickerDetails(ticker);
              if (d) {
                details.set(ticker, {
                  name: d.name ?? null,
                  sector: d.sic_description ?? null,
                  marketCap: d.market_cap ?? null,
                });
              }
            } catch {
              // One ticker without details shouldn't sink the universe.
            }
          }),
        );
      }

      return universe.map((ticker) => {
        const s = snapByTicker.get(ticker);
        const d = details.get(ticker);
        const marketCap = d?.marketCap ?? null;
        return {
          id: ticker,
          ticker,
          name: d?.name ?? s?.name ?? null,
          price: s?.price ?? null,
          pctChange: s?.changePercent ?? null,
          marketCap,
          rvol: null,
          peRatio: null,
          rsRating: null,
          techRating: null,
          revenueGrowthYoY: null,
          epsGrowthYoY: null,
          grossMargin: null,
          dividendYield: null,
          beta: null,
          sector: d?.sector ?? null,
          cap: capBucket(marketCap),
          rsi14: null,
          macd: null,
          macdSignal: null,
          macdHistogram: null,
          sectorRank: null,
          sectorRankTotal: null,
          peers: null,
          source: "polygon-live",
        };
      });
    });
  }
}
