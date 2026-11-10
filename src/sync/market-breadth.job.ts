import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { TICKER_UNIVERSE, activeUniverse } from "../common/ticker-universe";

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

const JOB_NAME = "market-breadth";
const WINDOW_DAYS = 260;
/** 52-week lookback (sessions) for new highs / new lows. */
const HIGH_LOW_SESSIONS = 252;
/** Bars read per ticker: enough for the deltas over the window, plus a full
 *  52-week lookback for the most recent ~40 sessions' new highs / lows. */
const BARS_PER_TICKER = 292;

interface DayAgg {
  adv: number;
  dec: number;
  unch: number;
  upVol: number;
  downVol: number;
  /** Stocks closing at a 52-week high / low (only where a full year of bars exists). */
  newHighs: number;
  newLows: number;
  /** Stocks with a full 52-week lookback that day. */
  highLowCovered: number;
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
      collections: ["market_breadth"],
      cronExpression: "30 18 * * 1-5",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const byDate = new Map<string, DayAgg>();
      // Counted, not estimated: this job reads BARS_PER_TICKER documents for
      // every ticker in the universe, five times a trading day, and was the
      // largest single read line we could attribute.
      let docsRead = 0;

      // Read active universe dynamically from SecurityMaster / companies
      const live = await activeUniverse(this.firebase.firestore);
      const universe = live.length > 0 ? live : TICKER_UNIVERSE;

      for (const ticker of universe) {
        const snap = await this.firebase.firestore
          .collection("ohlcv_bars")
          .where("ticker", "==", ticker)
          .orderBy("barDate", "desc")
          .limit(BARS_PER_TICKER)
          .get();
        docsRead += snap.size;
        if (snap.size < 2) continue;
        // asc so [i] vs [i-1] is today vs yesterday.
        const bars = snap.docs.map((d) => d.data()).reverse();
        for (let i = 1; i < bars.length; i++) {
          const date = bars[i].barDate as string;
          if (!date || date < cutoff) continue;
          const delta = (bars[i].close ?? 0) - (bars[i - 1].close ?? 0);
          const vol = bars[i].volume ?? 0;
          const agg = byDate.get(date) ?? {
            adv: 0,
            dec: 0,
            unch: 0,
            upVol: 0,
            downVol: 0,
            newHighs: 0,
            newLows: 0,
            highLowCovered: 0,
          };
          // 52-week high / low on a close basis over the prior 251 sessions.
          if (i >= HIGH_LOW_SESSIONS - 1) {
            let hi = -Infinity;
            let lo = Infinity;
            for (let j = i - (HIGH_LOW_SESSIONS - 1); j < i; j++) {
              const c = bars[j].close as number | undefined;
              if (typeof c === "number") {
                if (c > hi) hi = c;
                if (c < lo) lo = c;
              }
            }
            const c = bars[i].close as number | undefined;
            if (typeof c === "number" && Number.isFinite(hi)) {
              agg.highLowCovered++;
              if (c >= hi) agg.newHighs++;
              else if (c <= lo) agg.newLows++;
            }
          }
          if (delta > 0) {
            agg.adv++;
            agg.upVol += vol;
          } else if (delta < 0) {
            agg.dec++;
            agg.downVol += vol;
          } else agg.unch++;
          byDate.set(date, agg);
        }
      }

      // McClellan Oscillator = EMA(19) − EMA(39) of daily net advances. Computed
      // over the ordered day series (unadjusted, fixed universe). Stabilises after
      // ~39 sessions; the backfill window (260d) leaves recent values reliable.
      const orderedDates = [...byDate.keys()].sort();
      const k19 = 2 / (19 + 1);
      const k39 = 2 / (39 + 1);
      let ema19: number | null = null;
      let ema39: number | null = null;
      const mcclellanByDate = new Map<string, number>();
      for (const date of orderedDates) {
        const a = byDate.get(date);
        const net = a.adv - a.dec;
        ema19 = ema19 == null ? net : ema19 + k19 * (net - ema19);
        ema39 = ema39 == null ? net : ema39 + k39 * (net - ema39);
        mcclellanByDate.set(date, ema19 - ema39);
      }

      const now = new Date().toISOString();
      const docs = [...byDate.entries()].map(([date, a]) => {
        const total = a.adv + a.dec;
        const breadthPct = total > 0 ? a.adv / total : 0.5;
        // ARMS/TRIN-style: (adv/dec) / (upVol/downVol). ~1 neutral, <1 bullish.
        const trin =
          a.dec > 0 && a.downVol > 0 && a.upVol > 0
            ? a.adv / a.dec / (a.upVol / a.downVol)
            : null;
        const mcclellan = mcclellanByDate.get(date);
        return {
          id: date,
          data: {
            date,
            advancers: a.adv,
            decliners: a.dec,
            unchanged: a.unch,
            // How much of the universe actually had a bar for this session.
            // Daily bars arrive late and incompletely, so a day's breadth is
            // provisional until most of the universe has reported — consumers
            // must be able to tell a settled day from one still filling in
            // rather than publishing 4-vs-14 as though it were final.
            covered: a.adv + a.dec + a.unch,
            universe: universe.length,
            netAdvancers: a.adv - a.dec,
            upVolume: a.upVol,
            downVolume: a.downVol,
            breadthPct: Math.round(breadthPct * 1000) / 1000,
            // Stock price strength (Fear & Greed): null where too few stocks had
            // a full year of bars to call a 52-week high or low.
            ...(a.highLowCovered >= 50
              ? {
                  newHighs: a.newHighs,
                  newLows: a.newLows,
                  highLowCovered: a.highLowCovered,
                }
              : {}),
            // 0–100 sentiment proxy from breadth — feeds the F&G history line.
            breadthSentiment: Math.round(breadthPct * 100),
            trin: trin == null ? null : Math.round(trin * 100) / 100,
            mcclellan:
              mcclellan == null ? null : Math.round(mcclellan * 100) / 100,
            updatedAt: now,
          },
        };
      });

      await chunkedBatchSet(this.firebase.firestore, "market_breadth", docs);
      await this.meta.record(JOB_NAME, {
        ok: true,
        count: docs.length,
        docsRead,
      });
      this.logger.log(
        `market_breadth: wrote ${docs.length} trading day(s) from ${docsRead} bar reads`,
      );
      return { days: docs.length, docsRead };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: err.message });
      throw err;
    }
  }
}
