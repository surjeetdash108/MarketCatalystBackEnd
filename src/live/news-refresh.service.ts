import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import {
  NEWS_ADAPTER,
  NEWS_FMP_ADAPTER,
  NEWS_TRADINGVIEW_ADAPTER,
  type CanonicalNewsArticle,
  type NewsAdapter,
} from "../adapters/types";
import {
  CacheStatusService,
  type EnsureOutcome,
} from "../common/cache-status.service";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  batchSetWithCreatedAt,
  chunkedBatchSet,
  type PendingWrite,
} from "../common/firestore-batch.util";
import { scoreImportance } from "../common/news-importance.util";
import { categoriseNews } from "../common/news-category.util";
import { TickerAiAnalysisService } from "./ticker-ai-analysis.service";
import { OnDemandService } from "./ondemand.service";
import { isFillerNews } from "../common/news-filler.util";
import {
  NotificationsService,
  type NotificationInput,
} from "../common/notifications.service";
import { SyncMetaService } from "../common/sync-meta.service";
import { TICKER_UNIVERSE, activeUniverse } from "../common/ticker-universe";
import { isoDate } from "../common/date.util";
import {
  NEWS_BREAKING_COLLECTION,
  NEWS_BREAKING_KEY,
  NEWS_BREAKING_TTL_MS,
  newsTickerKey,
} from "./news-cache-keys";

const JOB_NAME = "news";

const ARTICLES_PER_TICKER = 8;
const LOOKBACK_DAYS = 2;
const MAX_TICKERS_PER_CYCLE = Number(process.env.TICKER_AI_PER_CYCLE ?? 0);

const PROACTIVE_CANDIDATES = 40;
const PROACTIVE_MAX = 10;
const PROACTIVE_CONCURRENCY = 3;

type NewsDoc = { id: string; data: Record<string, unknown> };

const text = (v: unknown): string => (typeof v === "string" ? v : "");

export interface NewsRefreshResult {
  count: number;
  skipped?: boolean;
  tickersCovered?: number;
  breakingCount?: number;
  analysisAttempted?: number;
  analysisSucceeded?: number;
  analysisFailed?: number;
  polygonCount?: number;
  fmpCount?: number;
  tradingViewCount?: number;
  affectedTickers?: string[];
  newestPublishedAt?: string | null;
}

@Injectable()
export class NewsRefreshService {
  private readonly logger = new Logger(NewsRefreshService.name);

  constructor(
    @Inject(NEWS_ADAPTER) private readonly news: NewsAdapter,
    @Optional()
    @Inject(NEWS_FMP_ADAPTER)
    private readonly newsFmp: NewsAdapter | null,
    @Optional()
    @Inject(NEWS_TRADINGVIEW_ADAPTER)
    private readonly newsTradingView: NewsAdapter | null,
    private readonly tickerAi: TickerAiAnalysisService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly notifications: NotificationsService,
    private readonly cacheStatus: CacheStatusService,
    private readonly ondemand: OnDemandService,
  ) {}

  ensureFresh(wait = false): Promise<EnsureOutcome> {
    return this.cacheStatus.ensureFresh({
      awaitRefresh: wait,
      key: NEWS_BREAKING_KEY,
      location: "news",
      ttlMs: NEWS_BREAKING_TTL_MS,
      hasData: async () => {
        const snap = await this.firebase.firestore
          .collection("news")
          .limit(1)
          .get();
        return !snap.empty;
      },
      refresh: async () => {
        const res = await this.refresh();
        if (res.skipped) {
          throw new Error("every bulk news source returned 0 articles");
        }
        return { watermark: res.newestPublishedAt ?? undefined };
      },
    });
  }

  private async writeNewsCounts(tickers: string[]): Promise<number> {
    const col = this.firebase.firestore.collection("news");
    const now = new Date().toISOString();

    const writes: PendingWrite[] = [];
    for (const ticker of tickers) {
      try {
        const agg = await col.where("ticker", "==", ticker).count().get();
        writes.push({
          ref: this.firebase.firestore.collection("companies").doc(ticker),
          data: { ticker, newsCount: agg.data().count, newsCountAt: now },
        });
      } catch (err) {
        const why = err instanceof Error ? err.message : String(ticker);
        this.logger.warn(`newsCount failed for ${ticker}: ${why}`);
      }
    }
    await batchSetWithCreatedAt(this.firebase.firestore, writes);
    return writes.length;
  }

