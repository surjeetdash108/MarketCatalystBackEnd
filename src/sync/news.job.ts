import { Inject, Injectable, Logger, Optional, OnModuleInit } from "@nestjs/common";
import {
  NEWS_ADAPTER,
  NEWS_FMP_ADAPTER,
  NEWS_TRADINGVIEW_ADAPTER,
  type CanonicalNewsArticle,
  type NewsAdapter,
} from "../adapters/types";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  batchSetWithCreatedAt,
  chunkedBatchSet,
  type PendingWrite,
} from "../common/firestore-batch.util";
import { scoreImportance } from "../common/news-importance.util";
import { categoriseNews } from "../common/news-category.util";
import { TickerAiAnalysisService } from "../live/ticker-ai-analysis.service";
import { isFillerNews } from "../common/news-filler.util";
import {
  NotificationsService,
  type NotificationInput,
} from "../common/notifications.service";
import { SyncMetaService } from "../common/sync-meta.service";
import { TICKER_UNIVERSE, activeUniverse } from "../common/ticker-universe";
import { SyncRegistry } from "../common/sync-registry.service";
import { isoDate } from "../common/date.util";

const JOB_NAME = "news";
// Newest articles kept per ticker — unchanged from the per-ticker sweep, so the
// stored shape and volume stay the same now that the FETCH is bulk.
const ARTICLES_PER_TICKER = 8;
const LOOKBACK_DAYS = 2;
/** Tickers analysed per 10-minute cycle — see runTickerAnalysis for why. */
const MAX_TICKERS_PER_CYCLE = Number(process.env.TICKER_AI_PER_CYCLE) || 8;


@Injectable()
export class NewsJob implements OnModuleInit {
  private readonly logger = new Logger(NewsJob.name);

