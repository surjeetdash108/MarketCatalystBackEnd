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

/**
 * The news refresh, as a plain service (it was the body of `NewsJob.run()`).
 *
 * WHY IT MOVED: the refresh used to exist only inside the cron job, in
 * SyncModule, which the public `live` service does not load. So a user request
 * on `live` could not refresh anything. This service lives in LiveModule, which
 * both services load, and is called two ways:
 *   - `ensureFresh()`  <- user requests (via cache_status: one refresh at a time)
 *   - `refresh()`      <- NewsJob, still, until the cron is retired
 *
 * WHAT IT WRITES
 *   `news`           every article for a tracked ticker (newest 8 each) — what it
 *                    always wrote; per-ticker readers and batch jobs rely on it.
 *   `news_breaking`  the subset that is market-moving: the importance rules say
 *                    "important" AND it is not syndicated filler.
 *   `companies/{T}.newsCount`, user notifications  — unchanged.
 *
 * AFTER WRITING, for every ticker in a breaking story whose saved news is older
 * than the story, it fetches that ticker's news straight away (see
 * refreshDetailNews), so a ticker page is current by the time anyone opens it.
 * The ticker's daily expiry stays at the next New York midnight. The 15 minute market refresh and the per-ticker caches stay
 * separate; this is the one place the first feeds the second.
 */

const JOB_NAME = "news";

// Newest articles kept per ticker — unchanged from the per-ticker sweep, so the
// stored shape and volume stay the same now that the FETCH is bulk.
const ARTICLES_PER_TICKER = 8;
const LOOKBACK_DAYS = 2;
/**
 * Tickers analysed per refresh by the BACKGROUND sweep.
 *
 * DEFAULT 0 — the sweep is off, and analysis is generated ON DEMAND when a
 * user first opens a ticker (see TickerAiAnalysisService.getOrGenerate).
 *
 * The sweep attempted 8 tickers x 144 cycles = 1,152 model calls a day. On
 * OpenRouter's free tier (50/day) it exhausted the entire allowance within
 * the first few cycles, after which every analysis — including the ones users
 * were actually waiting on — failed with a 429. Generating on demand spends
 * the budget only on tickers somebody is looking at.
 *
 * Set TICKER_AI_PER_CYCLE > 0 to re-enable pre-warming once quota allows.
 */
const MAX_TICKERS_PER_CYCLE = Number(process.env.TICKER_AI_PER_CYCLE ?? 0);

/** Breaking-story tickers considered for a proactive refresh per run (newest first). */
const PROACTIVE_CANDIDATES = 40;
/** Most tickers refreshed proactively per run: bounds provider calls and run time. */
const PROACTIVE_MAX = 10;
/** How many of those run at once. */
const PROACTIVE_CONCURRENCY = 3;

type NewsDoc = { id: string; data: Record<string, unknown> };

/** A stored field as a string, or "" when it is not one. */
const text = (v: unknown): string => (typeof v === "string" ? v : "");

export interface NewsRefreshResult {
  count: number;
  /** True when every source came back empty and nothing was written. */
  skipped?: boolean;
  tickersCovered?: number;
  breakingCount?: number;
  analysisAttempted?: number;
  analysisSucceeded?: number;
  analysisFailed?: number;
  polygonCount?: number;
  fmpCount?: number;
  tradingViewCount?: number;
  /** Tickers that received news this cycle. */
  affectedTickers?: string[];
  /** Newest `publishedAt` among the articles written. The refresh's watermark. */
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

