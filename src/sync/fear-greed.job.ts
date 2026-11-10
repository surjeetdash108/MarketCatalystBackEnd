import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  batchSetWithCreatedAt,
  setWithCreatedAt,
} from "../common/firestore-batch.util";
import { etDate } from "../common/market-calendar.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { sessionPhase } from "../vendors/market-data/fmp-mapping.util";
import { PolygonService } from "../vendors/polygon/polygon.service";

const JOB_NAME = "fear-greed";
/** Calendar days of daily closes pulled (~500 sessions): 125 for the momentum
 *  average + 252 for the scoring window + ~120 sessions of history. */
const SERIES_DAYS = 730;
/** Each reading is scored against its own trailing year, the way CNN's index
 *  ranks every indicator against its recent history rather than a fixed scale. */
const SCORE_WINDOW = 252;
/** Fewest past readings a score is based on; below this the part is left out. */
const MIN_SCORE_SAMPLES = 60;
/** Parts needed before an index value is published. */
const MIN_PARTS = 4;
/** Fewest stocks behind a breadth / strength reading. */
const MIN_STOCKS = 50;
/** A stored breadth day counts only once half the universe has reported (same
 *  rule as the recap): Oct 22 2026 was stored with 1 of 241 stocks — "100%". */
const BREADTH_MIN_COVERAGE = 0.5;

/**
 * Inputs, all FMP daily closes (historical-price-eod/full) plus a live quote
 * for today during the session:
 *  - SPY: momentum (vs its 125-day average) and the stock side of safe haven
 *  - TLT: 20+ year Treasuries, the safe-haven side
 *  - ^VIX: the CBOE VIX itself (VIXY, a futures ETF, decays and hid spikes)
 *  - HYG / LQD: high-yield vs investment-grade corporate bonds (junk demand)
 */
const TICKERS = ["SPY", "TLT", "^VIX", "HYG", "LQD"] as const;
type Ticker = (typeof TICKERS)[number];

export const PART_KEYS = [
  "momentum",
  "strength",
  "breadth",
  "volatility",
  "safeHaven",
  "junkBond",
] as const;
export type PartKey = (typeof PART_KEYS)[number];

const sma = (v: number[], i: number, n: number): number | null => {
  if (i + 1 < n) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) {
    if (!Number.isFinite(v[j])) return null;
    s += v[j];
  }
  return s / n;
};
const ret = (v: number[], i: number, n: number): number | null =>
  i >= n && v[i - n] > 0 && Number.isFinite(v[i]) && Number.isFinite(v[i - n])
    ? v[i] / v[i - n] - 1
    : null;

export function label(v: number): string {
  if (v < 25) return "Extreme Fear";
  if (v < 45) return "Fear";
  if (v <= 55) return "Neutral";
  if (v <= 75) return "Greed";
  return "Extreme Greed";
}

/**
 * Percentile rank (0–100) of `raw[i]` among the finite readings in the
 * trailing SCORE_WINDOW sessions up to and including i. Higher raw = greed.
 * Null with fewer than MIN_SCORE_SAMPLES readings.
 */
export function percentileScore(
  raw: Array<number | null>,
  i: number,
): number | null {
  const x = raw[i];
  if (x == null || !Number.isFinite(x)) return null;
  let below = 0;
  let equal = 0;
  let n = 0;
  for (let j = Math.max(0, i - SCORE_WINDOW + 1); j <= i; j++) {
    const v = raw[j];
    if (v == null || !Number.isFinite(v)) continue;
    n++;
    if (v < x) below++;
    else if (v === x) equal++;
  }
  if (n < MIN_SCORE_SAMPLES) return null;
  return ((below + 0.5 * equal) / n) * 100;
}

/** Raw readings per session (higher = greedier), aligned to `dates`. */
export interface RawSeries {
  momentum: Array<number | null>;
  strength: Array<number | null>;
  breadth: Array<number | null>;
  volatility: Array<number | null>;
  safeHaven: Array<number | null>;
  junkBond: Array<number | null>;
}