  constructor(
    @Inject(NEWS_ADAPTER) private readonly news: NewsAdapter,
    @Optional() @Inject(NEWS_FMP_ADAPTER) private readonly newsFmp: NewsAdapter | null,
    @Optional() @Inject(NEWS_TRADINGVIEW_ADAPTER)
    private readonly newsTradingView: NewsAdapter | null,
    private readonly tickerAi: TickerAiAnalysisService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly notifications: NotificationsService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["news"],
      // Every 30 minutes, around the clock, 7 days a week. Market-hours-only
      // (was "*/30 9-16 * * 1-5") left the feed stale overnight, over weekends
      // and through holidays — but news breaks after the close, pre-market and
      // at weekends, which is exactly when the Live Feed looked dead.
      cronExpression: "*/10 * * * *",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  /**
   * Denormalises "how many recent articles does this ticker have" onto the
   * ticker's `companies` doc, as `newsCount` + `newsCountAt`.
   *
   * WHY THIS EXISTS
   * The Earnings calendar renders a per-row news badge. It used to get that by
   * subscribing to the ENTIRE `news` collection and counting client-side —
   * ~4,150 documents and ~3.2 MB shipped to every browser, on every page load,
   * to render one integer per row. That was 76% of the screen's payload.
   *
   * `companies` is already fetched by that screen, so putting the number there
   * costs the client nothing: the news listener disappears outright rather than
   * being replaced by a smaller one.
   *
   * A time-bounded client query was the obvious alternative and does not work:
   * measured 2026-07-23, 100% of the collection is younger than 7 days (older
   * articles are pruned by retention), so no sane window trims anything.
   *
   * Deliberately a SINGLE equality filter, with no `publishedAt` range. Adding
   * one turns this into an equality+range across two fields, which Firestore
   * rejects without a composite index on (ticker, publishedAt) — verified live,
   * it returns FAILED_PRECONDITION. The range would also buy nothing, since
   * retention already bounds the collection to ~7 days. Keeping it single-field
   * means this runs on the automatic index with no deploy step, and returns
   * exactly the number the client used to compute — verified per ticker against
   * a full fetch (AAPL 69, NVDA 76, MSFT 69; all MATCH).
   *
   * `count()` is a server-side aggregation: it returns a number rather than the
   * documents, and bills one read per 1,000 counted. 80 of these per run is far
   * cheaper than every browser pulling the whole collection. Called only for
   * tickers that actually received news in the run.
   */
  private async writeNewsCounts(tickers: string[]): Promise<number> {
    const col = this.firebase.firestore.collection("news");
    const now = new Date().toISOString();

    const writes: PendingWrite[] = [];
    for (const ticker of tickers) {
      try {
        const agg = await col.where("ticker", "==", ticker).count().get();
        writes.push({
          ref: this.firebase.firestore.collection("companies").doc(ticker),
          // `ticker` included even though the doc ID already is one: this
          // merge-write can be the FIRST write for a ticker outside the
          // primary sync universe, and a doc missing `ticker` crashes any
          // frontend code that assumes the field (CompanyDoc types it
          // non-nullable) — e.g. the ticker-search dropdown, 2026-08-01.
          data: { ticker, newsCount: agg.data().count, newsCountAt: now },
        });
      } catch (err) {
        // A transient failure must not fail the news sync itself — the articles
        // are already written by this point.
        const why = err instanceof Error ? err.message : String(ticker);
        this.logger.warn(`newsCount failed for ${ticker}: ${why}`);
      }
    }
    // merge:true (the batch helper's default) is load-bearing: companies.job
    // owns these docs and rewrites them nightly. A non-merge write from here
    // would drop the profile, and its write would drop this count.
    await batchSetWithCreatedAt(this.firebase.firestore, writes);
    return writes.length;
  }

  /**
   * Score one article's importance (merging multi-ticker stories into one
   * notification, keyed by article id) and queue its `news` doc under
   * `${symbol}_${id}`. Shared by both bulk sources so Polygon and FMP articles
   * write identical docs and de-duplicate on the same id.
   */
  private ingestArticle(
    a: CanonicalNewsArticle,
    symbol: string,
    docs: Array<{ id: string; data: Record<string, unknown> }>,
    important: Map<string, NotificationInput>,
  ): void {
    // Importance is derived, not vendor-supplied — see news-importance.util.ts
    // for why and how. Notifications reuse the news doc id so a re-run updates in
    // place instead of duplicating.
    const verdict = scoreImportance(a);
    if (verdict.important) {
      // Keyed on the ARTICLE id, not ticker_article. One story that mentions
      // several tickers is fetched once per ticker, which previously produced a
      // separate notification each time — the same headline appeared 4x in the
      // bell (NVDA, GOOG, GOOGL, ...). Merging tickers into the existing entry
      // keeps one row per story.
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
    docs.push({
      id: `${symbol}_${a.id}`,
      data: {
        ticker: a.ticker,
        headline: a.headline,
        summary: a.summary,
        source: a.source,
        vendor: a.vendor,
        url: a.url,
        // §2: keep BOTH. `sourceCategory` is the provider's own label
        // (null on Polygon/FMP today, populated by feeds that supply one);
        // `tag` is our normalised bucket. `category` stays for older readers.
        category: a.category,
        sourceCategory: a.category,
        // Feed filter bucket (Earnings / Analyst Actions / M&A / …). Derived,
        // because `category` above is the vendor's field and is null on every
        // article from both Polygon and FMP.
        tag: categoriseNews(a.headline, a.summary),
        // Syndicated 13F/listicle noise. Flagged, not dropped: the UI hides it
        // by default but the row stays auditable if a rule turns out wrong.
        filler: isFillerNews(a.headline, a.summary, a.source),
        sentiment: a.sentiment,
        sentimentReasoning: a.sentimentReasoning,
        keywords: a.keywords,
        imageUrl: a.imageUrl,
        publishedAt: a.publishedAt,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  /**
   * Incremental ticker analysis for the tickers that received news (§6).
   *
   * Bounded by MAX_TICKERS_PER_CYCLE: this runs every 10 minutes, so analysing
   * every affected ticker on every cycle would be both slow and expensive
   * (§15). Tickers are ranked by how much news they just received, so the
   * busiest names — the ones whose read actually moved — are refreshed first
   * and the rest catch up on later cycles.
   *
   * Never throws: a model outage must not fail an ingestion cycle that already
   * persisted its news successfully.
   */
  private async runTickerAnalysis(
    byTicker: Map<string, CanonicalNewsArticle[]>,
  ): Promise<{ attempted: number; succeeded: number; failed: number }> {
    // STALENESS FIRST, not news volume.
    //
    // Ranking by article count alone starved the tail completely: the busiest
    // 8 names won every cycle, so after hours of running, 8 tickers had been
    // analysed (all at revision >1) and 369 with news had never been touched
    // once. A quiet ticker would have waited forever.
    //
    // So: never-analysed tickers first, then the least recently updated, with
    // article count only as a tiebreaker. Coverage now grows every cycle and
    // then rotates for freshness, instead of re-reading the same few names.
    const lastUpdated = await this.tickerAi.lastUpdatedMap([...byTicker.keys()]);
    const ranked = [...byTicker.entries()]
      .map(([ticker, items]) => ({ ticker, items, last: lastUpdated.get(ticker) ?? null }))
      .sort((a, b) => {
        if (!a.last && b.last) return -1;
        if (a.last && !b.last) return 1;
        if (a.last && b.last && a.last !== b.last) return a.last < b.last ? -1 : 1;
        return b.items.length - a.items.length;
      })
      .slice(0, MAX_TICKERS_PER_CYCLE)
      .map((r) => [r.ticker, r.items] as const);
    let succeeded = 0, failed = 0;
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
            // Derived at ingest; recomputed here rather than threaded through
            // so the prompt sees the same bucket the feed shows.
            tag: categoriseNews(n.headline, n.summary),
          })),
          {},
        );
        if (out) succeeded++; else failed++;
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

  async run() {
    try {
      // Sweep the LIVE company universe (~575) rather than the hardcoded
      // TICKER_UNIVERSE (241): news covered under half the companies the app
      // actually shows, so most tickers could never surface an article. Falls
      // back to the static list if the collection read comes back empty, so a
      // Firestore blip degrades to the old behaviour instead of skipping the run.
      const universe = await activeUniverse(this.firebase.firestore).catch(
        () => [] as string[],
      );
      const list = universe.length > 0 ? universe : TICKER_UNIVERSE;
      const tracked = new Set(list);
      const to = new Date();
      const from = new Date();
      from.setUTCDate(from.getUTCDate() - LOOKBACK_DAYS);
      const docs: Array<{ id: string; data: Record<string, unknown> }> = [];
      // Keyed by article id so a multi-ticker story collapses to one entry.
      const important = new Map<string, NotificationInput>();

      // ── BULK fetch ────────────────────────────────────────────────────────
      // Was a per-ticker sweep: BATCH_SIZE tickers per run, one vendor call
      // each, so a given ticker was only revisited every ~90 minutes and a story
      // could sit unseen that long. Both vendors expose market-wide feeds — one
      // Polygon call at limit=1000 returns ~859 DISTINCT tickers, more than the
      // whole tracked universe — so a handful of calls now covers EVERY ticker
      // on every 30-minute run.
      //
      // Only the FETCH changes. Articles are still stored per ticker under
      // `${ticker}_${articleId}`, still carry their own vendor badge, and are
      // still deduped by URL with Polygon winning — so the feed, its search,
      // sector/cap filters and notifications behave exactly as before.
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
          // Inert-when-unconfigured is normal, not a fault — log it once at
          // debug volume so an unset feed does not look like an outage.
          for (const w of tvRes.warnings) {
            this.logger.log(`news (tradingview): ${w.code} — ${w.message}`);
          }
        } catch (err) {
          this.logger.warn(
            `Bulk news fetch (tradingview) failed: ${(err as Error).message}`,
          );
        }
      }

      // Data-loss guard: if EVERY vendor comes back empty, write nothing rather
      // than recording a "successful" run that refreshed no articles.
      if (collected.length === 0) {
        this.logger.warn(
          "news: every bulk source returned 0 articles — skipping write",
        );
        await this.meta.record(JOB_NAME, {
          ok: false,
          error: "bulk news returned no articles from any source",
        });
        return { count: 0 };
      }

      // Group by TRACKED ticker, newest first, keeping the same per-ticker cap
      // the sweep used. Untracked tickers are dropped: the feed's sector and
      // market-cap filters join each article against `companies`, so an article
      // with no company doc would vanish the moment a user picked a filter.
      const byTicker = new Map<string, CanonicalNewsArticle[]>();
      const seenUrlByTicker = new Map<string, Set<string>>();
      for (const a of collected) {
        const t = a.ticker;
        if (!t || !tracked.has(t)) continue;
        // Dedupe by URL within a ticker — Polygon is pushed first, so it wins.
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
          this.ingestArticle(a, symbol, docs, important);
        }
      }

      await chunkedBatchSet(this.firebase.firestore, "news", docs);
      // Refresh the denormalised count only for tickers that actually got news
      // this run — the whole universe every 30 min would be a needless read/write
      // per ticker for names with nothing new.
      const counted = await this.writeNewsCounts([...byTicker.keys()]);
      // Only stories matching some user's watchlist/portfolio are stored; the
      // article itself already lives in `news`, so nothing is lost by skipping
      // the rest.
      const pub = await this.notifications.publish([...important.values()]);
      await this.notifications.prune();
      this.logger.log(
        `bulk news: ${polygonCount} polygon + ${fmpCount} fmp rows -> ` +
          `${docs.length} docs across ${byTicker.size}/${list.length} tracked tickers; ` +
          `${important.size} important; ` +
          `${pub.written} notification(s) to ${pub.recipients} user(s); ` +
          `${pub.skipped} matched no subscriber; ` +
          `newsCount refreshed for ${counted} ticker(s)`,
      );
      // ── §4: AI analysis runs ONLY now, after the batch write above has
      // resolved. A throw from chunkedBatchSet skips this entirely, so news
      // that failed to persist is never analysed. A failure HERE leaves the
      // news in place and is reported separately (§12).
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
      return {
        count: docs.length,
        tickersCovered: byTicker.size,
        analysisAttempted: ai.attempted,
        analysisSucceeded: ai.succeeded,
        analysisFailed: ai.failed,
        polygonCount,
        fmpCount,
        tradingViewCount,
        // Tickers that received news this cycle. §4: the AI stage consumes
        // this AFTER persistence has been confirmed above — never before.
        affectedTickers: [...byTicker.keys()],
      };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