  /**
   * Call before serving news. If the stored copy is older than 15 minutes, one
   * request refreshes it in the background (see CacheStatusService); everyone
   * else, and that request, serve what is stored. Never throws.
   *
   * Pass `wait = true` from a scheduled job: if this call wins the refresh it
   * runs it to completion before returning, so the job reads fresh news and the
   * process cannot end mid-refresh.
   */
  ensureFresh(wait = false): Promise<EnsureOutcome> {
    return this.cacheStatus.ensureFresh({
      awaitRefresh: wait,
      key: NEWS_BREAKING_KEY,
      location: "news",
      ttlMs: NEWS_BREAKING_TTL_MS,
      // The cron has been filling `news`, so a missing status doc does not mean
      // an empty feed: do not make the first request wait.
      hasData: async () => {
        const snap = await this.firebase.firestore
          .collection("news")
          .limit(1)
          .get();
        return !snap.empty;
      },
      refresh: async () => {
        const res = await this.refresh();
        // "Every source empty" is an outage, not a result: record it as failed
        // so it is retried after the backoff instead of being trusted 15 min.
        if (res.skipped) {
          throw new Error("every bulk news source returned 0 articles");
        }
        return { watermark: res.newestPublishedAt ?? undefined };
      },
    });
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
   *
   * A story that is important AND not filler is also queued for `news_breaking`
   * under the same doc id.
   */
  private ingestArticle(
    a: CanonicalNewsArticle,
    symbol: string,
    docs: NewsDoc[],
    important: Map<string, NotificationInput>,
    breaking: NewsDoc[],
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
    // Syndicated 13F/listicle noise. Flagged, not dropped: the UI hides it
    // by default but the row stays auditable if a rule turns out wrong.
    const filler = isFillerNews(a.headline, a.summary, a.source);
    const id = `${symbol}_${a.id}`;
    const data: Record<string, unknown> = {
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
          // Why it qualified — kept so a human can audit the rule.
          direction: verdict.direction,
          importanceReasons: verdict.reasons,
        },
      });
    }
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
        // Among NEVER-analysed tickers, do NOT rank by article count. AXTI had
        // fresh non-filler news and still lost every cycle to names carrying 12
        // articles — and there is always such a name, so a thin-coverage ticker
        // never reached the front. Alphabetical is arbitrary but it DRAINS:
        // each ticker analysed leaves the group, so the queue empties in a
        // predictable order instead of sorting the same heavy names to the top
        // forever.
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
            // Derived at ingest; recomputed here rather than threaded through
            // so the prompt sees the same bucket the feed shows.
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

  /**
   * Keep ticker pages current when breaking news names them.
   *
   * For each ticker in a breaking story: if the story is NEWER than that
   * ticker's last detail-news fetch, fetch its news now and store it. Its daily
   * expiry stays at the next New York midnight. The next person to open the
   * ticker then finds current articles, without waiting for the daily cache to
   * run out and without being the one who triggers the fetch.
   *
   * Only tickers somebody has already opened (they have a cache_status record)
   * are touched; the rest fetch on their first view. At most PROACTIVE_MAX per
   * run, newest story first, so provider calls and run time stay bounded. Any
   * left over stay marked out of date and refresh on their next view.
   *
   * Goes through cache_status, so it never double-fetches a ticker someone is
   * already refreshing. Never throws: the news is already stored by now.
   */
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
      // Out of date = a cache_status record whose last fetch predates the story.
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
      const docs: NewsDoc[] = [];
      const breaking: NewsDoc[] = [];
      // Keyed by article id so a multi-ticker story collapses to one entry.
      const important = new Map<string, NotificationInput>();

      // ── BULK fetch ────────────────────────────────────────────────────────
      // Was a per-ticker sweep: BATCH_SIZE tickers per run, one vendor call
      // each, so a given ticker was only revisited every ~90 minutes and a story
      // could sit unseen that long. Both vendors expose market-wide feeds — one
      // Polygon call at limit=1000 returns ~859 DISTINCT tickers, more than the
      // whole tracked universe — so a handful of calls now covers EVERY ticker
      // on every run.
      //
      // Only the FETCH changes. Articles are still stored per ticker under
      // `${ticker}_${articleId}`, still carry their own vendor badge, and are
      // still deduped by URL with FMP winning — so the feed, its search,
      // sector/cap filters and notifications behave exactly as before.
      //
      // The window is NOT narrowed by the previous watermark: Polygon only takes
      // whole days and FMP's "latest" feed takes no date at all, so narrowing
      // would save nothing at the provider, and re-scoring the window is what
      // lets a user who just added a ticker to a watchlist still get its recent
      // stories.
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
        return { count: 0, skipped: true };
      }

      // Group by TRACKED ticker, newest first, keeping the same per-ticker cap
      // the sweep used. Untracked tickers are dropped: the feed's sector and
      // market-cap filters join each article against `companies`, so an article
      // with no company doc would vanish the moment a user picked a filter.
      const byTicker = new Map<string, CanonicalNewsArticle[]>();
      const seenUrlByTicker = new Map<string, Set<string>>();
      // FMP is the primary vendor: its copy of an article both vendors carry
      // wins the URL dedupe below; Polygon/TradingView fill in the rest.
      const fmpFirst = [
        ...collected.filter((a) => a.vendor === "fmp"),
        ...collected.filter((a) => a.vendor !== "fmp"),
      ];
      for (const a of fmpFirst) {
        const t = a.ticker;
        if (!t || !tracked.has(t)) continue;
        // Dedupe by URL within a ticker — FMP is ordered first, so it wins.
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
      // Refresh the denormalised count only for tickers that actually got news
      // this run — the whole universe every run would be a needless read/write
      // per ticker for names with nothing new.
      const counted = await this.writeNewsCounts([...byTicker.keys()]);
      // Only stories matching some user's watchlist/portfolio are stored; the
      // article itself already lives in `news`, so nothing is lost by skipping
      // the rest.
      const pub = await this.notifications.publish([...important.values()]);
      await this.notifications.prune();
      // Breaking stories make their tickers' detail news out of date: refresh it now.
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
        // Tickers that received news this cycle. §4: the AI stage consumes
        // this AFTER persistence has been confirmed above — never before.
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
