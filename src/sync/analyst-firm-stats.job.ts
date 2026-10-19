import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { TICKER_UNIVERSE, activeUniverse } from "../common/ticker-universe";
import { FmpService } from "../vendors/fmp/fmp.service";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { toFmpSymbol } from "../vendors/market-data/fmp-mapping.util";

const JOB_NAME = "analyst-firm-stats";
/** Tickers measured per run (cursor over the active universe; ~12 runs a cycle). */
const BATCH_SIZE = Number(process.env.ANALYST_FIRM_STATS_BATCH_SIZE) || 100;
const CONCURRENCY = 4;
/** Rating changes measured over this many years of history. */
const RATING_YEARS = 3;
/** A price target "hits" if the stock trades through it within this window. */
const TARGET_WINDOW_DAYS = 365;
/** Sessions after a rating change the move is measured over. */
const MOVE_SESSIONS = 5;
/** Below this many samples a firm's figure is not shown (too noisy to mean anything). */
export const MIN_FIRM_SAMPLES = 10;

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** "J.P. Morgan" / "JP Morgan" / "JPMorgan" → "jpmorgan". */
export const firmKey = (name: unknown) =>
  String(name ?? "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const BULLISH = /buy|overweight|outperform|positive|accumulate|add\b|sector outperform|market outperform/i;

interface RatingCall { firm: string; date: string; dir: 1 | -1; move: number; bullish: boolean }
interface TargetCall { firm: string; date: string; hit: boolean; ticker: string; target: number; posted: number }
interface GradeOnly { firm: string; bullish: boolean }

/**
 * Real track records for the analyst firms on the Analyst Actions screen —
 * replaces a hard-coded table (Morgan Stanley "78% / +4.2%" for every call,
 * 64% / +2.1% for any firm not listed).
 *
 * Per ticker, from FMP: the rating-change history (`grades`) and price-target
 * posts (`price-target-news`), scored against FMP daily prices:
 *  - move after a call: close before the call → close MOVE_SESSIONS sessions
 *    later, signed by the call's direction (upgrade +, downgrade −);
 *  - target hit: within TARGET_WINDOW_DAYS of the post the stock traded at or
 *    through the target (high for a target above the price when posted, low
 *    for one below). Only posts whose window has CLOSED are counted, so recent
 *    targets cannot bias the rate.
 * Outcomes are stored per ticker (`analyst_calls/{ticker}`) and every run
 * re-aggregates all of them into `analyst_firm_stats/{firmKey}`.
 */
@Injectable()
export class AnalystFirmStatsJob implements OnModuleInit {
  private readonly logger = new Logger(AnalystFirmStatsJob.name);

  constructor(
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly firebase: FirebaseAdminService,
    private readonly fmp: FmpService,
    private readonly polygon: PolygonService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["analyst_firm_stats"],
      // Runs inside the premarket orchestrator (premarket.job.ts PER_TICKER).
      cronExpression: "0 8 * * 1-5",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    if (!this.fmp.enabled) {
      await this.meta.record(JOB_NAME, { ok: true, count: 0, error: "FMP disabled" });
      return { measured: 0 };
    }
    try {
      const live = await activeUniverse(this.firebase.firestore).catch(() => [] as string[]);
      const universe = live.length > 0 ? live : TICKER_UNIVERSE;
      const cursor = await this.meta.getCursor(JOB_NAME);
      const batch = Array.from(
        { length: Math.min(BATCH_SIZE, universe.length) },
        (_, i) => universe[(cursor + i) % universe.length],
      );

      const docs: Array<{ id: string; data: Record<string, unknown> }> = [];
      const queue = [...batch];
      let failed = 0;
      const worker = async () => {
        for (;;) {
          const ticker = queue.shift();
          if (!ticker) return;
          try {
            const data = await this.measureTicker(ticker);
            if (data) docs.push({ id: ticker, data });
          } catch (err) {
            failed++;
            this.logger.warn(`analyst-firm-stats ${ticker}: ${(err as Error).message}`);
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (docs.length) await chunkedBatchSet(this.firebase.firestore, "analyst_calls", docs);
      await this.meta.setCursor(JOB_NAME, (cursor + batch.length) % universe.length);

      const firms = await this.aggregate();
      await this.meta.record(JOB_NAME, { ok: true, count: firms });
      this.logger.log(`analyst-firm-stats: measured ${docs.length}/${batch.length} tickers (${failed} failed), ${firms} firms`);
      return { measured: docs.length, firms };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: (err as Error).message });
      throw err;
    }
  }

  /** One ticker's call outcomes, or null when it has no rating/target history. */
  async measureTicker(ticker: string): Promise<Record<string, unknown> | null> {
    const sym = toFmpSymbol(ticker);
    const now = Date.now();
    const [grades, targets] = await Promise.all([
      this.fmp.request(`grades?symbol=${encodeURIComponent(sym)}&limit=1000`) as Promise<Array<Record<string, unknown>>>,
      this.fetchTargets(sym),
    ]);
    const ratingFrom = isoDay(now - RATING_YEARS * 365 * DAY);
    const recentGrades = grades.filter((g) => String(g.date ?? "") >= ratingFrom && g.gradingCompany);
    const changes = recentGrades.filter((g) => /upgrade|downgrade/i.test(String(g.action ?? "")));
    if (recentGrades.length === 0 && targets.length === 0) return null;

    // Daily bars spanning every call plus its measurement window.
    const dates = [...changes.map((g) => String(g.date)), ...targets.map((t) => t.date)].sort();
    let bars: Array<{ t: number; h: number; l: number; c: number }> = [];
    if (dates.length) {
      const from = isoDay(Date.parse(dates[0]) - 10 * DAY);
      bars = (await this.polygon.getAggsRange(ticker, from, isoDay(now)))
        .filter((b) => b.c != null && b.h != null && b.l != null)
        .map((b) => ({ t: b.t, h: b.h as number, l: b.l as number, c: b.c as number }));
    }
    const idxOnOrAfter = (ms: number) => bars.findIndex((b) => b.t >= ms);

    const ratingCalls: RatingCall[] = [];
    for (const g of changes) {
      const callMs = Date.parse(`${g.date}T00:00:00Z`);
      const i = idxOnOrAfter(callMs);
      // Base = the last close BEFORE the call day; end = MOVE_SESSIONS later.
      if (i <= 0 || i - 1 + MOVE_SESSIONS >= bars.length) continue;
      const base = bars[i - 1].c;
      const end = bars[i - 1 + MOVE_SESSIONS].c;
      if (!(base > 0)) continue;
      const dir: 1 | -1 = /upgrade/i.test(String(g.action)) ? 1 : -1;
      ratingCalls.push({
        firm: String(g.gradingCompany),
        date: String(g.date),
        dir,
        move: Math.round(((end / base - 1) * 100) * dir * 100) / 100,
        bullish: BULLISH.test(String(g.newGrade ?? "")),
      });
    }

    const targetCalls: TargetCall[] = [];
    for (const t of targets) {
      const postMs = Date.parse(`${t.date}T00:00:00Z`);
      if (now - postMs < TARGET_WINDOW_DAYS * DAY) continue; // window still open
      const i = idxOnOrAfter(postMs);
      if (i < 0) continue;
      const endMs = postMs + TARGET_WINDOW_DAYS * DAY;
      const window = bars.slice(i).filter((b) => b.t <= endMs);
      if (window.length < 200) continue; // not enough sessions to judge
      const up = t.target >= t.priceWhenPosted;
      const hit = up ? window.some((b) => b.h >= t.target) : window.some((b) => b.l <= t.target);
      targetCalls.push({ firm: t.firm, date: t.date, hit, ticker, target: t.target, posted: t.priceWhenPosted });
    }

    const gradeStances: GradeOnly[] = recentGrades.map((g) => ({
      firm: String(g.gradingCompany),
      bullish: BULLISH.test(String(g.newGrade ?? "")),
    }));
    return { ticker, ratingCalls, targetCalls, gradeStances, updatedAt: new Date().toISOString() };
  }

  private async fetchTargets(sym: string) {
    const out: Array<{ firm: string; date: string; target: number; priceWhenPosted: number }> = [];
    for (let page = 0; page < 5; page++) {
      const rows = (await this.fmp.request(
        `price-target-news?symbol=${encodeURIComponent(sym)}&page=${page}&limit=100`,
      )) as Array<Record<string, unknown>>;
      for (const r of rows) {
        const target = Number(r.priceTarget);
        const posted = Number(r.priceWhenPosted);
        const date = String(r.publishedDate ?? "").slice(0, 10);
        if (!r.analystCompany || !(target > 0) || !(posted > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        out.push({ firm: String(r.analystCompany), date, target, priceWhenPosted: posted });
      }
      if (rows.length < 100) break;
    }
    return out;
  }

  /** Re-aggregates every stored ticker's outcomes into per-firm stats. */
  private async aggregate(): Promise<number> {
    const snap = await this.firebase.firestore.collection("analyst_calls").get();
    type Acc = { names: Map<string, number>; moves: number[]; up: number[]; down: number[]; hits: number; targets: number; bull: number; stances: number; recent: TargetCall[] };
    const byFirm = new Map<string, Acc>();
    const acc = (name: string) => {
      const k = firmKey(name);
      let a = byFirm.get(k);
      if (!a) {
        a = { names: new Map(), moves: [], up: [], down: [], hits: 0, targets: 0, bull: 0, stances: 0, recent: [] };
        byFirm.set(k, a);
      }
      a.names.set(name, (a.names.get(name) ?? 0) + 1);
      return a;
    };
    for (const d of snap.docs) {
      const x = d.data() as { ratingCalls?: RatingCall[]; targetCalls?: TargetCall[]; gradeStances?: GradeOnly[] };
      for (const c of x.ratingCalls ?? []) {
        const a = acc(c.firm);
        a.moves.push(c.move);
        (c.dir > 0 ? a.up : a.down).push(c.dir > 0 ? c.move : -c.move);
      }
      for (const t of x.targetCalls ?? []) {
        const a = acc(t.firm);
        a.targets++;
        if (t.hit) a.hits++;
        if (t.ticker) a.recent.push(t);
      }
      for (const g of x.gradeStances ?? []) {
        const a = acc(g.firm);
        a.stances++;
        if (g.bullish) a.bull++;
      }
    }
    const mean = (v: number[]) => (v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100 : null);
    const now = new Date().toISOString();
    const out = [...byFirm.entries()].map(([k, a]) => ({
      id: k,
      data: {
        firmKey: k,
        // Most common spelling across FMP's feeds.
        name: [...a.names.entries()].sort((x, y) => y[1] - x[1])[0][0],
        ratingChanges: a.moves.length,
        // Mean move in the call's direction after any upgrade/downgrade.
        avgMoveAfterCall: a.moves.length >= MIN_FIRM_SAMPLES ? mean(a.moves) : null,
        // Raw mean price move after upgrades / after downgrades.
        avgMoveAfterUpgrade: a.up.length >= MIN_FIRM_SAMPLES ? mean(a.up) : null,
        avgMoveAfterDowngrade: a.down.length >= MIN_FIRM_SAMPLES ? mean(a.down) : null,
        targetsResolved: a.targets,
        hitRatePct: a.targets >= MIN_FIRM_SAMPLES ? Math.round((a.hits / a.targets) * 1000) / 10 : null,
        ratingsTracked: a.stances,
        bullishPct: a.stances >= MIN_FIRM_SAMPLES ? Math.round((a.bull / a.stances) * 1000) / 10 : null,
        // Latest resolved target calls (12-month window closed), newest first.
        recentResolved: a.recent
          .sort((x, y) => y.date.localeCompare(x.date))
          .slice(0, 12)
          .map((t) => ({ ticker: t.ticker, date: t.date, target: t.target, priceWhenPosted: t.posted, hit: t.hit })),
        moveSessions: MOVE_SESSIONS,
        targetWindowDays: TARGET_WINDOW_DAYS,
        updatedAt: now,
      },
    }));
    if (out.length) await chunkedBatchSet(this.firebase.firestore, "analyst_firm_stats", out);
    return out.length;
  }
}