  private ingestArticle(
    a: CanonicalNewsArticle,
    symbol: string,
    docs: NewsDoc[],
    important: Map<string, NotificationInput>,
    breaking: NewsDoc[],
  ): void {
    const verdict = scoreImportance(a);
    if (verdict.important) {
      const existing = important.get(a.id);
      if (existing) {
        if (a.ticker && !existing.tickers.includes(a.ticker)) {
          existing.tickers.push(a.ticker);
        }
      } else {
        important.set(a.id, {
          id: a.id,
          type: "news",
          header: a.headline,
          detail: a.summary,
          imageUrl: a.imageUrl,
          tickers: a.ticker ? [a.ticker] : [],
          source: a.source,
          url: a.url,
          publishedAt: a.publishedAt,
          direction: verdict.direction,
          reasons: verdict.reasons,
        });
      }
    }
    const filler = isFillerNews(a.headline, a.summary, a.source);
    const id = `${symbol}_${a.id}`;
    const data: Record<string, unknown> = {
      ticker: a.ticker,
      headline: a.headline,
      summary: a.summary,
      source: a.source,
      vendor: a.vendor,
      url: a.url,
      category: a.category,
      sourceCategory: a.category,
      tag: categoriseNews(a.headline, a.summary),
      filler,
      sentiment: a.sentiment,
      sentimentReasoning: a.sentimentReasoning,
      keywords: a.keywords,
      imageUrl: a.imageUrl,
      publishedAt: a.publishedAt,
      updatedAt: new Date().toISOString(),
    };
    docs.push({ id, data });
    if (verdict.important && !filler) {
      breaking.push({
        id,
        data: {
          ...data,
          direction: verdict.direction,
          importanceReasons: verdict.reasons,
        },
      });
    }
  }

  private async runTickerAnalysis(
    byTicker: Map<string, CanonicalNewsArticle[]>,
  ): Promise<{ attempted: number; succeeded: number; failed: number }> {
    if (MAX_TICKERS_PER_CYCLE <= 0) {
      return { attempted: 0, succeeded: 0, failed: 0 };
    }
    const lastUpdated = await this.tickerAi.lastUpdatedMap([
      ...byTicker.keys(),
    ]);
    const ranked = [...byTicker.entries()]
      .map(([ticker, items]) => ({
        ticker,
        items,
        last: lastUpdated.get(ticker) ?? null,
      }))
      .sort((a, b) => {
        if (!a.last && b.last) return -1;
        if (a.last && !b.last) return 1;
        if (a.last && b.last && a.last !== b.last)
          return a.last < b.last ? -1 : 1;
        if (!a.last && !b.last) return a.ticker.localeCompare(b.ticker);
        return b.items.length - a.items.length;
      })
      .slice(0, MAX_TICKERS_PER_CYCLE)
      .map((r) => [r.ticker, r.items] as const);
    let succeeded = 0,
      failed = 0;
    for (const [ticker, items] of ranked) {
      try {
        const out = await this.tickerAi.analyseTicker(
          ticker,
          items.map((n) => ({
            id: n.id,
            headline: n.headline,
            summary: n.summary,
            source: n.source,
            publishedAt: n.publishedAt,
            tag: categoriseNews(n.headline, n.summary),
          })),
          {},
        );
        if (out) succeeded++;
        else failed++;
      } catch (err) {
        failed++;
        this.logger.warn(
          `ticker-ai failed for ${ticker}: ${(err as Error).message}`,
        );
      }
    }
    if (ranked.length) {
      this.logger.log(
        `ticker-ai: ${succeeded} updated, ${failed} failed of ${ranked.length} attempted`,
      );
    }
    return { attempted: ranked.length, succeeded, failed };
  }

  private async refreshDetailNews(
    breaking: NewsDoc[],
  ): Promise<{ stale: number; refreshed: number; failed: number }> {
    const none = { stale: 0, refreshed: 0, failed: 0 };
    try {
      const newest = new Map<string, number>();
      for (const b of breaking) {
        const ticker = text(b.data.ticker);
        const at = Date.parse(text(b.data.publishedAt));
        if (!ticker || !Number.isFinite(at)) continue;
        if (at > (newest.get(ticker) ?? 0)) newest.set(ticker, at);
      }
      const items = [...newest.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, PROACTIVE_CANDIDATES)
        .map(([ticker, at]) => ({
          key: newsTickerKey(ticker),
          dataNewerThan: at,
        }));
      const stale = await this.cacheStatus.expireIfOlderThan(items);
      const prefix = newsTickerKey("");
      const tickers = stale
        .slice(0, PROACTIVE_MAX)
        .map((key) => key.slice(prefix.length));

      let refreshed = 0;
      let failed = 0;
      let next = 0;
      const worker = async () => {
        while (next < tickers.length) {
          const ticker = tickers[next++];
          try {
            const out = await this.ondemand.refreshTickerNews(ticker);
            if (out.kind === "refreshed" || out.kind === "first-fill") {
              if (out.ok) refreshed++;
              else failed++;
            }
          } catch {
            failed++;
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(PROACTIVE_CONCURRENCY, tickers.length) },
          worker,
        ),
      );
      return { stale: stale.length, refreshed, failed };
    } catch (err) {
      this.logger.warn(
        `proactive ticker news refresh failed: ${(err as Error).message}`,
      );
      return none;
    }
  }