export function rawSeries(
  closes: Record<Ticker, number[]>,
  breadth: Array<number | null>,
  strength: Array<number | null>,
): RawSeries {
  const n = closes.SPY.length;
  const out: RawSeries = {
    momentum: [],
    strength,
    breadth,
    volatility: [],
    safeHaven: [],
    junkBond: [],
  };
  for (let i = 0; i < n; i++) {
    // S&P 500 vs its 125-session average.
    const ma125 = sma(closes.SPY, i, 125);
    out.momentum.push(ma125 ? closes.SPY[i] / ma125 - 1 : null);
    // VIX vs its 50-session average, inverted (a rising VIX is fear).
    const ma50 = sma(closes["^VIX"], i, 50);
    out.volatility.push(
      ma50 && Number.isFinite(closes["^VIX"][i])
        ? -(closes["^VIX"][i] / ma50 - 1)
        : null,
    );
    // Stocks vs Treasuries over 20 sessions.
    const spy20 = ret(closes.SPY, i, 20);
    const tlt20 = ret(closes.TLT, i, 20);
    out.safeHaven.push(spy20 != null && tlt20 != null ? spy20 - tlt20 : null);
    // Junk vs investment-grade bonds over 20 sessions.
    const hyg20 = ret(closes.HYG, i, 20);
    const lqd20 = ret(closes.LQD, i, 20);
    out.junkBond.push(hyg20 != null && lqd20 != null ? hyg20 - lqd20 : null);
  }
  return out;
}

/** Scores (0–100) for session i, only the parts with enough history. */
export function scoresAt(
  raw: RawSeries,
  i: number,
): Partial<Record<PartKey, number>> {
  const s: Partial<Record<PartKey, number>> = {};
  for (const k of PART_KEYS) {
    const v = percentileScore(raw[k], i);
    if (v != null) s[k] = v;
  }
  // 52-week highs/lows history is short until a year of it accumulates; until
  // then strength uses a fixed scale: net new highs of ±10% of stocks = 100/0.
  const st = raw.strength[i];
  if (s.strength == null && st != null && Number.isFinite(st))
    s.strength = Math.max(0, Math.min(100, 50 + st * 500));
  return s;
}

/**
 * Fear & Greed index (worker job). Six of CNN's seven measures — put/call
 * ratio has no source on the current data plan — each a raw reading scored
 * by its percentile rank over the trailing year, averaged equally.
 *
 * Runs after the close (premarket orchestrator / evening) for the settled
 * value and every 15 minutes in the session (Cloud Scheduler) with today's
 * live quotes, so the dashboard is never a day behind.
 */
@Injectable()
export class FearGreedJob implements OnModuleInit {
  private readonly logger = new Logger(FearGreedJob.name);

