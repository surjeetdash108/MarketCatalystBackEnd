import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  batchSetWithCreatedAt,
  setWithCreatedAt,
} from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { candidateTradingDays } from "../common/trading-days.util";
import {
  PolygonService,
  type PolygonAggBar,
} from "../vendors/polygon/polygon.service";
import { SyncRegistry } from "../common/sync-registry.service";

const JOB_NAME = "fear-greed";
const LOOKBACK_DAYS = 5;
/** Calendar days of daily closes pulled: the 125-session momentum window plus
 *  ~90 sessions of history for the chart (220 days left only ~28). */
const SERIES_DAYS = 730;
/** Volatility index. The real VIX — VIXY (a futures ETF) decays steadily and
 *  hid spikes: on 22 Oct 2026 the VIX was 24% over its 50-day average while
 *  VIXY was 3% over, reading ~42 instead of fear. */
const VOL_TICKER = "^VIX";
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const sma = (v: number[], n: number) =>
  v.length < n ? null : v.slice(-n).reduce((a, b) => a + b, 0) / n;
const ret = (v: number[], n: number) =>
  v.length < n + 1 || v[v.length - 1 - n] <= 0
    ? null
    : (v[v.length - 1] - v[v.length - 1 - n]) / v[v.length - 1 - n];

