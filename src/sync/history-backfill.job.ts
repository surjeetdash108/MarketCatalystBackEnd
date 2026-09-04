import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  batchSetWithCreatedAt,
  type PendingWrite,
} from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { addDays, isoDate } from "../common/date.util";
import { PolygonService } from "../vendors/polygon/polygon.service";

const JOB_NAME = "history-backfill";
/** Job whose watermarks this fills, so it does not re-fetch what we just wrote. */
const STOCK_HISTORY_JOB = "stock-history";

/**
 * Daily bars for EVERY listed US symbol, by session rather than by ticker.
 *
 * WHY THIS EXISTS
 * stock-history fetches one ticker at a time, so covering the ~12,600 listed
 * symbols meant ~12,600 requests — over five hours of pure fetching against a
 * plan that already returns 429s, before any back-off. That is why the tracked
 * universe stayed at ~900 names, 6.9% of the market.
 *
 * Polygon's grouped-daily returns EVERY symbol's bar for one session in a
 * single request. Turning the loop inside out — iterate sessions, not tickers —
 * makes a full year of history 300 requests instead of 12,600. Same data, 42x
 * fewer calls, no rate limiting, minutes instead of hours.
 *
 * ONE-OFF. Once the history is down, stock-history's daily increment keeps it
 * current; this exists to close the initial gap. It is safe to re-run — bar
 * documents are keyed `${ticker}_${barDate}` and overwritten, never appended.
 *
 * MUST NOT RUN DURING MARKET HOURS. Grouped-daily for the current session
 * returns a PARTIAL bar, which would be stored as if it were a close and then
 * poison every window indicator built on it. The job refuses today's date for
 * that reason.
 */

/** Sessions of history to pull. ~300 trading days is about 14 months. */
const DEFAULT_SESSIONS = 300;
/** Calendar days to walk back to find that many sessions (weekends/holidays). */
const CALENDAR_SPAN = 440;
/** Bars per Firestore batch commit. */
const WRITE_CHUNK = 450;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

@Injectable()
export class HistoryBackfillJob implements OnModuleInit {
  private readonly logger = new Logger(HistoryBackfillJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly polygon: PolygonService,
  ) {}

