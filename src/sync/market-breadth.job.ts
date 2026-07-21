import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { chunkedBatchSet } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { SyncRegistry } from '../common/sync-registry.service';
import { TICKER_UNIVERSE } from '../common/ticker-universe';

/**
 * Daily market breadth → `market_breadth/{date}` (delivery-plan R11 Market
 * Internals + R26 Fear-&-Greed history).
 *
 * Computed from `ohlcv_bars` — the only collection with real multi-month
 * history — so the FIRST run backfills every trading day already synced (~300),
 * not just today. Advancers/decliners and up/down volume are counted across the
 * ticker universe by comparing each day's close to the prior day's.
 *
 * Both features this feeds were previously hardcoded: Dashboard "Market
 * Internals" (2,186 advancing …) and the Fear-&-Greed history sparkline.
 */

const JOB_NAME = 'market-breadth';
const WINDOW_DAYS = 260;
const BARS_PER_TICKER = 270; // a little over the window so deltas are complete

interface DayAgg {
  adv: number;
  dec: number;
  unch: number;
  upVol: number;
  downVol: number;
}

@Injectable()
export class MarketBreadthJob implements OnModuleInit {
  private readonly logger = new Logger(MarketBreadthJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['market_breadth'],
      cronExpression: '30 18 * * 1-5',
      timeZone: 'America/New_York',
    });
  }

  @Cron('30 18 * * 1-5', { timeZone: 'America/New_York' })
  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const byDate = new Map<string, DayAgg>();

      // Per-ticker read (bounded memory) — same pattern as technical-indicators.
      // Reading the whole collection at once would be tens of thousands of docs
      // held in memory simultaneously.
      for (const ticker of TICKER_UNIVERSE) {
        const snap = await this.firebase.firestore
          .collection('ohlcv_bars')
          .where('ticker', '==', ticker)
          .orderBy('barDate', 'desc')
          .limit(BARS_PER_TICKER)
          .get();
        if (snap.size < 2) continue;
        // asc so [i] vs [i-1] is today vs yesterday.
        const bars = snap.docs.map((d) => d.data()).reverse();
        for (let i = 1; i < bars.length; i++) {
          const date = bars[i].barDate as string;
          if (!date || date < cutoff) continue;
          const delta = (bars[i].close ?? 0) - (bars[i - 1].close ?? 0);
          const vol = bars[i].volume ?? 0;
          const agg = byDate.get(date) ?? { adv: 0, dec: 0, unch: 0, upVol: 0, downVol: 0 };
          if (delta > 0) { agg.adv++; agg.upVol += vol; }
          else if (delta < 0) { agg.dec++; agg.downVol += vol; }
          else agg.unch++;
          byDate.set(date, agg);
        }
      }

      const now = new Date().toISOString();
      const docs = [...byDate.entries()].map(([date, a]) => {
        const total = a.adv + a.dec;
        const breadthPct = total > 0 ? a.adv / total : 0.5;
        const volTotal = a.upVol + a.downVol;
        // ARMS/TRIN-style: (adv/dec) / (upVol/downVol). ~1 neutral, <1 bullish.
        const trin =
          a.dec > 0 && a.downVol > 0 && a.upVol > 0
            ? (a.adv / a.dec) / (a.upVol / a.downVol)
            : null;
        return {
          id: date,
          data: {
            date,
            advancers: a.adv,
            decliners: a.dec,
            unchanged: a.unch,
            netAdvancers: a.adv - a.dec,
            upVolume: a.upVol,
            downVolume: a.downVol,
            breadthPct: Math.round(breadthPct * 1000) / 1000,
            // 0–100 sentiment proxy from breadth — feeds the F&G history line.
            breadthSentiment: Math.round(breadthPct * 100),
            trin: trin == null ? null : Math.round(trin * 100) / 100,
            updatedAt: now,
          },
        };
      });

      await chunkedBatchSet(this.firebase.firestore, 'market_breadth', docs);
      await this.meta.record(JOB_NAME, { ok: true, count: docs.length });
      this.logger.log(`market_breadth: wrote ${docs.length} trading day(s)`);
      return { days: docs.length };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: err.message });
      throw err;
    }
  }
}
