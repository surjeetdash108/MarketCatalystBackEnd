import { Inject, Injectable, Logger, Optional, OnModuleInit } from "@nestjs/common";
import { AllSourcesFailedError } from "../adapters/adapter-error";
import {
  NEWS_ADAPTER,
  NEWS_FMP_ADAPTER,
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
import {
  NotificationsService,
  type NotificationInput,
} from "../common/notifications.service";
import { SyncMetaService } from "../common/sync-meta.service";
import { TICKER_UNIVERSE } from "../common/ticker-universe";
import { SyncRegistry } from "../common/sync-registry.service";
import { isoDate } from "../common/date.util";

const JOB_NAME = "news";
const BATCH_SIZE = 80;
const LOOKBACK_DAYS = 2;
const DELAY_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


@Injectable()
export class NewsJob implements OnModuleInit {
  private readonly logger = new Logger(NewsJob.name);

  constructor(
    @Inject(NEWS_ADAPTER) private readonly news: NewsAdapter,
    @Optional() @Inject(NEWS_FMP_ADAPTER) private readonly newsFmp: NewsAdapter | null,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly notifications: NotificationsService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["news"],
      cronExpression: "*/30 9-16 * * 1-5",
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
   * cheaper than every browser pulling the whole collection.
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
   * `${symbol}_${id}`. Shared by the per-ticker sweep and the market-wide head
   * fetch so both paths write identical docs and de-duplicate on the same id.
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
        category: a.category,
        sentiment: a.sentiment,
        sentimentReasoning: a.sentimentReasoning,
        keywords: a.keywords,
        imageUrl: a.imageUrl,
        publishedAt: a.publishedAt,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  async run() {
    try {
      const cursor = await this.meta.getCursor(JOB_NAME);
      const batch = Array.from(
        { length: BATCH_SIZE },
        (_, i) => TICKER_UNIVERSE[(cursor + i) % TICKER_UNIVERSE.length],
      );
      const to = new Date();
      const from = new Date();
      from.setUTCDate(from.getUTCDate() - LOOKBACK_DAYS);
      const docs: Array<{ id: string; data: Record<string, unknown> }> = [];
      let fallbackCount = 0;
      // Keyed by article id so a multi-ticker story collapses to one entry.
      const important = new Map<string, NotificationInput>();
      for (const symbol of batch) {
        try {
          const result = await this.news.fetchNews(
            symbol,
            isoDate(from),
            isoDate(to),
          );
          if (result.warnings.some((w) => w.code === "FALLBACK_USED")) {
            fallbackCount++;
          }
          // Merge FMP news (when NEWS_FMP_SOURCE=fmp) alongside Polygon's,
          // deduped by URL — Polygon wins a collision. Each article keeps its own
          // `vendor` so the UI can badge Polygon vs FMP.
          const articles = [...result.data];
          if (this.newsFmp) {
            try {
              const fmpRes = await this.newsFmp.fetchNews(
                symbol,
                isoDate(from),
                isoDate(to),
              );
              const seenUrls = new Set(articles.map((a) => a.url));
              for (const a of fmpRes.data) {
                if (a.url && !seenUrls.has(a.url)) {
                  seenUrls.add(a.url);
                  articles.push(a);
                }
              }
            } catch (e) {
              this.logger.warn(
                `FMP news failed for ${symbol}: ${(e as Error).message}`,
              );
            }
          }
          articles.sort((a, b) =>
            (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
          );
          for (const a of articles.slice(0, 8)) {
            this.ingestArticle(a, symbol, docs, important);
          }
        } catch (err) {
          if (err instanceof AllSourcesFailedError) {
            this.logger.error(
              `${symbol}: every configured news source failed — ${err.attempts.map((a) => `${a.source}: ${a.error}`).join(" | ")}`,
            );
          } else {
            this.logger.error(
              `Failed fetching news for ${symbol}: ${err.message}`,
            );
          }
        }
        await sleep(DELAY_MS);
      }

      // MARKET-WIDE head fetch (once per run): the per-ticker cursor refreshes
      // only BATCH_SIZE of ~241 tickers each run, so the freshest market story
      // can lag hours until its ticker's batch comes around — leaving the "Live"
      // feed (and the Dashboard, which reads the same `news` collection) frozen.
      // One extra Polygon call for the newest market-wide articles keeps the feed
      // head current regardless of the cursor. Each is scoped to its primary
      // ticker and flows through the SAME ingest path, so a doc id collides
      // idempotently with any per-ticker write of the same story (no duplicates).
      // Best-effort — a failure just leaves the feed on the per-ticker sweep.
      let marketCount = 0;
      if (typeof this.news.fetchMarketNews === "function") {
        try {
          const market = await this.news.fetchMarketNews(
            isoDate(from),
            isoDate(to),
          );
          for (const a of market.data) {
            this.ingestArticle(a, a.ticker, docs, important);
          }
          marketCount = market.data.length;
        } catch (err) {
          this.logger.warn(
            `Market-wide news fetch failed: ${(err as Error).message}`,
          );
        }
      }

      await chunkedBatchSet(this.firebase.firestore, "news", docs);
      const counted = await this.writeNewsCounts(batch);
      // Only stories matching some user's watchlist/portfolio are stored; the
      // article itself already lives in `news`, so nothing is lost by skipping
      // the rest.
      const pub = await this.notifications.publish([...important.values()]);
      await this.notifications.prune();
      this.logger.log(
        `${important.size}/${docs.length} articles important ` +
          `(${marketCount} market-wide head); ` +
          `${pub.written} notification(s) to ${pub.recipients} user(s); ` +
          `${pub.skipped} matched no subscriber; ` +
          `newsCount refreshed for ${counted} ticker(s)`,
      );
      await this.meta.setCursor(
        JOB_NAME,
        (cursor + BATCH_SIZE) % TICKER_UNIVERSE.length,
      );
      await this.meta.record(JOB_NAME, {
        ok: true,
        count: docs.length,
        ...(fallbackCount > 0
          ? {
              error: `${fallbackCount}/${batch.length} tickers served by fallback news source`,
            }
          : {}),
      });
      return { count: docs.length, fallbackCount };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