function label(v: number): string {
  if (v < 25) return "Extreme Fear";
  if (v < 45) return "Fear";
  if (v <= 55) return "Neutral";
  if (v <= 75) return "Greed";
  return "Extreme Greed";
}

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
      // After market-breadth (18:30), whose breadth this reads for the day.
      cronExpression: "45 18 * * 1-5",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  /** Daily closes WITH their trading date, so the history backfill can align them. */
  private async series(ticker: string): Promise<{ d: string; c: number }[]> {
    const to = new Date();
    const from = new Date(to.getTime() - SERIES_DAYS * 24 * 60 * 60 * 1000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const bars = await this.polygon.getAggsRange(ticker, iso(from), iso(to));
    // `t` is epoch-ms at the bar's start; the UTC date is the ET trading date for
    // a daily bar. Filter out any malformed rows so index math stays sound.
    return bars
      .map((b) => ({ d: new Date(b.t).toISOString().slice(0, 10), c: b.c }))
      .filter((x) => Number.isFinite(x.c) && x.c > 0);
  }

  /**
   * The three price-based components as of bar index `i` (inclusive), from the
   * trailing window — the same formulas the latest-value path uses, evaluated at
   * a historical point. Returns only the components with enough history at `i`.
   */
  private componentsAt(
    spy: number[],
    tlt: number[],
    vix: number[],
    i: number,
  ): Record<string, number> {
    const c: Record<string, number> = {};
    const spyMa = sma(spy.slice(0, i + 1), 125);
    if (spyMa) c.momentum = clamp(50 + (spy[i] / spyMa - 1) * 625);
    const spyR = ret(spy.slice(0, i + 1), 20);
    const tltR = ret(tlt.slice(0, i + 1), 20);
    if (
      spyR != null &&
      tltR != null &&
      Number.isFinite(spyR) &&
      Number.isFinite(tltR)
    )
      c.safeHaven = clamp(50 + (spyR - tltR) * 500);
    // VIX 40% above its 50-day average reads 0 (extreme fear), 40% below 100.
    const vixMa = sma(vix.slice(0, i + 1), 50);
    if (vixMa && Number.isFinite(vixMa) && Number.isFinite(vix[i]))
      c.volatility = clamp(50 - (vix[i] / vixMa - 1) * 125);
    return c;
  }

  /**
   * Fallback when market_breadth has no row for the day: share of US stocks
   * whose close beat their previous session's close, from two daily bulk files.
   */
  private async breadthVsPrevClose(
    date: string | null,
  ): Promise<number | null> {
    if (!date) return null;
    const days = candidateTradingDays(
      new Date(`${date}T12:00:00Z`),
      LOOKBACK_DAYS,
    );
    const today: PolygonAggBar[] = await this.polygon
      .getGroupedDaily(date)
      .catch((): PolygonAggBar[] => []);
    if (today.length === 0) return null;
    const prev = await this.polygon
      .getLatestGroupedDaily([...days].filter((d) => d < date))
      .catch((): null => null);
    if (!prev?.bars.length) return null;
    const prevClose = new Map<string, number>(prev.bars.map((b) => [b.T, b.c]));
    let up = 0;
    let total = 0;
    for (const b of today) {
      const pc = prevClose.get(b.T);
      if (!(pc && pc > 0) || !(b.c > 0) || b.c === pc) continue;
      total++;
      if (b.c > pc) up++;
    }
    return total > 0 ? clamp((up / total) * 100) : null;
  }

  async run() {
    try {
      const [spySer, tltSer, vixSer] = await Promise.all([
        this.series("SPY"),
        this.series("TLT"),
        this.series(VOL_TICKER),
      ]);
      // Align TLT and VIX to SPY's sessions by date, so index i is one day in
      // all three series (a missing print stays a gap, never a shifted value).
      const byDate = (ser: { d: string; c: number }[]) =>
        new Map(ser.map((x) => [x.d, x.c]));
      const tltBy = byDate(tltSer);
      const vixBy = byDate(vixSer);
      const spy = spySer.map((x) => x.c);
      const tlt = spySer.map((x) => tltBy.get(x.d) ?? NaN);
      const vix = spySer.map((x) => vixBy.get(x.d) ?? NaN);

      // Breadth = share of stocks closing ABOVE THE PREVIOUS CLOSE — the same
      // definition the history uses (market_breadth.breadthPct). It used to be
      // close vs that day's OPEN, so today's point and the line disagreed.
      const breadthByDate = new Map<string, number>();
      const bsnap = await this.firebase.firestore
        .collection("market_breadth")
        .get();
      for (const d of bsnap.docs) {
        const b = d.data();
        if (typeof b.breadthPct === "number")
          breadthByDate.set(d.id, clamp(b.breadthPct * 100));
      }

      const lastIdx = spy.length - 1;
      const asOfDate = spySer[lastIdx]?.d ?? null;
      const components = this.componentsAt(spy, tlt, vix, lastIdx);
      const todayBreadth =
        (asOfDate ? breadthByDate.get(asOfDate) : undefined) ??
        (await this.breadthVsPrevClose(asOfDate));
      if (todayBreadth != null) components.breadth = todayBreadth;
      const vals = Object.values(components);
      if (vals.length === 0) {
        throw new Error("No Fear & Greed components could be computed");
      }
      const value = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      await setWithCreatedAt(
        this.firebase.firestore,
        this.firebase.firestore
          .collection("market_sentiment")
          .doc("fear_greed"),
        {
          value,
          label: label(value),
          components: Object.fromEntries(
            Object.entries(components).map(([k, v]) => [k, Math.round(v)]),
          ),
          asOfDate,
          source: "fmp",
          updatedAt: new Date().toISOString(),
        },
      );

      // ── R26: backfill the real composite HISTORY ──────────────────────────
      // The dashboard's F&G history line was reading market_breadth.breadthSentiment
      // (a breadth-ONLY proxy) because no historical composite existed. Compute the
      // 3 price-based components as of each past trading day and join the stored
      // per-day breadth (market_breadth.breadthPct) — the same four inputs as the
      // live value — and write market_sentiment_history/{date}.
      const hist: { id: string; data: Record<string, unknown> }[] = [];
      // Start once the 125-day momentum window is available.
      for (let i = 125; i < spySer.length; i++) {
        const date = spySer[i].d;
        const comp = this.componentsAt(spy, tlt, vix, i);
        const br = breadthByDate.get(date);
        if (br != null) comp.breadth = br;
        const cv = Object.values(comp);
        if (cv.length === 0) continue;
        const v = Math.round(cv.reduce((a, b) => a + b, 0) / cv.length);
        hist.push({
          id: date,
          data: {
            value: v,
            label: label(v),
            components: Object.fromEntries(
              Object.entries(comp).map(([k, val]) => [k, Math.round(val)]),
            ),
            asOfDate: date,
            source: "fmp",
            updatedAt: new Date().toISOString(),
          },
        });
      }
      // Chunked batch write (Firestore caps at 500 ops/batch).
      const col = this.firebase.firestore.collection(
        "market_sentiment_history",
      );
      await batchSetWithCreatedAt(
        this.firebase.firestore,
        hist.map((h) => ({ ref: col.doc(h.id), data: h.data })),
      );

      await this.meta.record(JOB_NAME, { ok: true, count: 1 });
      this.logger.log(
        `fear-greed: value ${value}; backfilled ${hist.length} history day(s)`,
      );
      return {
        value,
        label: label(value),
        components,
        historyDays: hist.length,
      };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
