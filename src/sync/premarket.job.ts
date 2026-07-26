import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { SyncMetaService } from '../common/sync-meta.service';
import { SyncRegistry } from '../common/sync-registry.service';
import { OnDemandService } from '../live/ondemand.service';
import { tapeUniverse } from '../live/tape-universe';

const JOB_NAME = 'premarket';

/**
 * THE single scheduled entry point (2026-07-24 redesign): every periodic sync
 * runs once per weekday, in ONE premarket window, in dependency order — no
 * more 22 scattered Cloud Scheduler jobs.
 *
 *   Phase 1 · WARM — resolve the "high-frequency" set (tape universe + every
 *     user's watchlist & portfolio tickers + the `ticker_usage` hot list) and
 *     pre-fill the on-demand cache: company profile + 1Y daily + 1D intraday
 *     bars per ticker. This is what makes the first user of the day fast, and
 *     it also seeds `companies` — the dynamic universe the per-ticker jobs
 *     below iterate. Usage-driven and grown gradually: an unused app warms
 *     only the 21-symbol tape universe.
 *
 *   Phase 2 · MARKET-WIDE — small, market-level collections every screen
 *     shares (indices, sectors, movers, breadth, F&G, calendars, news,
 *     insider). One vendor call each, independent of ticker count.
 *
 *   Phase 3 · PER-TICKER — compute pipelines over the ACTIVE universe only
 *     (`companies` ids): bars substrate → indicators → ratings → financials.
 *
 *   Phase 4 · RECAP — composes indices/movers/sectors/breadth, so it must run
 *     last. At 08:00 ET it freezes the PRIOR session, which is exactly what an
 *     EOD recap of a 15-min-delayed data plan can honestly show.
 *
 * Frequencies audit (why once-a-day premarket is enough): the vendor plan is
 * 15-min-delayed EOD-quality data; intraday freshness comes from the live
 * layer (/live/tape SSE + /live/snapshot + on-demand bars TTL), not from
 * re-running batch syncs. Anything fresher than daily here would spend money
 * to move data that has not changed.
 */

/** Phase 2 — order matters only where noted. */
const MARKET_WIDE: string[] = [
  'market-indices',
  'sectors',
  'market-movers',
  'market-breadth',
  'fear-greed',        // reads market-breadth output
  'macro-events',
  'earnings',
  'ipos',
  'news',
  'analyst-actions',
  'sec-form4',
  'sec-13f',
  'dividends',
  'options-chains',    // its own small OPTIONS_UNIVERSE
];

/** Phase 3 — over the dynamic `companies` universe. */
const PER_TICKER: string[] = [
  'companies',             // refresh profiles of the active set
  'stock-history',         // ohlcv_bars substrate the compute jobs read
  'technical-indicators',
  'rs-rating',
  'tech-rating',
  'financials',
  'fundamentals-growth',
  'corporate-actions',
];

const FINAL: string[] = ['recaps'];

/** Warm concurrency — enough to finish a few hundred tickers premarket. */
const WARM_CONCURRENCY = 4;
const HOT_LIST_LIMIT = 100;

@Injectable()
export class PremarketJob implements OnModuleInit {
  private readonly logger = new Logger(PremarketJob.name);

  constructor(
    private readonly registry: SyncRegistry,
    private readonly meta: SyncMetaService,
    private readonly firebase: FirebaseAdminService,
    private readonly ondemand: OnDemandService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['companies', 'stock_bars', 'ticker_usage', '(orchestrates all sync jobs)'],
      cronExpression: '0 8 * * 1-5',
      timeZone: 'America/New_York',
    });
  }

  /** Tape + every user's watchlist/portfolio + usage hot list, deduped. */
  private async resolveHotSet(): Promise<string[]> {
    const hot = new Set<string>();
    for (const s of tapeUniverse()) {
      hot.add(s.proxyTicker ?? s.id);
    }
    const db = this.firebase.firestore;
    try {
      const watchlists = await db.collectionGroup('watchlists').get();
      for (const d of watchlists.docs) {
        const tickers = (d.data().tickers ?? []) as string[];
        for (const t of tickers) if (typeof t === 'string' && t) hot.add(t.toUpperCase());
      }
    } catch (err) {
      this.logger.warn(`watchlists collectionGroup read failed: ${(err as Error).message}`);
    }
    try {
      const holdings = await db.collectionGroup('holdings').get();
      for (const d of holdings.docs) hot.add(d.id.toUpperCase());
    } catch (err) {
      this.logger.warn(`holdings collectionGroup read failed: ${(err as Error).message}`);
    }
    for (const t of await this.ondemand.hotTickers(HOT_LIST_LIMIT)) hot.add(t.toUpperCase());
    return [...hot].filter((t) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)).sort();
  }

  private async warm(tickers: string[]): Promise<{ warmed: number; failed: number }> {
    let warmed = 0;
    let failed = 0;
    const queue = [...tickers];
    const worker = async () => {
      for (;;) {
        const t = queue.shift();
        if (!t) return;
        try {
          await this.ondemand.getCompany(t);
          await this.ondemand.getBars(t, '1Y');
          await this.ondemand.getBars(t, '1D');
          warmed++;
        } catch (err) {
          failed++;
          this.logger.warn(`warm failed for ${t}: ${(err as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: WARM_CONCURRENCY }, worker));
    return { warmed, failed };
  }

  private async runPhase(names: string[]): Promise<Array<{ job: string; ok: boolean; error?: string }>> {
    const results: Array<{ job: string; ok: boolean; error?: string }> = [];
    for (const name of names) {
      const runner = this.registry.get(name);
      if (!runner) {
        results.push({ job: name, ok: false, error: 'not registered' });
        continue;
      }
      try {
        await runner();
        results.push({ job: name, ok: true });
      } catch (err) {
        // One failing source must not sink the whole morning refresh.
        results.push({ job: name, ok: false, error: (err as Error).message });
        this.logger.error(`premarket: job "${name}" failed: ${(err as Error).message}`);
      }
    }
    return results;
  }

  async run() {
    const startedAt = Date.now();
    try {
      const hotSet = await this.resolveHotSet();
      this.logger.log(`premarket: warming ${hotSet.length} hot tickers`);
      const warm = await this.warm(hotSet);

      const phase2 = await this.runPhase(MARKET_WIDE);
      const phase3 = await this.runPhase(PER_TICKER);
      const phase4 = await this.runPhase(FINAL);

      const all = [...phase2, ...phase3, ...phase4];
      const failed = all.filter((r) => !r.ok);
      await this.meta.record(JOB_NAME, {
        ok: failed.length === 0,
        count: all.length - failed.length,
        error: failed.length ? failed.map((f) => `${f.job}: ${f.error}`).join('; ').slice(0, 900) : undefined,
      });
      return {
        hotTickers: hotSet.length,
        ...warm,
        jobs: all,
        succeeded: all.length - failed.length,
        failed: failed.length,
        tookMs: Date.now() - startedAt,
      };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, count: 0, error: (err as Error).message });
      throw err;
    }
  }
}