  onModuleInit() {
    // NOTHING SCHEDULES THIS. The cron fields satisfy the registry's shape;
    // no Cloud Scheduler entry points at it. It is a one-off, launched as a
    // Cloud Run JOB with SYNC_JOB=history-backfill — not over HTTP, because a
    // 30-45 minute run is killed at Cloud Run's 900s request timeout and the
    // worker scales to zero underneath a detached request.
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["ohlcv_bars", "sync_watermarks"],
      cronExpression: "0 0 30 2 *", // never fires: 30 February
      timeZone: "America/New_York",
    });
  }

  async run() {
    try {
      const today = isoDate(new Date());
      const dates: string[] = [];
      for (let i = 1; i <= CALENDAR_SPAN && dates.length < DEFAULT_SESSIONS; i++) {
        const d = isoDate(addDays(new Date(), -i));
        // Never today: an in-progress session's grouped bar is partial.
        if (d >= today) continue;
        const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
        if (dow === 0 || dow === 6) continue; // weekends carry no session
        dates.push(d);
      }
      // NEWEST FIRST. The first attempt wrote oldest-first so an interruption
      // would leave a contiguous prefix — right about contiguity, wrong about
      // which end matters. It timed out at 109 of 300 sessions and left tickers
      // holding Sep-Nov 2025 with no recent edge, which every trailing-window
      // indicator and every staleness check reads first. WBS ended up with 600
      // stored bars and still fell through to a vendor fetch for being 14 days
      // stale. Truncating now costs the OLD end, which those windows tolerate.

      const db = this.firebase.firestore;
      const col = db.collection("ohlcv_bars");
      let sessions = 0;
      let barsWritten = 0;
      let rejected = 0;
      let skipped = 0;
      // Set HISTORY_BACKFILL_FORCE=true to rewrite sessions already stored.
      const force = process.env.HISTORY_BACKFILL_FORCE === "true";
      /** Newest session seen per ticker, to set stock-history's watermark. */
      const newestByTicker = new Map<string, string>();

      for (const date of dates) {
        // RESUMABLE. A session already written is skipped, so a re-run after a
        // timeout continues rather than re-paying for finished work. SPY trades
        // every session, so its bar is a reliable probe for "this session is
        // done", and a doc-id lookup needs no index.
        if (!force) {
          const probe = await db
            .collection("ohlcv_bars")
            .doc(`SPY_${date}`)
            .get()
            .catch(() => null);
          if (probe?.exists && probe.data()?.source === "polygon-grouped") {
            skipped++;
            continue;
          }
        }
        const bars = await this.polygon.getGroupedDaily(date).catch((err) => {
          this.logger.warn(`grouped-daily ${date} failed: ${err.message}`);
          return [];
        });
        if (bars.length === 0) continue; // holiday
        sessions++;

        const writes: PendingWrite[] = [];
        for (const b of bars) {
          const ticker = b.T;
          const open = num(b.o);
          const high = num(b.h);
          const low = num(b.l);
          const close = num(b.c);
          const volume = num(b.v);
          // Same contract as the isSaneBar guard on the incremental path: a bar
          // that cannot be true is dropped rather than stored and inherited by
          // every indicator built over it.
          if (
            !ticker ||
            open == null ||
            high == null ||
            low == null ||
            close == null ||
            open < 0 ||
            low < 0 ||
            high < low ||
            open > high ||
            close > high ||
            open < low ||
            close < low
          ) {
            rejected++;
            continue;
          }
          writes.push({
            ref: col.doc(`${ticker}_${date}`),
            data: {
              ticker,
              barDate: date,
              timespan: "day",
              open,
              high,
              low,
              close,
              // Adjusted aggregates carry fractional share counts (BUG-011).
              volume: volume == null ? null : Math.round(volume),
              vwap: num(b.vw),
              source: "polygon-grouped",
            },
            // Overwrite, never merge: a split rewrites history on the adjusted
            // basis, and blending two bases is worse than either one.
            merge: false,
          });
          // Sessions run NEWEST-first, so the first time a ticker appears is
          // its newest session. Overwriting on each later (older) session would
          // walk every watermark backwards and make stock-history re-fetch a
          // deep window per ticker — the exact cost this job exists to avoid.
          if (!newestByTicker.has(ticker)) newestByTicker.set(ticker, date);
        }

        for (let i = 0; i < writes.length; i += WRITE_CHUNK) {
          await batchSetWithCreatedAt(db, writes.slice(i, i + WRITE_CHUNK));
        }
        barsWritten += writes.length;
        if (sessions % 25 === 0) {
          this.logger.log(
            `history-backfill: ${sessions} written, ${skipped} already present, of ${dates.length} sessions; ${barsWritten.toLocaleString()} bars`,
          );
        }
      }

      // Watermarks are written even on a partial run: they record what IS
      // stored, and a later run only moves them forward.
      // Tell stock-history how far each ticker is already synced, so its next
      // run appends the newest session instead of re-fetching a deep window
      // per ticker — which is the very cost this job exists to avoid.
      // dates run newest-first now, so the oldest is the last element.
      const earliest = dates[dates.length - 1];
      let watermarks = 0;
      const entries = [...newestByTicker.entries()];
      for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
        const batch = db.batch();
        for (const [ticker, newest] of entries.slice(i, i + WRITE_CHUNK)) {
          batch.set(
            db.collection("sync_watermarks").doc(`${STOCK_HISTORY_JOB}__${ticker}`),
            {
              jobName: STOCK_HISTORY_JOB,
              entityKey: ticker,
              lastSyncedThrough: newest,
              earliestSyncedFrom: earliest,
              updatedAt: new Date().toISOString(),
            },
            { merge: true },
          );
          watermarks++;
        }
        await batch.commit();
      }

      this.logger.log(
        `history-backfill: done — ${sessions} sessions written, ${skipped} skipped, ${barsWritten.toLocaleString()} bars, ` +
          `${newestByTicker.size.toLocaleString()} tickers, ${watermarks.toLocaleString()} watermarks` +
          (rejected > 0 ? `, ${rejected} implausible bars dropped` : ""),
      );
      await this.meta.record(JOB_NAME, { ok: true, count: barsWritten });
      return {
        sessions,
        skipped,
        bars: barsWritten,
        tickers: newestByTicker.size,
        rejected,
      };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