  constructor(
    private readonly polygon: PolygonService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["market_sentiment", "market_sentiment_history"],
      // After market-breadth (18:30), whose breadth / highs-lows it reads.
      cronExpression: "45 18 * * 1-5",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  /** Daily closes (FMP) keyed by ET trading date. */
  private async series(ticker: string): Promise<Map<string, number>> {
    const to = new Date();
    const from = new Date(to.getTime() - SERIES_DAYS * 86_400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const bars = await this.polygon.getAggsRange(ticker, iso(from), iso(to));
    // Daily bars are stamped at ET midnight, so the UTC date is the session date.
    return new Map(
      bars
        .filter((b) => Number.isFinite(b.c) && b.c > 0)
        .map((b) => [new Date(b.t).toISOString().slice(0, 10), b.c] as const),
    );
  }

  /**
   * During the session, today has no daily bar yet: today's reading uses the
   * live quote. Only when the quote's previous close IS the last stored close
   * — on a holiday the quote still shows the last session, and appending it
   * would invent a flat day.
   */
  private async liveCloses(
    lastClose: Record<Ticker, number | undefined>,
  ): Promise<Record<Ticker, number> | null> {
    if (sessionPhase(Date.now()) !== "open") return null;
    const quotes = await this.polygon
      .getUniversalSnapshot([...TICKERS])
      .catch(
        () => [] as Awaited<ReturnType<PolygonService["getUniversalSnapshot"]>>,
      );
    const by = new Map(quotes.map((q) => [q.ticker, q]));
    const spy = by.get("SPY");
    const last = lastClose.SPY;
    if (!spy?.price || !spy.previousClose || !last) return null;
    if (Math.abs(spy.previousClose / last - 1) > 0.0005) return null;
    const out = {} as Record<Ticker, number>;
    for (const t of TICKERS) {
      const p = by.get(t)?.price;
      if (!(p && p > 0)) return null;
      out[t] = p;
    }
    return out;
  }

  /** Today's breadth and 52-week highs/lows from live company quotes. */
  private async liveInternals(): Promise<{
    breadth: number | null;
    strength: number | null;
  }> {
    const snap = await this.firebase.firestore
      .collection("companies")
      .select("pctChange", "price", "high52", "low52")
      .get();
    let adv = 0;
    let dec = 0;
    let hi = 0;
    let lo = 0;
    let covered = 0;
    for (const d of snap.docs) {
      const pct = d.get("pctChange") as unknown;
      if (typeof pct === "number" && pct > 0) adv++;
      else if (typeof pct === "number" && pct < 0) dec++;
      const price = d.get("price") as unknown;
      const h52 = d.get("high52") as unknown;
      const l52 = d.get("low52") as unknown;
      if (
        typeof price === "number" &&
        typeof h52 === "number" &&
        typeof l52 === "number" &&
        h52 > 0
      ) {
        covered++;
        if (price >= h52) hi++;
        else if (price <= l52) lo++;
      }
    }
    return {
      breadth: adv + dec >= MIN_STOCKS ? adv / (adv + dec) : null,
      strength: covered >= MIN_STOCKS ? (hi - lo) / covered : null,
    };
  }

  async run() {
    try {
      const maps = await Promise.all(TICKERS.map((t) => this.series(t)));
      const byTicker = Object.fromEntries(
        TICKERS.map((t, k) => [t, maps[k]]),
      ) as Record<Ticker, Map<string, number>>;
      // SPY's sessions are the calendar; the others align to them by date, so
      // a missing print is a gap (NaN), never a shifted value.
      const dates = [...byTicker.SPY.keys()].sort();
      const closes = Object.fromEntries(
        TICKERS.map((t) => [t, dates.map((d) => byTicker[t].get(d) ?? NaN)]),
      ) as Record<Ticker, number[]>;

      // Stored internals per session (market-breadth job, close vs previous
      // close; 52-week highs/lows where a full year of bars exists).
      const breadthBy = new Map<string, number>();
      const strengthBy = new Map<string, number>();
      for (const d of (
        await this.firebase.firestore.collection("market_breadth").get()
      ).docs) {
        const b = d.data() as {
          covered?: unknown;
          universe?: unknown;
          breadthPct?: unknown;
          newHighs?: unknown;
          newLows?: unknown;
          highLowCovered?: unknown;
        };
        const settled =
          typeof b.covered === "number" &&
          typeof b.universe === "number" &&
          b.universe > 0 &&
          b.covered / b.universe >= BREADTH_MIN_COVERAGE;
        if (settled && typeof b.breadthPct === "number")
          breadthBy.set(d.id, b.breadthPct);
        if (
          typeof b.newHighs === "number" &&
          typeof b.newLows === "number" &&
          typeof b.highLowCovered === "number" &&
          b.highLowCovered >= MIN_STOCKS
        )
          strengthBy.set(d.id, (b.newHighs - b.newLows) / b.highLowCovered);
      }
      const breadth: Array<number | null> = dates.map(
        (d) => breadthBy.get(d) ?? null,
      );
      const strength: Array<number | null> = dates.map(
        (d) => strengthBy.get(d) ?? null,
      );

      // Today, live, while the session is open.
      const today = etDate();
      const live =
        dates[dates.length - 1] < today
          ? await this.liveCloses(
              Object.fromEntries(
                TICKERS.map((t) => [t, closes[t][closes[t].length - 1]]),
              ) as Record<Ticker, number | undefined>,
            )
          : null;
      if (live) {
        dates.push(today);
        for (const t of TICKERS) closes[t].push(live[t]);
        breadth.push(null);
        strength.push(null);
      }
      const lastIdx = dates.length - 1;
      // Today's session is still running when its last point is today and the
      // market is open (FMP's daily series carries today's in-progress bar, so
      // "live" also covers the case where no quote had to be appended). Such a
      // point is published as live and kept out of the settled history.
      const phase = sessionPhase(Date.now());
      const intraday =
        dates[lastIdx] === today && (phase === "open" || phase === "pre");
      if (live || breadth[lastIdx] == null || strength[lastIdx] == null) {
        const li = await this.liveInternals().catch(
          (): { breadth: number | null; strength: number | null } => ({
            breadth: null,
            strength: null,
          }),
        );
        if (breadth[lastIdx] == null) breadth[lastIdx] = li.breadth;
        if (strength[lastIdx] == null) strength[lastIdx] = li.strength;
      }

      const raw = rawSeries(closes, breadth, strength);
      const parts = scoresAt(raw, lastIdx);
      const vals = Object.values(parts);
      if (vals.length < MIN_PARTS) {
        throw new Error(
          `Only ${vals.length} Fear & Greed parts could be scored`,
        );
      }
      const value = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      const round = (o: Partial<Record<PartKey, number>>) =>
        Object.fromEntries(
          Object.entries(o).map(([k, v]) => [k, Math.round(v)]),
        );
      // The raw readings behind each score, so a value can be checked by hand.
      const inputs = {
        spyVs125dPct: pct(raw.momentum[lastIdx]),
        vixVs50dPct:
          raw.volatility[lastIdx] == null
            ? null
            : pct(-raw.volatility[lastIdx]),
        spyMinusTlt20dPct: pct(raw.safeHaven[lastIdx]),
        hygMinusLqd20dPct: pct(raw.junkBond[lastIdx]),
        advancersPct: pct(raw.breadth[lastIdx]),
        netNewHighsPct: pct(raw.strength[lastIdx]),
        vix: closes["^VIX"][lastIdx],
      };

      await setWithCreatedAt(
        this.firebase.firestore,
        this.firebase.firestore
          .collection("market_sentiment")
          .doc("fear_greed"),
        {
          value,
          label: label(value),
          components: round(parts),
          inputs,
          asOfDate: dates[lastIdx],
          intraday,
          method: "percentile-252",
          source: "fmp",
          updatedAt: new Date().toISOString(),
        },
      );

      // History: every settled session with at least MIN_PARTS scored parts.
      const hist: { id: string; data: Record<string, unknown> }[] = [];
      const settledEnd = intraday ? lastIdx - 1 : lastIdx;
      for (let i = 0; i <= settledEnd; i++) {
        const p = scoresAt(raw, i);
        const pv = Object.values(p);
        if (pv.length < MIN_PARTS) continue;
        const v = Math.round(pv.reduce((a, b) => a + b, 0) / pv.length);
        hist.push({
          id: dates[i],
          data: {
            value: v,
            label: label(v),
            components: round(p),
            asOfDate: dates[i],
            method: "percentile-252",
            source: "fmp",
            updatedAt: new Date().toISOString(),
          },
        });
      }
      const col = this.firebase.firestore.collection(
        "market_sentiment_history",
      );
      await batchSetWithCreatedAt(
        this.firebase.firestore,
        hist.map((h) => ({ ref: col.doc(h.id), data: h.data })),
      );

      await this.meta.record(JOB_NAME, { ok: true, count: 1 });
      this.logger.log(
        `fear-greed: ${value} ${label(value)} as of ${dates[lastIdx]}${intraday ? " (live)" : ""}; ${hist.length} history day(s)`,
      );
      return {
        value,
        label: label(value),
        components: round(parts),
        inputs,
        asOfDate: dates[lastIdx],
        intraday,
        historyDays: hist.length,
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

const pct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 100;
