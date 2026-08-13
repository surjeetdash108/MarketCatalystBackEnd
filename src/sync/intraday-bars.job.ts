import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { TICKER_UNIVERSE } from "../common/ticker-universe";
import { PolygonService } from "../vendors/polygon/polygon.service";

/**
 * Intraday aggregate bars → `intraday_bars/{ticker}_{key}`.
 *
 * The 1D / 1W / 1M chart timeframes rendered a seeded random walk (`genOHLC`)
 * because daily bars are too coarse for them. This was recorded as blocked on a
 * plan upgrade; it was not. `/v2/aggs/.../range/{n}/minute/...` is authorized on
 * the current Starter plan — probed 2026-07-21, 1553 one-minute bars returned,
 * and still resolving a year back. The timeframes were unsynced, not unavailable.
 *
 * Storage shape: ONE document per ticker per resolution holding an ARRAY of
 * bars, not a document per bar. A doc-per-bar scheme at 5-minute resolution
 * would add ~150 documents per ticker per day (≈35k/day across the universe)
 * purely to be re-read as a contiguous series, and the chart always wants the
 * whole window at once. A ~1000-bar array serialises to well under Firestore's
 * 1 MB document ceiling.
 *
 * Two resolutions cover the three timeframes:
 *   5min  — 10 calendar days  → serves 1D and 1W
 *   30min — 45 calendar days  → serves 1M
 *
 * Refreshed after the close. Intraday freshness during the session is already
 * served by the delayed SSE stream and snapshot cache for the ticker in view;
 * this job exists to give every chart a real historical shape, not a live tape.
 */

const JOB_NAME = "intraday-bars";
const BATCH_SIZE = 40;
const DELAY_MS = 120;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Resolution {
  key: string;
  multiplier: number;
  timespan: "minute";
  lookbackDays: number;
}

const RESOLUTIONS: Resolution[] = [
  { key: "5min", multiplier: 5, timespan: "minute", lookbackDays: 10 },
  { key: "30min", multiplier: 30, timespan: "minute", lookbackDays: 45 },
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return isoDate(d);
}

@Injectable()
export class IntradayBarsJob implements OnModuleInit {
  private readonly logger = new Logger(IntradayBarsJob.name);

  constructor(
    private readonly polygon: PolygonService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["intraday_bars"],
      cronExpression: "25 16 * * 1-5",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const cursor = await this.meta.getCursor(JOB_NAME);
      const batch = Array.from(
        { length: BATCH_SIZE },
        (_, i) => TICKER_UNIVERSE[(cursor + i) % TICKER_UNIVERSE.length],
      );
      const today = isoDate(new Date());

      const docs: { id: string; data: Record<string, unknown> }[] = [];
      let barsWritten = 0;
      let failed = 0;

      for (const ticker of batch) {
        for (const res of RESOLUTIONS) {
          try {
            const bars = await this.polygon.getIntradayBars(
              ticker,
              res.multiplier,
              res.timespan,
              daysAgo(res.lookbackDays),
              today,
            );
            if (bars.length === 0) continue;
            docs.push({
              id: `${ticker}_${res.key}`,
              data: {
                ticker,
                resolution: res.key,
                multiplier: res.multiplier,
                timespan: res.timespan,
                // Short keys: this array is the bulk of the document and the
                // field names repeat once per bar, so the vendor's own
                // single-letter encoding is kept rather than expanded to
                // open/high/low/close on every one of ~1000 entries.
                bars: bars.map((b) => ({
                  t: b.t,
                  o: b.o,
                  h: b.h,
                  l: b.l,
                  c: b.c,
                  v: b.v,
                  vw: b.vw ?? null,
                })),
                barCount: bars.length,
                firstBarAt: new Date(bars[0].t).toISOString(),
                lastBarAt: new Date(bars[bars.length - 1].t).toISOString(),
                source: "polygon",
                updatedAt: new Date().toISOString(),
              },
            });
            barsWritten += bars.length;
          } catch (err) {
            this.logger.error(
              `intraday ${res.key} failed for ${ticker}: ${err.message}`,
            );
            failed++;
          }
          await sleep(DELAY_MS);
        }
      }

      await chunkedBatchSet(this.firebase.firestore, "intraday_bars", docs);
      await this.meta.setCursor(
        JOB_NAME,
        (cursor + BATCH_SIZE) % TICKER_UNIVERSE.length,
      );
      await this.meta.record(JOB_NAME, { ok: true, count: docs.length });
      return { docsWritten: docs.length, barsWritten, failed };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: err.message });
      throw err;
    }
  }
}
