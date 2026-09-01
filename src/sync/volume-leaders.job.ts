import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { addDays, isoDate } from "../common/date.util";
import { PolygonService } from "../vendors/polygon/polygon.service";

const JOB_NAME = "volume-leaders";

/**
 * Relative volume for the WHOLE US market, ranked on the server.
 *
 * WHY THIS EXISTS
 * The Movers board's "Unusual Volume" tab ranked RVOL inside the daily movers
 * feed — the top 100 gainers and 100 losers, chosen by PRICE. Unusual volume is
 * a volume event, and its clearest cases are heavy trading on a FLAT price,
 * which that feed by construction never contains: 17 of the 20 highest-RVOL
 * names in the tracked universe could not appear at all. A cross-check of 30
 * names against Yahoo Finance and MarketChameleon matched 2.
 *
 * Widening it to the tracked universe (~900 names) helped, but that is still
 * 6.9% of the ~13,300 listed US symbols the public screeners scan.
 *
 * WHY IT IS CHEAP
 * Two things make full-market coverage practical rather than ruinous:
 *
 *   1. ONE vendor call. Polygon's grouped-daily returns every US symbol's bar
 *      for a session in a single request (~12,600 rows, ~1.4 MB). The naive
 *      alternative — a call per ticker — is 13,000+ requests against a plan
 *      that already returns 429s during premarket.
 *
 *   2. A ROLLING SUM instead of a re-read. RVOL is today's volume over a
 *      20-session average. technical-indicators rebuilds that by reading 300
 *      stored bars per ticker, so cost scales at tickers x 300. Keeping the
 *      window on a small per-ticker doc makes it ONE read per ticker — a 300x
 *      reduction, which is what brings the whole market inside a rounding error
 *      of the current bill.
 *
 * WHY THE OUTPUT IS ONE DOCUMENT
 * The board cannot fetch 12,600 companies to sort them in the browser: the
 * existing 923-company payload is already 2.6 MB. Ranking happens here and only
 * the leaders are published, so the client reads one small document however
 * large the market gets.
 *
 * This deliberately does NOT store bar history for the full market — the
 * rolling window is all RVOL needs. The 300-bar history stays for the tracked
 * names that also need RSI, MACD, beta and pivots.
 */

/** Sessions in the average. Matches RVOL_WINDOW in technical-indicators. */
const WINDOW = 20;
/** Below this many observed sessions a ratio is too noisy to publish. */
const MIN_SESSIONS = 10;
/**
 * Average-volume floor, in shares.
 *
 * A stock that barely trades for a month and then prints once produces an
 * arithmetically valid but useless ratio — RDHL showed 3,874x. Public screeners
 * apply the same kind of floor. Names below it still have their window
 * maintained; they are only kept off the leaderboard.
 */
const MIN_AVG_VOLUME = 50_000;
/** How many leaders to publish. Comfortably more than any board shows. */
const TOP_N = 300;
/** How far back to look for the most recent session with data. */
const LOOKBACK_DAYS = 6;

const STATE = "volume_state";
const OUTPUT = "volume_leaders";

interface VolumeState {
  /** Most recent volumes, oldest first, capped at WINDOW. */
  window: number[];
  /** Session the last entry came from — makes a re-run idempotent. */
  lastDate: string;
}

export interface VolumeLeader {
  ticker: string;
  volume: number;
  avgVolume: number;
  rvol: number;
  close: number | null;
  /** Session move, so the board can colour the row without another lookup. */
  changePct: number | null;
}