  async refresh(): Promise<NewsRefreshResult> {
    try {
      const universe = await activeUniverse(this.firebase.firestore).catch(
        () => [] as string[],
      );
      const list = universe.length > 0 ? universe : TICKER_UNIVERSE;
      const tracked = new Set(list);
      const to = new Date();
      const from = new Date();
      from.setUTCDate(from.getUTCDate() - LOOKBACK_DAYS);
      const docs: NewsDoc[] = [];
      const breaking: NewsDoc[] = [];
      const important = new Map<string, NotificationInput>();

      const collected: CanonicalNewsArticle[] = [];
      let polygonCount = 0;
      let fmpCount = 0;

      if (typeof this.news.fetchMarketNews === "function") {
        try {
          const market = await this.news.fetchMarketNews(
            isoDate(from),
            isoDate(to),
          );
          collected.push(...market.data);
          polygonCount = market.data.length;
        } catch (err) {
          this.logger.warn(
            `Bulk news fetch (${this.news.sourceName}) failed: ${(err as Error).message}`,
          );
        }
      }
      if (this.newsFmp && typeof this.newsFmp.fetchMarketNews === "function") {
        try {
          const fmpRes = await this.newsFmp.fetchMarketNews(
            isoDate(from),
            isoDate(to),
          );
          collected.push(...fmpRes.data);
          fmpCount = fmpRes.data.length;
        } catch (err) {
          this.logger.warn(
            `Bulk news fetch (fmp) failed: ${(err as Error).message}`,
          );
        }
      }

      let tradingViewCount = 0;
      if (
        this.newsTradingView &&
        typeof this.newsTradingView.fetchMarketNews === "function"
      ) {
        try {
          const tvRes = await this.newsTradingView.fetchMarketNews(
            isoDate(from),
            isoDate(to),
          );
          collected.push(...tvRes.data);
          tradingViewCount = tvRes.data.length;
          for (const w of tvRes.warnings) {
            this.logger.log(`news (tradingview): ${w.code} — ${w.message}`);
          }
        } catch (err) {
          this.logger.warn(
            `Bulk news fetch (tradingview) failed: ${(err as Error).message}`,
          );
        }
      }

      if (collected.length === 0) {
        this.logger.warn(
          "news: every bulk source returned 0 articles — skipping write",
        );
        await this.meta.record(JOB_NAME, {
          ok: false,
          error: "bulk news returned no articles from any source",
        });
        return { count: 0, skipped: true };
      }

      const byTicker = new Map<string, CanonicalNewsArticle[]>();
      const seenUrlByTicker = new Map<string, Set<string>>();
      const fmpFirst = [
        ...collected.filter((a) => a.vendor === "fmp"),
        ...collected.filter((a) => a.vendor !== "fmp"),
      ];
      for (const a of fmpFirst) {
        const t = a.ticker;
        if (!t || !tracked.has(t)) continue;
        const seen = seenUrlByTicker.get(t) ?? new Set<string>();
        if (a.url && seen.has(a.url)) continue;
        if (a.url) seen.add(a.url);
        seenUrlByTicker.set(t, seen);
        const bucket = byTicker.get(t) ?? [];
        bucket.push(a);
        byTicker.set(t, bucket);
      }
      for (const [symbol, articles] of byTicker) {
        articles.sort((a, b) =>
          (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
        );
        for (const a of articles.slice(0, ARTICLES_PER_TICKER)) {
          this.ingestArticle(a, symbol, docs, important, breaking);
        }
      }

      await chunkedBatchSet(this.firebase.firestore, "news", docs);
      if (breaking.length > 0) {
        await chunkedBatchSet(
          this.firebase.firestore,
          NEWS_BREAKING_COLLECTION,
          breaking,
        );
      }
      const counted = await this.writeNewsCounts([...byTicker.keys()]);
      const pub = await this.notifications.publish([...important.values()]);
      await this.notifications.prune();
      const detail = await this.refreshDetailNews(breaking);
      this.logger.log(
        `bulk news: ${polygonCount} polygon + ${fmpCount} fmp rows -> ` +
          `${docs.length} docs across ${byTicker.size}/${list.length} tracked tickers; ` +
          `${breaking.length} breaking; ${detail.stale} ticker page(s) out of date, ` +
          `${detail.refreshed} refreshed now, ${detail.failed} failed; ` +
          `${important.size} important; ` +
          `${pub.written} notification(s) to ${pub.recipients} user(s); ` +
          `${pub.skipped} matched no subscriber; ` +
          `newsCount refreshed for ${counted} ticker(s)`,
      );
      const ai = await this.runTickerAnalysis(byTicker);

      await this.meta.record(JOB_NAME, {
        ok: true,
        count: docs.length,
        ...(polygonCount === 0 || fmpCount === 0
          ? {
              error: `one bulk source returned nothing (polygon=${polygonCount}, fmp=${fmpCount})`,
            }
          : {}),
      });
      const newestPublishedAt =
        docs
          .map((d) => text(d.data.publishedAt))
          .filter(Boolean)
          .sort()
          .pop() ?? null;
      return {
        count: docs.length,
        tickersCovered: byTicker.size,
        breakingCount: breaking.length,
        analysisAttempted: ai.attempted,
        analysisSucceeded: ai.succeeded,
        analysisFailed: ai.failed,
        polygonCount,
        fmpCount,
        tradingViewCount,
        affectedTickers: [...byTicker.keys()],
        newestPublishedAt,
      };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: (err as Error).message,
      });
      throw err;
    }
  }
}