@Injectable()
export class VolumeLeadersJob implements OnModuleInit {
  private readonly logger = new Logger(VolumeLeadersJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly polygon: PolygonService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: [STATE, OUTPUT],
      cronExpression: "20 18 * * 1-5",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const today = new Date();
      const candidates = Array.from({ length: LOOKBACK_DAYS }, (_, i) =>
        isoDate(addDays(today, -i)),
      );
      // FIRST RUN SEEDS ITSELF. The window needs MIN_SESSIONS before any ratio
      // can be published, so a cold start would leave the board empty for two
      // trading weeks. Grouped-daily is one call PER SESSION, so replaying the
      // last WINDOW+1 sessions costs ~21 calls once and the leaderboard is
      // correct immediately. Later runs fetch only the newest session.
      const seeded = (
        await this.firebase.firestore.collection(OUTPUT).doc("current").get()
      ).exists;
      if (!seeded) {
        this.logger.log(
          `volume-leaders: cold start — seeding the ${WINDOW}-session window from grouped-daily`,
        );
        const seedDates = Array.from({ length: WINDOW + LOOKBACK_DAYS }, (_, i) =>
          isoDate(addDays(today, -(WINDOW + LOOKBACK_DAYS) + i)),
        );
        for (const d of seedDates) {
          const seedBars = await this.polygon.getGroupedDaily(d).catch(() => []);
          if (seedBars.length === 0) continue; // weekend or holiday
          await this.applySession(d, seedBars, { publish: false });
        }
      }

      const latest = await this.polygon.getLatestGroupedDaily(candidates);
      if (!latest || latest.bars.length === 0) {
        this.logger.warn(
          `volume-leaders: no grouped-daily data in the last ${LOOKBACK_DAYS} days — leaving the previous leaderboard in place`,
        );
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { leaders: 0, note: "no session data" };
      }
      const { date, bars } = latest;
      const summary = await this.applySession(date, bars, { publish: true });

      await this.meta.record(JOB_NAME, { ok: true, count: summary.published });
      return { date, ...summary };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Roll ONE session into every ticker's window, and optionally publish.
   *
   * Shared by the cold-start seed and the daily run so the two cannot drift:
   * seeding is simply this applied to each of the last WINDOW sessions in
   * order, with publishing suppressed until the newest one.
   */
  private async applySession(
    date: string,
    bars: Array<{ T: string; v: number; o?: number; c?: number }>,
    opts: { publish: boolean },
  ): Promise<{ universe: number; ranked: number; published: number }> {

      // Only real, positively-traded rows. A zero or missing volume carries no
      // information and would divide into a meaningless ratio later.
      const rows = bars.filter(
        (b) => b.T && typeof b.v === "number" && Number.isFinite(b.v) && b.v > 0,
      );

      const db = this.firebase.firestore;
      const refs = rows.map((b) => db.collection(STATE).doc(b.T));
      // getAll in slices: one read per ticker, the whole point of the design.
      const states = new Map<string, VolumeState>();
      for (let i = 0; i < refs.length; i += 300) {
        const snaps = await db.getAll(...refs.slice(i, i + 300));
        for (const s of snaps) {
          const d = s.data();
          if (!d) continue;
          const w = Array.isArray(d.window)
            ? d.window.filter((n: unknown) => typeof n === "number")
            : [];
          states.set(s.id, { window: w, lastDate: String(d.lastDate ?? "") });
        }
      }

      const writes: Array<{ id: string; data: Record<string, unknown> }> = [];
      const leaders: VolumeLeader[] = [];
      let alreadyApplied = 0;

      for (const b of rows) {
        const prev = states.get(b.T) ?? { window: [], lastDate: "" };
        // Idempotent: a second run for the same session must not push the
        // volume twice and halve every subsequent average.
        if (prev.lastDate === date) {
          alreadyApplied++;
        }
        const priorWindow =
          prev.lastDate === date ? prev.window.slice(0, -1) : prev.window;

        // The average EXCLUDES today, so the ratio compares this session
        // against its own recent history rather than against itself.
        if (priorWindow.length >= MIN_SESSIONS) {
          const avg =
            priorWindow.reduce((a, n) => a + n, 0) / priorWindow.length;
          if (avg >= MIN_AVG_VOLUME) {
            const changePct =
              typeof b.o === "number" && b.o > 0 && typeof b.c === "number"
                ? ((b.c - b.o) / b.o) * 100
                : null;
            leaders.push({
              ticker: b.T,
              volume: Math.round(b.v),
              avgVolume: Math.round(avg),
              rvol: Math.round((b.v / avg) * 100) / 100,
              close: typeof b.c === "number" ? b.c : null,
              changePct:
                changePct == null ? null : Math.round(changePct * 100) / 100,
            });
          }
        }

        const nextWindow = [...priorWindow, b.v].slice(-WINDOW);
        writes.push({
          id: b.T,
          data: { window: nextWindow, lastDate: date, updatedAt: new Date().toISOString() },
        });
      }

      await chunkedBatchSet(db, STATE, writes);

      if (opts.publish) {
        leaders.sort((a, b) => b.rvol - a.rvol);
        const top = leaders.slice(0, TOP_N);
        // One document, whatever the market size — the client never pages this.
        await db.collection(OUTPUT).doc("current").set({
          date,
          leaders: top,
          universeSize: rows.length,
          rankedCount: leaders.length,
          updatedAt: new Date().toISOString(),
        });
        this.logger.log(
          `volume-leaders: ${date} — ${rows.length} symbols, ${leaders.length} ranked, top ${top.length} published` +
            (alreadyApplied > 0 ? ` (re-run: ${alreadyApplied} rows already had this session)` : ""),
        );
        return { universe: rows.length, ranked: leaders.length, published: top.length };
      }
      return { universe: rows.length, ranked: leaders.length, published: 0 };
  }
}
