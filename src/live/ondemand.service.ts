import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { FieldValue } from "firebase-admin/firestore";
import {
  NEWS_ADAPTER,
  type NewsAdapter,
  EARNINGS_ESTIMATES_ADAPTER,
} from "../adapters/types";
import type { EarningsEstimatesAdapter } from "../adapters/earnings-estimates.adapter";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { sectorFromSic } from "../common/sic-sector.util";
import {
  annualTotals,
  dividendCagr,
  increaseStreak,
} from "../sync/corporate-actions.job";
import {
  mapAnnualRow,
  mapQuarterRow,
  alignReportedEstimate,
  buildEpsHistory,
  ttmReportedEpsFromRows,
  type SplitEvent,
  type EpsHistoryRow,
} from "../sync/financials.job";
import {
  computeIndicators,
  type IndicatorBar,
} from "../sync/technical-indicators.job";
import { computeRsScore, rsPercentile } from "../sync/rs-rating.job";
import {
  computeTechComponents,
  techRatingFromComponents,
  type TechComponents,
} from "../sync/tech-rating.job";
import {
  PolygonService,
  PolygonAggBar,
} from "../vendors/polygon/polygon.service";
import { FmpService } from "../vendors/fmp/fmp.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ON-DEMAND DATA LAYER (cache-aside).
 *
 * The app no longer pre-syncs a fixed ticker universe. Data is fetched the
 * first time ANY user asks for it, written to Firestore with `createdAt`, and
 * served from that shared cache to every subsequent user until it goes stale:
 *
 *   browser → GET /live/bars|/live/company
 *          → in-memory cache (per instance)
 *          → Firestore doc (createdAt + per-resolution TTL)
 *          → ONE Polygon call (coalesced across concurrent requesters)
 *          → written back with createdAt → served
 *
 * Cost properties:
 *   - Firestore reads scale with (instances × misses), not (users × docs).
 *   - Vendor calls scale with (distinct tickers actually used × TTL windows),
 *     not with the 10k-ticker universe.
 *   - Every fetch increments `ticker_usage/{ticker}` (batched, 1 write/min/
 *     ticker max) — the gradually-built record of which stocks are REALLY used,
 *     which the premarket job reads to pre-warm the hot set.
 *
 * BAR STORAGE — one doc per (ticker, resolution family), NOT one doc per bar
 * (the old ohlcv_bars stored ~300k single-bar docs):
 *
 *   stock_bars/{TICKER}_1min   ← 1H
 *   stock_bars/{TICKER}_5min   ← 1D · 1W   (5 sessions stored, sliced per tf)
 *   stock_bars/{TICKER}_30min  ← 1M        (22 sessions)
 *   stock_bars/{TICKER}_daily  ← 3M · 6M · 1Y · 5Y (widen-in-place)
 *
 * The daily doc carries `rangeDays`: if a user asked for 3M and a later user
 * asks for 1Y, the doc is re-fetched at the wider range and REPLACED (never
 * duplicated); a narrower request is served as a slice of the wider doc with
 * zero vendor calls. That is the subset optimization: 5Y ⊃ 1Y ⊃ 6M ⊃ 3M.
 */

export type BarsTf = "1H" | "1D" | "1W" | "1M" | "3M" | "6M" | "1Y" | "5Y";
type Resolution = "1min" | "5min" | "30min" | "daily";

export const BARS_TFS: BarsTf[] = [
  "1H",
  "1D",
  "1W",
  "1M",
  "3M",
  "6M",
  "1Y",
  "5Y",
];

interface TfSpec {
  resolution: Resolution;
  /** Calendar days to request from the vendor for this resolution family. */
  fetchDays: number;
  /** Bars to return to the client (newest N). */
  sliceBars: number;
}

/** fetchDays covers weekends/holidays so the slice always fills. */
const TF: Record<BarsTf, TfSpec> = {
  "1H": { resolution: "1min", fetchDays: 5, sliceBars: 60 },
  "1D": { resolution: "5min", fetchDays: 9, sliceBars: 78 }, // 1 session ≈ 78 5-min bars
  "1W": { resolution: "5min", fetchDays: 9, sliceBars: 390 }, // 5 sessions
  "1M": { resolution: "30min", fetchDays: 40, sliceBars: 286 }, // 22 sessions × 13 bars
  "3M": { resolution: "daily", fetchDays: 95, sliceBars: 64 },
  "6M": { resolution: "daily", fetchDays: 190, sliceBars: 128 },
  "1Y": { resolution: "daily", fetchDays: 380, sliceBars: 252 },
  "5Y": { resolution: "daily", fetchDays: 1830, sliceBars: 1300 },
};

const RES_PARAMS: Record<
  Resolution,
  { multiplier: number; timespan: "minute" | "hour" | "day" }
> = {
  "1min": { multiplier: 1, timespan: "minute" },
  "5min": { multiplier: 5, timespan: "minute" },
  "30min": { multiplier: 30, timespan: "minute" },
  daily: { multiplier: 1, timespan: "day" },
};

export interface StoredBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number | null;
}

interface BarsDoc {
  ticker: string;
  resolution: Resolution;
  bars: StoredBar[];
  rangeDays: number;
  barCount: number;
  createdAt: string; // ISO — when this data was inserted (the cache clock)
  updatedAt: string;
  source: string;
}

/** Company profile TTL — matches the vendor's own 15-minute delay. */
const COMPANY_TTL_MS = 15 * 60_000;
/** Earnings transcripts change once a quarter — re-check at most daily. */
const TRANSCRIPT_TTL_MS = 24 * 3600_000;
/** Daily bars: at most one vendor refresh per ticker per day. */
const DAILY_TTL_MS = 20 * 3600_000;
/** Intraday bars during the extended session (04:00–20:00 ET weekdays). */
const INTRADAY_SESSION_TTL_MS = 15 * 60_000;
/** Usage counters are flushed to Firestore at most this often. */
const USAGE_FLUSH_MS = 60_000;

// Dividend history / splits / financials change rarely (at most once a
// quarter) — reuse the same daily-cadence TTL as company profiles/bars.
const DIV_HISTORY_LIMIT = 200;
const DIV_ANNUAL_YEARS = 10;
const DIV_CAGR_YEARS = 5;
const FIN_QUARTERS = 10;
const FIN_ANNUAL_YEARS = 8;

// news.job.ts's own cron runs every 30 min; this on-demand path only fills the
// gap for a ticker the bulk sweep hasn't reached recently, so a shorter TTL is
// fine — articles that age out just mean the next request re-checks the vendor.
const NEWS_TTL_MS = 15 * 60_000;
const NEWS_LOOKBACK_DAYS = 2;
const NEWS_ARTICLE_CAP = 5;

const OPTIONS_CONTRACTS_LIMIT = 20;
const OPTIONS_AGG_LOOKBACK_DAYS = 10;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function byPublishedAtDesc(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  return String(b.publishedAt).localeCompare(String(a.publishedAt));
}

/** ET clock parts without a tz library. */
function etParts(now = new Date()): { weekday: number; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "numeric",
  });
  const parts = fmt.formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "12") % 24;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  return { weekday, hour };
}

/** True while US extended trading (pre + regular + after) could move intraday bars. */
function inExtendedSession(): boolean {
  const { weekday, hour } = etParts();
  return weekday >= 1 && weekday <= 5 && hour >= 4 && hour < 20;
}

function isFresh(
  createdAtIso: string | undefined,
  resolution: Resolution,
): boolean {
  if (!createdAtIso) return false;
  const age = Date.now() - Date.parse(createdAtIso);
  if (!Number.isFinite(age) || age < 0) return false;
  if (resolution === "daily") return age < DAILY_TTL_MS;
  // Intraday: refetch every 15 min while a session is running; once the session
  // is over, anything fetched after it ended stays fresh until the next one.
  if (inExtendedSession()) return age < INTRADAY_SESSION_TTL_MS;
  return age < 12 * 3600_000;
}

/**
 * Polygon `dividend_type` codes for NON-regular distributions — special cash
 * (SC), long-term (LT) and short-term (ST) capital-gains distributions. These
 * carry no recurring cadence, so they are excluded from the forward figure.
 */
const SPECIAL_DIVIDEND_TYPES = new Set(["SC", "LT", "ST"]);

/** Subset of a Polygon getDividendHistory() row the forward yield needs. */
interface DivHistItem {
  exDividendDate: string | null;
  cashAmount: number;
  dividendType: string | null;
  frequency: number | null;
}

/**
 * Polygon's `frequency` integer IS a payments-per-year count when it is a real
 * cadence (1 = annual, 2 = semi-annual, 4 = quarterly, 12 = monthly). 0 = one-
 * time and null are not usable cadences → return null so the caller falls back
 * to ex-date spacing. Mirrors the PAYMENTS_PER_YEAR map in sync/dividends.job.ts
 * (which maps the vendor's STRING frequency to the same 1/2/4/12 counts).
 */
function paymentsPerYearFromFrequency(freq: number | null): number | null {
  return freq === 1 || freq === 2 || freq === 4 || freq === 12 ? freq : null;
}

/**
 * Infer payments-per-year from the median spacing of recent (newest-first)
 * regular ex-dates: pick the cadence in {12,4,2,1} whose expected gap 365/n is
 * closest to the observed median gap (~30d→12, ~91d→4, ~182d→2, ~365d→1).
 * Needs at least two ex-dates to form a gap; returns null otherwise.
 */
function paymentsPerYearFromSpacing(regular: DivHistItem[]): number | null {
  const dates = regular
    .map((d) => (d.exDividendDate ? Date.parse(d.exDividendDate) : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a);
  if (dates.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 0; i < dates.length - 1; i++) {
    gaps.push((dates[i] - dates[i + 1]) / 86_400_000);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median =
    gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
  if (!(median > 0)) return null;
  let best: number | null = null;
  let bestErr = Infinity;
  for (const n of [12, 4, 2, 1]) {
    const err = Math.abs(median - 365 / n);
    if (err < bestErr) {
      bestErr = err;
      best = n;
    }
  }
  return best;
}

/**
 * FORWARD-ANNUALIZED dividend per share from a ticker's dividend history
 * (newest-first, as Polygon returns it).
 *
 * perShare = (most-recent REGULAR per-payment amount) × (payments per year).
 *
 * This is the forward run-rate a data vendor quotes — NOT a trailing-12-month
 * SUM. A TTM sum overstates the yield in any rolling 365-day window that happens
 * to contain a 5th ex-date for a quarterly payer (e.g. PEP briefly shows 5
 * payments → ~5.25% instead of the true ~4.27% forward yield).
 *
 * payments-per-year comes from Polygon's own `frequency` integer when it is a
 * usable cadence, else from the median spacing of recent regular ex-dates.
 * Special / one-time distributions are excluded from both the per-payment amount
 * and the spacing. cashAmount is read null-safe (Polygon types it `number` but
 * does not null-coalesce the raw field). Returns null when neither the frequency
 * nor the ex-date spacing determines a cadence — the caller then leaves
 * dividendYield null rather than falling back to a (misleading) TTM sum.
 */
function forwardAnnualDividend(
  history: DivHistItem[],
): { perShare: number; paymentsPerYear: number } | null {
  const regular = history.filter(
    (d) =>
      (d.cashAmount ?? 0) > 0 &&
      d.frequency !== 0 &&
      !(d.dividendType != null && SPECIAL_DIVIDEND_TYPES.has(d.dividendType)),
  );
  if (regular.length === 0) return null;

  // history is newest-first, so the first regular row is the latest payment.
  const perPayment = regular[0].cashAmount ?? 0;
  if (!(perPayment > 0)) return null;

  const paymentsPerYear =
    paymentsPerYearFromFrequency(regular[0].frequency) ??
    paymentsPerYearFromSpacing(regular);
  if (paymentsPerYear == null) return null;

  return { perShare: perPayment * paymentsPerYear, paymentsPerYear };
}

@Injectable()
export class OnDemandService implements OnModuleDestroy {
  private readonly logger = new Logger(OnDemandService.name);

  /** In-memory hot cache: parsed Firestore docs, keyed {TICKER}_{res}. */
  private readonly memBars = new Map<string, BarsDoc>();
  private readonly memCompany = new Map<
    string,
    { data: Record<string, unknown>; at: number }
  >();
  private readonly memDividendHistory = new Map<
    string,
    { data: Record<string, unknown>; at: number }
  >();
  private readonly memSplits = new Map<
    string,
    { data: Record<string, unknown>; at: number }
  >();
  private readonly memFinancials = new Map<
    string,
    { data: Record<string, unknown>; at: number }
  >();
  private readonly memNews = new Map<
    string,
    { data: Record<string, unknown>[]; at: number }
  >();
  private readonly memOptions = new Map<
    string,
    { data: Record<string, unknown>; at: number }
  >();
  private readonly memLogo = new Map<
    string,
    { data: { data: Buffer; contentType: string } | null; at: number }
  >();
  private readonly memTranscript = new Map<
    string,
    { data: Record<string, unknown> | null; at: number }
  >();
  /**
   * Coalescing: concurrent misses for the same key share one vendor promise.
   *
   * SCOPE — this is per-PROCESS only. Two different Cloud Run instances that
   * miss the same ticker at the same moment each run their own fetch: a small,
   * NON-duplicating vendor "mini-storm" (both write the same cache doc; no data
   * is corrupted, just a few redundant calls) that P2-8 asked us to assess.
   *
   * DECISION (P2-8): keep the in-process map; do NOT add a Firestore-lease-based
   * cross-instance coalesce here. Reasoning:
   *   - This is the USER-FACING hot path. A lease means every cache MISS pays a
   *     Firestore transaction round-trip BEFORE fetching, and the LOSER of the
   *     lease then POLLS the cache doc for a result.
   *   - The company build behind a miss is heavy and highly VARIABLE in duration
   *     (getTickerDetails + snapshot + TTM EPS + peers + 13F + a first-sync
   *     technicals pass that pulls ~2y of bars, writes hundreds of ohlcv_bars
   *     docs and ranks against the whole universe — often multiple seconds).
   *     A bounded poll-wait tuned for that is a lose-lose: too short and the
   *     loser fetches anyway (zero benefit), too long and every concurrent
   *     viewer waits seconds on another instance that might still crash mid-run.
   *   - Severity is low (wasteful, not incorrect) and the worker is min-
   *     instances=0 / TTL-spread, so simultaneous cross-instance misses for the
   *     SAME ticker are already rare.
   * The added latency, new failure modes (stale-lease waits) and fail-open
   * plumbing are disproportionate to a low-severity, self-healing inefficiency.
   * If this ever becomes material, revisit with the job-lock.util.ts lease
   * pattern (short TTL, fail-OPEN to a direct fetch, bounded poll of the cache
   * doc) — but only guarding the CHEAP-to-recompute keys, not the heavy company
   * build, and measure the hot-path p95 first.
   */
  private readonly inflight = new Map<string, Promise<unknown>>();

  /** Usage accumulator — flushed as ONE batched write per interval. */
  private pendingUsage = new Map<string, number>();
  private usageTimer: NodeJS.Timeout | null = null;
  private knownUsageTickers: Set<string> | null = null;

  readonly stats = {
    barsRequests: 0,
    barsVendorCalls: 0,
    barsFirestoreHits: 0,
    barsMemHits: 0,
    companyRequests: 0,
    companyVendorCalls: 0,
    usageFlushes: 0,
    lastError: "",
  };

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly polygon: PolygonService,
    @Inject(NEWS_ADAPTER) private readonly news: NewsAdapter,
    // Optional FMP estimates (same adapter the sync job uses). null when
    // EARNINGS_ESTIMATES_SOURCE=none — on-demand then behaves Polygon-only.
    @Inject(EARNINGS_ESTIMATES_ADAPTER)
    private readonly estimatesAdapter: EarningsEstimatesAdapter | null,
    // FMP is the only vendor providing earnings-call transcripts; behaves as a
    // no-op (returns null) when FMP_API_KEY is unset, same as the other FMP paths.
    private readonly fmp: FmpService,
  ) {}

  onModuleDestroy() {
    if (this.usageTimer) clearInterval(this.usageTimer);
    void this.flushUsage();
  }

  // ── Bars ────────────────────────────────────────────────────────────────

  isValidTf(tf: string): tf is BarsTf {
    return (BARS_TFS as string[]).includes(tf);
  }

  /**
   * Bars for one ticker+timeframe, cache-aside. Returns the newest N bars for
   * the timeframe (oldest-first) plus cache metadata for the response headers.
   */
  async getBars(
    ticker: string,
    tf: BarsTf,
  ): Promise<{
    ticker: string;
    tf: BarsTf;
    bars: StoredBar[];
    source: "memory" | "firestore" | "vendor";
    asOf: string;
  }> {
    this.stats.barsRequests++;
    this.recordUsage(ticker);
    const spec = TF[tf];
    const key = `${ticker}_${spec.resolution}`;

    // 1. Per-instance memory (already-parsed doc).
    const mem = this.memBars.get(key);
    if (
      mem &&
      isFresh(mem.createdAt, spec.resolution) &&
      mem.rangeDays >= spec.fetchDays
    ) {
      this.stats.barsMemHits++;
      return {
        ticker,
        tf,
        bars: this.slice(mem, spec),
        source: "memory",
        asOf: mem.createdAt,
      };
    }

    // 2. Firestore shared cache.
    const ref = this.firebase.firestore.collection("stock_bars").doc(key);
    const snap = await ref.get();
    if (snap.exists) {
      const doc = snap.data() as BarsDoc;
      if (
        isFresh(doc.createdAt, spec.resolution) &&
        (doc.rangeDays ?? 0) >= spec.fetchDays
      ) {
        this.memBars.set(key, doc);
        this.stats.barsFirestoreHits++;
        return {
          ticker,
          tf,
          bars: this.slice(doc, spec),
          source: "firestore",
          asOf: doc.createdAt,
        };
      }
      // Wide enough but STALE → INCREMENTAL refresh: history never changes, so
      // fetch only the days since the last stored bar and append. A 5-year doc
      // costs a ~2-day fetch per day of staleness — old data is never re-pulled.
      if ((doc.rangeDays ?? 0) >= spec.fetchDays && doc.bars.length > 0) {
        const fresh = await this.refreshIncremental(
          ticker,
          spec.resolution,
          doc,
          ref,
        );
        return {
          ticker,
          tf,
          bars: this.slice(fresh, spec),
          source: "vendor",
          asOf: fresh.createdAt,
        };
      }
      // Too narrow — a wider window was requested than ever stored. This is the
      // one genuine full fetch (backfill), still a single vendor call.
      const widest = Math.max(spec.fetchDays, doc.rangeDays ?? 0);
      const fresh = await this.fetchAndStore(
        ticker,
        spec.resolution,
        widest,
        ref,
      );
      return {
        ticker,
        tf,
        bars: this.slice(fresh, spec),
        source: "vendor",
        asOf: fresh.createdAt,
      };
    }

    // 3. Vendor (coalesced) — first-ever request for this ticker+resolution.
    const fresh = await this.fetchAndStore(
      ticker,
      spec.resolution,
      spec.fetchDays,
      ref,
    );
    return {
      ticker,
      tf,
      bars: this.slice(fresh, spec),
      source: "vendor",
      asOf: fresh.createdAt,
    };
  }

  /**
   * Append-only refresh of an existing doc: fetch from the last stored bar's
   * date (inclusive — the tail bar may have been partial when captured) to
   * today, replace that tail bar and append the rest. rangeDays is preserved,
   * so a 5Y-widened doc stays 5Y without ever re-downloading 5 years.
   */
  private async refreshIncremental(
    ticker: string,
    resolution: Resolution,
    doc: BarsDoc,
    ref: FirebaseFirestore.DocumentReference,
  ): Promise<BarsDoc> {
    const key = `${ticker}_${resolution}_incr`;
    const existing = this.inflight.get(key) as Promise<BarsDoc> | undefined;
    if (existing) return existing;

    const p = (async (): Promise<BarsDoc> => {
      const { multiplier, timespan } = RES_PARAMS[resolution];
      const lastT = doc.bars[doc.bars.length - 1].t;
      const from = isoDate(new Date(lastT));
      const to = isoDate(new Date());
      this.stats.barsVendorCalls++;
      const raw: PolygonAggBar[] = await this.polygon.getAggsRange(
        ticker,
        from,
        to,
        timespan,
        multiplier,
        50_000,
      );
      const now = new Date().toISOString();
      const kept = doc.bars.filter((b) => b.t < lastT); // drop the possibly-partial tail
      const appended = raw
        .filter((b) => b.t >= lastT)
        .map((b) => ({
          t: b.t,
          o: b.o,
          h: b.h,
          l: b.l,
          c: b.c,
          v: b.v,
          vw: b.vw ?? null,
        }));
      const next: BarsDoc = {
        ...doc,
        bars: [...kept, ...appended],
        barCount: kept.length + appended.length,
        createdAt: now, // the cache clock — this doc is fresh as of now
        updatedAt: now,
      };
      await ref.set(next);
      this.memBars.set(`${ticker}_${resolution}`, next);
      return next;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  private slice(doc: BarsDoc, spec: TfSpec): StoredBar[] {
    return doc.bars.slice(-spec.sliceBars);
  }

  private async fetchAndStore(
    ticker: string,
    resolution: Resolution,
    rangeDays: number,
    ref: FirebaseFirestore.DocumentReference,
  ): Promise<BarsDoc> {
    const key = `${ticker}_${resolution}_${rangeDays}`;
    const existing = this.inflight.get(key) as Promise<BarsDoc> | undefined;
    if (existing) return existing;

    const p = (async (): Promise<BarsDoc> => {
      const { multiplier, timespan } = RES_PARAMS[resolution];
      const to = new Date();
      const from = new Date(to.getTime() - rangeDays * 86_400_000);
      this.stats.barsVendorCalls++;
      const raw: PolygonAggBar[] = await this.polygon.getAggsRange(
        ticker,
        isoDate(from),
        isoDate(to),
        timespan,
        multiplier,
        50_000,
      );
      const now = new Date().toISOString();
      const doc: BarsDoc = {
        ticker,
        resolution,
        bars: raw.map((b) => ({
          t: b.t,
          o: b.o,
          h: b.h,
          l: b.l,
          c: b.c,
          v: b.v,
          vw: b.vw ?? null,
        })),
        rangeDays,
        barCount: raw.length,
        createdAt: now,
        updatedAt: now,
        source: "polygon-ondemand",
      };
      // Replace (not merge): the doc IS the series; merging would append noise.
      await ref.set(doc);
      this.memBars.set(`${ticker}_${resolution}`, doc);
      return doc;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  // ── Company profile ─────────────────────────────────────────────────────

  /**
   * Company profile + latest price, cache-aside on `companies/{ticker}`.
   * Written with merge:true so the richer fields the premarket technicals job
   * adds for hot tickers are never clobbered by an on-demand refresh.
   *
   * Populates the SAME fundamental fields the daily `companies` sync job's
   * profile adapter writes — peRatio, eps, dividendYield, dividendPerShare,
   * peers, industry, and the SIC-derived sector — so a ticker first seen here
   * (the stock screen reads P/E, yield, peers etc. off this doc) shows them
   * immediately instead of a NotAvailable gap until the sync cursor arrives.
   * peRatio/yield are computed against the FRESH snapshot price, not stale bars.
   */
  /**
   * Compute the technical field set the stock detail page reads (RSI/MACD/
   * Stoch/ADX, beta, MA ladder, rolling 52-week range, pivot key levels) for a
   * ticker being synced for the FIRST time, using the SAME computeIndicators()
   * the nightly technical-indicators cron uses — so the field set is identical
   * on both paths.
   *
   * It also persists the fetched daily bars into ohlcv_bars, which is the
   * substrate the rs-rating and tech-rating crons read. Writing it here means
   * the ticker earns its (universe-relative) RS / tech-rating percentile on the
   * very next cron run. Those two ratings are the one thing this path cannot
   * fill inline: a percentile is defined against the whole universe, not one
   * ticker.
   *
   * Best-effort: any failure returns {} so the caller's company doc still saves
   * with its profile + price rather than being lost to a bar hiccup.
   */
  private async computeFirstSyncTechnicals(
    ticker: string,
    rank: boolean,
  ): Promise<Record<string, unknown>> {
    // Below this many stored raw scores the universe distribution is too thin to
    // rank against (the brief window right after deploy, before any sweep has
    // stored raw scores). Fall back to leaving RS/tech null for the cron then.
    const MIN_RANK_DISTRIBUTION = 20;
    try {
      // ~2 trading years so sma200 and the rolling 52-week window are well
      // covered (the cron analyses the most-recent 300 bars; match that depth).
      const to = new Date();
      const from = new Date();
      from.setUTCFullYear(from.getUTCFullYear() - 2);
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const raw = await this.polygon.getAggsRange(ticker, iso(from), iso(to));
      if (raw.length === 0) return {};

      const bars: IndicatorBar[] = raw.map((b) => ({
        barDate: new Date(b.t).toISOString().slice(0, 10),
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
        vwap: b.vw ?? null,
      }));

      // Persist to ohlcv_bars (same doc shape stock-history.job writes) so the
      // RS / tech-rating crons can rank this ticker next run. Chunked to stay
      // under Firestore's 500-write batch ceiling.
      const col = this.firebase.firestore.collection("ohlcv_bars");
      for (let i = 0; i < bars.length; i += 450) {
        const batch = this.firebase.firestore.batch();
        for (const b of bars.slice(i, i + 450)) {
          batch.set(
            col.doc(`${ticker}_${b.barDate}`),
            {
              ticker,
              barDate: b.barDate,
              timespan: "day",
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
              volume: b.volume,
              vwap: b.vwap,
              source: "polygon-ondemand",
            },
            { merge: false },
          );
        }
        await batch.commit();
      }

      // SPY closes for beta — the benchmark the cron uses, always synced.
      const spySnap = await col
        .where("ticker", "==", "SPY")
        .orderBy("barDate", "desc")
        .limit(300)
        .get();
      const spyMap = new Map<string, number>();
      for (const d of spySnap.docs) {
        const x = d.data();
        if (typeof x.close === "number")
          spyMap.set(x.barDate as string, x.close);
      }

      const ind = computeIndicators(bars.slice(-300), spyMap);
      if (!ind) return {};

      const closes = bars.map((b) => b.close);
      const result: Record<string, unknown> = {
        ...ind,
        technicalsUpdatedAt: new Date().toISOString(),
      };

      // Raw RS score + tech components (same windows the sweeps read), stored on
      // the doc so future rankings can place other tickers against this one too.
      const rsScore = computeRsScore(closes.slice(-260));
      const techComp = computeTechComponents(closes.slice(-130));
      if (rsScore != null) result.rsScore = rsScore;
      if (techComp) {
        result.techMomentum = techComp.momentum;
        result.techTrend = techComp.trend;
        result.techRsi = techComp.rsi;
      }

      // For a brand-new ticker (no cron rating yet) rank it against the stored
      // universe distribution so RS / tech rating show on the FIRST view. Skipped
      // for tickers that already carry a cron rating — the sweep's universe-wide
      // rank is authoritative — and while the distribution is too thin to trust.
      if (rank && (rsScore != null || techComp)) {
        try {
          const dist = await this.firebase.firestore
            .collection("companies")
            .select("rsScore", "techMomentum", "techTrend", "techRsi")
            .get();
          const rsScores: number[] = [];
          const techComps: TechComponents[] = [];
          for (const d of dist.docs) {
            if (d.id === ticker) continue;
            const x = d.data();
            if (typeof x.rsScore === "number") rsScores.push(x.rsScore);
            if (
              typeof x.techMomentum === "number" &&
              typeof x.techTrend === "number" &&
              typeof x.techRsi === "number"
            ) {
              techComps.push({
                momentum: x.techMomentum,
                trend: x.techTrend,
                rsi: x.techRsi,
              });
            }
          }
          if (rsScore != null && rsScores.length >= MIN_RANK_DISTRIBUTION) {
            result.rsRating = rsPercentile(rsScore, rsScores);
            result.rsRatingUpdatedAt = new Date().toISOString();
          }
          if (techComp && techComps.length >= MIN_RANK_DISTRIBUTION) {
            result.techRating = techRatingFromComponents(techComp, techComps);
            result.techRatingUpdatedAt = new Date().toISOString();
          }
        } catch (e) {
          this.logger.warn(
            `on-demand rank failed for ${ticker}: ${(e as Error).message}`,
          );
        }
      }

      return result;
    } catch (e) {
      this.logger.warn(
        `first-sync technicals failed for ${ticker}: ${(e as Error).message}`,
      );
      return {};
    }
  }

  async getCompany(ticker: string): Promise<Record<string, unknown> | null> {
    this.stats.companyRequests++;
    this.recordUsage(ticker);

    const mem = this.memCompany.get(ticker);
    if (mem && Date.now() - mem.at < 5 * 60_000) return mem.data;

    const ref = this.firebase.firestore.collection("companies").doc(ticker);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      const created =
        typeof data.createdAt === "string" ? Date.parse(data.createdAt) : NaN;
      // 'description'/'instOwnershipPct' in data → the doc was written by a build
      // that includes the profile blurb and the 13F institutional rollup; older
      // docs lack these keys, so fall through to a refetch to backfill them
      // rather than serving a stale doc missing those fields.
      if (
        Number.isFinite(created) &&
        Date.now() - created < COMPANY_TTL_MS &&
        data.price != null &&
        "description" in data &&
        "instOwnershipPct" in data &&
        "epsTtm" in data
      ) {
        this.memCompany.set(ticker, { data, at: Date.now() });
        return data;
      }
    }

    const key = `company_${ticker}`;
    const existing = this.inflight.get(key) as
      Promise<Record<string, unknown> | null> | undefined;
    if (existing) return existing;

    // Rank RS / tech on-demand only for a ticker that has no cron rating yet.
    // For one the sweep already ranked, its universe-wide percentile is
    // authoritative — merge:true preserves it rather than overwriting with an
    // on-demand approximation.
    const hadRating =
      snap.exists && (snap.data() as Record<string, unknown>).rsRating != null;

    const p = (async () => {
      this.stats.companyVendorCalls++;
      let details: Record<string, unknown> | null = null;
      try {
        details = await this.polygon.getTickerDetails(ticker);
      } catch {
        details = null; // unknown ticker — still try the snapshot
      }
      const quotes = await this.polygon
        .getUniversalSnapshot([ticker])
        .catch(() => []);
      const q = quotes[0] as Record<string, unknown> | undefined;
      if (!details && !q) return null;

      const price = (q?.price as number | undefined) ?? null;

      // Fundamentals the daily sync job's profile adapter also computes, fetched
      // here so this doc is not missing peRatio/eps/yield/peers until the cron
      // cursor reaches the ticker. Each is independent and best-effort: a failed
      // or empty one degrades to null (same as the adapter's per-field try/catch)
      // rather than dropping the whole company doc. Parallel to keep latency low.
      const [epsRes, peersRes, divRes, techRes, instRes, epsHistRes] =
        await Promise.allSettled([
          this.polygon.getTtmEps(ticker),
          this.polygon.getRelatedCompanies(ticker),
          this.polygon.getDividendHistory(ticker, 40),
          // First-time technicals (RSI/MACD/Stoch/ADX, beta, MA ladder, 52-week
          // range, key levels) so the detail page isn't a wall of N/A until the
          // nightly cron reaches this ticker. Runs alongside the other fetches so
          // it adds max(), not sum(), to latency. Best-effort — returns {} on any
          // failure so the company doc still saves with profile + price.
          this.computeFirstSyncTechnicals(ticker, !hadRating),
          // FMP 13F institutional-ownership rollup (Inst. ownership % + holder
          // count for the detail page's Institutional card). Best-effort — null
          // for names FMP has no 13F rollup for. Short interest stays absent:
          // Polygon 404s on it and FMP's stable API has no product.
          this.fmp.getLatestInstitutionalOwnership(ticker),
          // FMP reported EPS history → non-GAAP TTM EPS for a NASDAQ/IBD-basis
          // P/E, instead of Polygon's GAAP TTM. Best-effort, [] when FMP is off.
          this.estimatesAdapter
            ? this.estimatesAdapter.getEpsHistory(ticker).catch(
                () =>
                  [] as Array<{
                    date: string;
                    epsActual: number | null;
                    epsEstimate: number | null;
                  }>,
              )
            : Promise.resolve(
                [] as Array<{
                  date: string;
                  epsActual: number | null;
                  epsEstimate: number | null;
                }>,
              ),
        ]);

      const gaapTtm = epsRes.status === "fulfilled" ? epsRes.value : null;
      const epsTtmReported = ttmReportedEpsFromRows(
        epsHistRes.status === "fulfilled" ? epsHistRes.value : [],
      );
      // Prefer the non-GAAP TTM (matches NASDAQ/IBD); GAAP is the fallback.
      const eps = epsTtmReported ?? gaapTtm;
      const peRatio =
        eps != null && eps > 0 && price != null
          ? Math.round((price / eps) * 100) / 100
          : null;

      const peers =
        peersRes.status === "fulfilled"
          ? peersRes.value.filter((p) => p !== ticker)
          : [];

      const technicals =
        techRes.status === "fulfilled" ? techRes.value : {};

      const inst =
        instRes.status === "fulfilled" ? instRes.value : null;

      // FORWARD-ANNUALIZED dividend per share and yield (Polygon sells no yield
      // product). Methodology: (most-recent REGULAR per-payment amount) ×
      // (payments-per-year for the payer's cadence) ÷ price. This is the forward
      // run-rate a vendor quotes; unlike a trailing-12-month SUM it does NOT
      // overstate the yield when a rolling 365-day window happens to contain a
      // 5th quarterly ex-date (PEP: ~5.25% TTM vs the true ~4.27% forward).
      // Specials/one-time distributions are excluded; cadence that can't be
      // determined → null (NOT a TTM fallback). cashAmount read is null-safe.
      let dividendPerShare: number | null = null;
      let dividendYield: number | null = null;
      if (divRes.status === "fulfilled") {
        const fwd = forwardAnnualDividend(divRes.value);
        if (fwd) {
          // dividendPerShare stays the forward ANNUAL figure (consistent basis).
          dividendPerShare = Math.round(fwd.perShare * 10000) / 10000;
          if (price != null && price > 0) {
            dividendYield = Math.round((fwd.perShare / price) * 10000) / 100;
          }
        }
      }

      const now = new Date().toISOString();
      // Nightly fundamentals-growth writes epsGrowthYoY / revenueGrowthYoY /
      // grossMargin to the company doc; this on-demand rebuild doesn't recompute
      // them, so carry them forward (else the returned doc — the stock-detail's
      // source — would drop them even though Firestore keeps them via merge).
      const prevCo = snap.exists
        ? (snap.data() as Record<string, unknown>)
        : {};
      const doc: Record<string, unknown> = {
        ticker,
        // getTickerDetails failed (null) but the snapshot succeeded → keep the
        // prior good name rather than overwriting it with the bare ticker.
        name: details?.name ?? (prevCo.name as string | undefined) ?? ticker,
        // Profile fields come ONLY from getTickerDetails. When that call failed
        // (details === null) these are OMITTED so the merge:true write preserves
        // the prior good values, instead of nulling description/homepageUrl/
        // sector/industry/marketCap/exchange on a transient details outage.
        ...(details
          ? {
              description: details.description ?? null,
              homepageUrl: details.homepage_url ?? null,
              // sic_description is an INDUSTRY ("ELECTRONIC COMPUTERS"), not a
              // sector — deriving the sector from sic_code (null when unmappable)
              // matches the sync job so sectorRank grouping and the `sectors`
              // join stay correct.
              sector: sectorFromSic(
                details.sic_code as string | number | null | undefined,
              ),
              industry: details.sic_description ?? null,
              marketCap: details.market_cap ?? null,
              exchange: details.primary_exchange ?? null,
            }
          : {}),
        price,
        pctChange: q?.changePercent ?? null,
        prevClose: q?.previousClose ?? null,
        volume: q?.volume ?? null,
        peRatio,
        eps,
        epsTtm: epsTtmReported,
        // Carried from the nightly fundamentals-growth write (non-GAAP basis).
        epsGrowthYoY: (prevCo.epsGrowthYoY as number | null | undefined) ?? null,
        revenueGrowthYoY:
          (prevCo.revenueGrowthYoY as number | null | undefined) ?? null,
        grossMargin: (prevCo.grossMargin as number | null | undefined) ?? null,
        dividendYield,
        dividendPerShare,
        peers,
        // FMP 13F institutional-ownership rollup (Institutional card). Null for
        // names with no 13F filers (small / recently-listed / non-US).
        instOwnershipPct: inst?.ownershipPercent ?? null,
        inst13FHolders: inst?.investorsHolding ?? null,
        inst13FHoldersChange: inst?.investorsHoldingChange ?? null,
        inst13FShares: inst?.numberOf13Fshares ?? null,
        inst13FSharesChange: inst?.numberOf13FsharesChange ?? null,
        instTotalInvested: inst?.totalInvested ?? null,
        instPutCallRatio: inst?.putCallRatio ?? null,
        instAsOf:
          inst && inst.year != null && inst.quarter != null
            ? `Q${inst.quarter} ${inst.year}`
            : null,
        // Technical field set computed above (empty object when history is thin
        // or the fetch failed). Spread last so a real technicals result fills
        // rsi14/macd/beta/high52/keyLevels/... the same way the cron would.
        ...technicals,
        createdAt: now,
        updatedAt: now,
        source: "polygon-ondemand",
      };
      await ref.set(doc, { merge: true });
      this.memCompany.set(ticker, { data: doc, at: Date.now() });
      return doc;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  /**
   * Lightweight multi-ticker quotes (price + %change) in ONE Polygon
   * universal-snapshot call. Used to price peer tickers that aren't in the
   * synced companies universe, so the peers list can show every ticker Polygon
   * returned, on demand — no per-ticker company fetch needed.
   */
  async getQuotes(tickers: string[]): Promise<
    Array<{
      ticker: string;
      name: string | null;
      price: number | null;
      pctChange: number | null;
    }>
  > {
    const syms = [
      ...new Set(tickers.map((t) => t.toUpperCase().trim()).filter(Boolean)),
    ].slice(0, 25);
    if (syms.length === 0) return [];
    syms.forEach((t) => this.recordUsage(t));
    const snaps = await this.polygon.getUniversalSnapshot(syms).catch(() => []);
    return (snaps as Array<Record<string, unknown>>).map((s) => ({
      ticker: String(s.ticker),
      name: (s.name as string) ?? null,
      price: (s.price as number) ?? null,
      pctChange: (s.changePercent as number) ?? null,
    }));
  }

  // ── Company logo (Polygon branding, proxied) ────────────────────────────

  /**
   * Company logo bytes from Polygon's ticker `branding`, proxied server-side so
   * the API key never reaches the browser. In-memory cached (including "no
   * logo" as a null result) for a day so a logo-heavy grid doesn't re-hit
   * Polygon; the endpoint also sets a long edge/browser Cache-Control. Returns
   * null when Polygon has no branding for the ticker (caller → letter tile).
   */
  async getLogo(
    ticker: string,
  ): Promise<{ data: Buffer; contentType: string } | null> {
    const mem = this.memLogo.get(ticker);
    if (mem && Date.now() - mem.at < 24 * 60 * 60_000) return mem.data;
    this.recordUsage(ticker);
    const img = await this.polygon.getBrandingImage(ticker).catch(() => null);
    this.memLogo.set(ticker, { data: img, at: Date.now() });
    return img;
  }

  // ── Dividend history ────────────────────────────────────────────────────

  /**
   * Per-ticker dividend history, cache-aside on `dividend_history/{ticker}` —
   * the same collection/doc shape `corporate-actions.job.ts`'s bulk cursor
   * sweep writes, so a ticker the sweep hasn't reached yet gets its doc
   * created here on first request instead of waiting for the cron to arrive.
   */
  async getDividendHistory(
    ticker: string,
  ): Promise<Record<string, unknown> | null> {
    const mem = this.memDividendHistory.get(ticker);
    if (mem && Date.now() - mem.at < 5 * 60_000) return mem.data;

    const ref = this.firebase.firestore
      .collection("dividend_history")
      .doc(ticker);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      const created =
        typeof data.createdAt === "string" ? Date.parse(data.createdAt) : NaN;
      if (Number.isFinite(created) && Date.now() - created < DAILY_TTL_MS) {
        this.memDividendHistory.set(ticker, { data, at: Date.now() });
        return data;
      }
    }

    const key = `dividend_history_${ticker}`;
    const existing = this.inflight.get(key) as
      Promise<Record<string, unknown> | null> | undefined;
    if (existing) return existing;

    const p = (async () => {
      const history = await this.polygon.getDividendHistory(
        ticker,
        DIV_HISTORY_LIMIT,
      );
      const totals = annualTotals(history);
      const cutoff = new Date();
      cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
      const cutoffIso = cutoff.toISOString().slice(0, 10);
      const ttm = history.filter(
        (d) => d.exDividendDate != null && d.exDividendDate >= cutoffIso,
      );
      const ttmTotal = ttm.reduce((s, d) => s + (d.cashAmount ?? 0), 0);
      const company: Record<string, unknown> | null = await this.getCompany(
        ticker,
      ).catch(() => null);
      const price: number | null =
        (company?.price as number | undefined) ?? null;

      const now = new Date().toISOString();
      const doc: Record<string, unknown> = {
        ticker,
        history: history.map((d) => ({
          exDividendDate: d.exDividendDate,
          paymentDate: d.paymentDate,
          declarationDate: d.declarationDate,
          recordDate: d.recordDate,
          amount: d.cashAmount,
          dividendType: d.dividendType,
          frequency: d.frequency,
        })),
        annualTotals: totals.slice(0, DIV_ANNUAL_YEARS),
        ttmTotal: ttm.length > 0 ? Math.round(ttmTotal * 10000) / 10000 : null,
        ttmPayments: ttm.length,
        yieldPct:
          price != null && ttm.length > 0
            ? Math.round((ttmTotal / price) * 10000) / 100
            : null,
        yieldBasisPrice: price,
        cagr5yPct: dividendCagr(totals, DIV_CAGR_YEARS),
        increaseStreakYears: increaseStreak(totals),
        frequency: history[0]?.frequency ?? null,
        isPayer: history.length > 0,
        source: "polygon-ondemand",
        createdAt: now,
        updatedAt: now,
      };
      await ref.set(doc);
      this.memDividendHistory.set(ticker, { data: doc, at: Date.now() });
      return doc;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  // ── Splits ──────────────────────────────────────────────────────────────

  /** Per-ticker split history, cache-aside on `splits/{ticker}` (same shape corporate-actions.job.ts writes). */
  async getSplits(ticker: string): Promise<Record<string, unknown> | null> {
    const mem = this.memSplits.get(ticker);
    if (mem && Date.now() - mem.at < 5 * 60_000) return mem.data;

    const ref = this.firebase.firestore.collection("splits").doc(ticker);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      const created =
        typeof data.createdAt === "string" ? Date.parse(data.createdAt) : NaN;
      if (Number.isFinite(created) && Date.now() - created < DAILY_TTL_MS) {
        this.memSplits.set(ticker, { data, at: Date.now() });
        return data;
      }
    }

    const key = `splits_${ticker}`;
    const existing = this.inflight.get(key) as
      Promise<Record<string, unknown> | null> | undefined;
    if (existing) return existing;

    const p = (async () => {
      const splits = await this.polygon.getSplits(ticker);
      const now = new Date().toISOString();
      const doc: Record<string, unknown> = {
        ticker,
        splits,
        latestSplit: splits[0] ?? null,
        source: "polygon-ondemand",
        createdAt: now,
        updatedAt: now,
      };
      await ref.set(doc);
      this.memSplits.set(ticker, { data: doc, at: Date.now() });
      return doc;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  // ── Financials ──────────────────────────────────────────────────────────

  /**
   * Per-ticker quarterly+annual financials, cache-aside on `financials/{ticker}`
   * (same shape financials.job.ts's bulk cursor sweep writes). EPS estimates are
   * matched against synced `earnings_events` only — Polygon carries no forward
   * EPS estimates, so the estimate line degrades where none exists.
   */
  async getFinancials(ticker: string): Promise<Record<string, unknown> | null> {
    const mem = this.memFinancials.get(ticker);
    if (mem && Date.now() - mem.at < 5 * 60_000) return mem.data;

    const ref = this.firebase.firestore.collection("financials").doc(ticker);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      const created =
        typeof data.createdAt === "string" ? Date.parse(data.createdAt) : NaN;
      if (Number.isFinite(created) && Date.now() - created < DAILY_TTL_MS) {
        this.memFinancials.set(ticker, { data, at: Date.now() });
        return data;
      }
    }

    const key = `financials_${ticker}`;
    const existing = this.inflight.get(key) as
      Promise<Record<string, unknown> | null> | undefined;
    if (existing) return existing;

    const p = (async () => {
      // The bulk sync job (financials.job.ts) is the ONLY writer that fetches the
      // FMP forward `annualEstimates` and full-history quarterly epsEstimate. This
      // on-demand refresh overwrites the whole doc, so it must carry those forward
      // or every ticker view would wipe them (Polygon has no forward estimates).
      const prev = snap.exists
        ? (snap.data() as {
            annualEstimates?: unknown[];
            quarters?: Array<{
              endDate?: string;
              epsEstimate?: number | null;
              epsActualReported?: number | null;
              epsEstimateReported?: number | null;
            }>;
          })
        : undefined;
      const prevEpsByEnd = new Map(
        (prev?.quarters ?? []).map((q) => [q.endDate, q.epsEstimate]),
      );
      const prevActualByEnd = new Map(
        (prev?.quarters ?? []).map((q) => [q.endDate, q.epsActualReported ?? null]),
      );
      const prevEstReportedByEnd = new Map(
        (prev?.quarters ?? []).map((q) => [q.endDate, q.epsEstimateReported ?? null]),
      );

      // FMP estimates fetched HERE (not only in the sync job) so any ticker a
      // user opens gets forward `annualEstimates` + full-history quarterly
      // epsEstimate immediately — coverage no longer depends on the sync cursor
      // having already reached this ticker. earnings_events + the prior doc are
      // fallbacks so a transient FMP miss never downgrades what we already had.
      const [rows, estimates, fmpAnnual, fmpQ, splits, rawEpsHist] =
        await Promise.all([
          this.polygon.getFinancialStatements(ticker, "quarterly", FIN_QUARTERS),
          this.earningsEstimatesFor(ticker),
          this.estimatesAdapter
            ? this.estimatesAdapter
                .getForwardAnnual(ticker)
                .catch(() => [] as unknown[])
            : Promise.resolve([] as unknown[]),
          this.estimatesAdapter
            ? this.estimatesAdapter
                .getQuarterlyEstimates(ticker)
                .catch(() => null)
            : Promise.resolve(null),
          this.polygon.getSplits(ticker).catch(() => [] as SplitEvent[]),
          this.estimatesAdapter
            ? this.estimatesAdapter
                .getEpsHistory(ticker)
                .catch(
                  () =>
                    [] as Array<{
                      date: string;
                      epsActual: number | null;
                      epsEstimate: number | null;
                    }>,
                )
            : Promise.resolve(
                [] as Array<{
                  date: string;
                  epsActual: number | null;
                  epsEstimate: number | null;
                }>,
              ),
        ]);
      const quarters = rows.map((r) => {
        const fmpActual = fmpQ?.epsActualFor(r.endDate) ?? null;
        const fmpEstimate = alignReportedEstimate(
          r.filingDate ?? r.endDate,
          splits,
          fmpActual,
          fmpQ?.epsEstimateFor(r.endDate) ?? null,
        );
        return mapQuarterRow(
          r,
          fmpEstimate ??
            this.matchEpsEstimate(estimates, r.endDate) ??
            prevEpsByEnd.get(r.endDate) ??
            null,
          fmpActual ?? prevActualByEnd.get(r.endDate) ?? null,
          fmpEstimate ??
            (fmpActual == null
              ? (prevEstReportedByEnd.get(r.endDate) ?? null)
              : null),
        );
      });

      let annual: ReturnType<typeof mapAnnualRow>[] = [];
      try {
        const yr = await this.polygon.getFinancialStatements(
          ticker,
          "annual",
          FIN_ANNUAL_YEARS,
        );
        annual = yr.map(mapAnnualRow);
      } catch {
        // Annual is a secondary tab — a failure there shouldn't block quarterly data.
      }
      // Preserve the prior annual series when the fresh fetch is empty (failure
      // above or a non-throwing empty response). This doc is written with a full
      // ref.set() (no merge), so an empty [] would drop a good stored annual —
      // reuse prev like annualEstimates/epsHistory do.
      const prevAnnual = (prev as { annual?: ReturnType<typeof mapAnnualRow>[] })
        ?.annual;
      if (annual.length === 0 && Array.isArray(prevAnnual)) {
        annual = prevAnnual;
      }

      // Deep FMP quarterly EPS history → annual EPS (sum by fiscal year). Keep
      // the prior one if FMP returned empty so a transient miss never wipes it.
      let epsHistory: EpsHistoryRow[] = buildEpsHistory(rawEpsHist, quarters, splits);
      const prevEpsHistory = (prev as { epsHistory?: EpsHistoryRow[] })?.epsHistory;
      if (epsHistory.length === 0 && Array.isArray(prevEpsHistory)) {
        epsHistory = prevEpsHistory;
      }

      const now = new Date().toISOString();
      const doc: Record<string, unknown> = {
        ticker,
        quarters,
        annual,
        epsHistory,
        // Freshly-fetched FMP forward estimates; fall back to the prior doc's
        // when FMP returns nothing this refresh so a transient miss never wipes.
        annualEstimates:
          fmpAnnual.length > 0
            ? fmpAnnual
            : Array.isArray(prev?.annualEstimates)
              ? prev.annualEstimates
              : [],
        source: "polygon-ondemand",
        createdAt: now,
        updatedAt: now,
      };
      await ref.set(doc);
      this.memFinancials.set(ticker, { data: doc, at: Date.now() });
      return doc;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  /** Raw {reportDate, epsEstimate} pairs for one ticker's synced earnings_events. */
  private async earningsEstimatesFor(
    ticker: string,
  ): Promise<Array<{ date: string; epsEstimate: number }>> {
    const snap = await this.firebase.firestore
      .collection("earnings_events")
      .where("ticker", "==", ticker)
      .get();
    const out: Array<{ date: string; epsEstimate: number }> = [];
    for (const d of snap.docs) {
      const data = d.data();
      if (data.epsEstimate != null && data.date)
        out.push({ date: data.date, epsEstimate: data.epsEstimate });
    }
    return out;
  }

  /**
   * Nearest estimate to a quarter's period-end date, within a ~90-day window
   * (report date follows fiscal period end by weeks) — mirrors
   * FinancialsJob.matchEstimate(), scoped to one ticker's estimates already.
   */
  private matchEpsEstimate(
    estimates: Array<{ date: string; epsEstimate: number }>,
    endDate: string | null,
  ): number | null {
    if (!endDate) return null;
    const target = new Date(`${endDate}T00:00:00Z`).getTime();
    let best: { v: number; gap: number } | null = null;
    for (const e of estimates) {
      const gap =
        Math.abs(new Date(`${e.date}T00:00:00Z`).getTime() - target) /
        86_400_000;
      if (gap <= 90 && (!best || gap < best.gap))
        best = { v: e.epsEstimate, gap };
    }
    return best?.v ?? null;
  }

  // ── Per-ticker news ─────────────────────────────────────────────────────

  /**
   * Per-ticker news, cache-aside on the SAME `news` collection news.job.ts's
   * bulk sweep already writes to (doc id `${ticker}_${articleId}`) — this only
   * fills the gap for a ticker the sweep hasn't reached recently. No `where`
   * + `orderBy` combination is used (no composite index is deployed for
   * `news`): freshness is judged from each doc's own `updatedAt`, and results
   * are sorted by `publishedAt` in memory rather than in the query.
   */
  async getNews(ticker: string): Promise<Record<string, unknown>[]> {
    const mem = this.memNews.get(ticker);
    if (mem && Date.now() - mem.at < 5 * 60_000) return mem.data;

    const snap = await this.firebase.firestore
      .collection("news")
      .where("ticker", "==", ticker)
      .get();
    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() })) as Array<Record<string, unknown>>;
    const freshestUpdate = docs.reduce((max, d) => {
      const t = typeof d.updatedAt === "string" ? Date.parse(d.updatedAt) : NaN;
      return Number.isFinite(t) ? Math.max(max, t) : max;
    }, 0);

    if (docs.length > 0 && Date.now() - freshestUpdate < NEWS_TTL_MS) {
      const sorted = [...docs].sort(byPublishedAtDesc);
      this.memNews.set(ticker, { data: sorted, at: Date.now() });
      return sorted;
    }

    const key = `news_${ticker}`;
    const existing = this.inflight.get(key) as
      Promise<Record<string, unknown>[]> | undefined;
    if (existing) return existing;

    const p = (async () => {
      const to = new Date();
      const from = new Date(to.getTime() - NEWS_LOOKBACK_DAYS * 86_400_000);
      const isoDate = (d: Date) => d.toISOString().slice(0, 10);
      const result = await this.news.fetchNews(
        ticker,
        isoDate(from),
        isoDate(to),
      );
      const now = new Date().toISOString();
      const articles = result.data.slice(0, NEWS_ARTICLE_CAP).map((a) => {
        const docId = `${ticker}_${a.id}`;
        return {
          docId,
          // Same field set news.job.ts's bulk sweep writes — no `id` field,
          // since the doc id itself carries it (added back on read below).
          data: {
            ticker: a.ticker,
            headline: a.headline,
            summary: a.summary,
            source: a.source,
            // Vendor badge parity with news.job.ts's bulk sweep — the stock
            // screen renders a Polygon/FMP pill off this field, so the
            // on-demand cache-fill must carry it too or the pill never shows.
            vendor: a.vendor,
            url: a.url,
            category: a.category,
            sentiment: a.sentiment,
            sentimentReasoning: a.sentimentReasoning,
            keywords: a.keywords,
            imageUrl: a.imageUrl,
            publishedAt: a.publishedAt,
            updatedAt: now,
          },
        };
      });
      if (articles.length > 0) {
        const batch = this.firebase.firestore.batch();
        for (const a of articles) {
          batch.set(
            this.firebase.firestore.collection("news").doc(a.docId),
            a.data,
            { merge: true },
          );
        }
        await batch.commit();
      }
      const sorted = articles
        .map((a) => ({ id: a.docId, ...a.data }))
        .sort((a, b) =>
          String(b.publishedAt).localeCompare(String(a.publishedAt)),
        );
      this.memNews.set(ticker, { data: sorted, at: Date.now() });
      return sorted;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  // ── Options chain (curated 8-ticker universe) ──────────────────────────

  /**
   * Per-ticker options chain, cache-aside on `options_chains/{ticker}` — the
   * same collection/doc shape `options-chains.job.ts`'s bulk sweep already
   * writes (strikes/expirations/OHLCV are real via Polygon; bid/ask, IV,
   * greeks and open interest are NOT_AUTHORIZED on the current Polygon plan
   * regardless of path — see that job's `note` field). Callers (the
   * controller) are expected to reject tickers outside `OPTIONS_UNIVERSE`
   * before calling this — it's a curated set, not an open one like bars/
   * company/dividends.
   */
  async getOptionsChain(
    ticker: string,
  ): Promise<Record<string, unknown> | null> {
    const mem = this.memOptions.get(ticker);
    if (mem && Date.now() - mem.at < 5 * 60_000) return mem.data;

    const ref = this.firebase.firestore
      .collection("options_chains")
      .doc(ticker);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      const created =
        typeof data.createdAt === "string" ? Date.parse(data.createdAt) : NaN;
      if (Number.isFinite(created) && Date.now() - created < DAILY_TTL_MS) {
        this.memOptions.set(ticker, { data, at: Date.now() });
        return data;
      }
    }

    const key = `options_${ticker}`;
    const existing = this.inflight.get(key) as
      Promise<Record<string, unknown> | null> | undefined;
    if (existing) return existing;

    const p = (async () => {
      const today = isoDate(new Date());
      const lookback = new Date();
      lookback.setUTCDate(lookback.getUTCDate() - OPTIONS_AGG_LOOKBACK_DAYS);
      const from = isoDate(lookback);

      const contracts = await this.polygon.getOptionContracts(
        ticker,
        today,
        OPTIONS_CONTRACTS_LIMIT,
      );
      const enriched: Record<string, unknown>[] = [];
      for (const c of contracts) {
        try {
          const bar = await this.polygon.getOptionLatestBar(
            c.ticker,
            from,
            today,
          );
          enriched.push({
            contractTicker: c.ticker,
            contractType: c.contract_type,
            strike: c.strike_price,
            expirationDate: c.expiration_date,
            exerciseStyle: c.exercise_style ?? null,
            sharesPerContract: c.shares_per_contract ?? null,
            lastOpen: bar?.o ?? null,
            lastHigh: bar?.h ?? null,
            lastLow: bar?.l ?? null,
            lastClose: bar?.c ?? null,
            lastVwap: bar?.vw ?? null,
            lastVolume: bar?.v ?? null,
            lastTradeCount: bar?.n ?? null,
            lastBarDate: bar ? isoDate(new Date(bar.t)) : null,
            lastRangePct:
              bar && bar.o > 0
                ? Math.round(((bar.h - bar.l) / bar.o) * 10000) / 100
                : null,
          });
        } catch (err) {
          this.logger.warn(
            `options on-demand: bar fetch failed for ${c.ticker}: ${(err as Error).message}`,
          );
        }
        await sleep(this.polygon.requestDelayMs);
      }

      const now = new Date().toISOString();
      const doc = {
        underlyingTicker: ticker,
        contracts: enriched,
        source: "polygon-ondemand",
        note: "Strikes, expirations and per-contract OHLCV/VWAP/volume are real (delayed). Bid/ask, IV, greeks and open interest return NOT_AUTHORIZED on the current Polygon plan — they need the Options add-on.",
        createdAt: now,
        updatedAt: now,
      };
      await ref.set(doc);
      this.memOptions.set(ticker, { data: doc, at: Date.now() });
      return doc;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  // ── Earnings-call transcript (FMP) ──────────────────────────────────────

  /**
   * Latest earnings-call transcript for one ticker, cache-aside on
   * `earnings_transcripts/{ticker}`. FMP is the only vendor that carries
   * transcripts (Polygon has none), so this degrades to null when FMP is off.
   * The `null` result is cached too, so a ticker with no transcript doesn't
   * re-hit FMP on every drawer open until the TTL lapses.
   */
  async getTranscript(ticker: string): Promise<Record<string, unknown> | null> {
    this.recordUsage(ticker);

    const mem = this.memTranscript.get(ticker);
    if (mem && Date.now() - mem.at < 5 * 60_000) return mem.data;

    const ref = this.firebase.firestore
      .collection("earnings_transcripts")
      .doc(ticker);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      const created =
        typeof data.createdAt === "string" ? Date.parse(data.createdAt) : NaN;
      if (Number.isFinite(created) && Date.now() - created < TRANSCRIPT_TTL_MS) {
        this.memTranscript.set(ticker, { data, at: Date.now() });
        return data;
      }
    }

    const key = `transcript_${ticker}`;
    const existing = this.inflight.get(key) as
      Promise<Record<string, unknown> | null> | undefined;
    if (existing) return existing;

    const p = (async () => {
      const tx = await this.fmp.getLatestEarningsTranscript(ticker).catch(() => null);
      const now = new Date().toISOString();
      // Cache the "no transcript" answer as a lightweight doc so repeat opens
      // don't re-run the FMP probe until the TTL lapses.
      const doc: Record<string, unknown> = tx
        ? {
            ticker,
            quarter: tx.quarter,
            year: tx.year,
            date: tx.date,
            content: tx.content,
            hasTranscript: true,
            source: "fmp-ondemand",
            createdAt: now,
            updatedAt: now,
          }
        : {
            ticker,
            hasTranscript: false,
            content: null,
            source: "fmp-ondemand",
            createdAt: now,
            updatedAt: now,
          };
      await ref.set(doc);
      this.memTranscript.set(ticker, { data: doc, at: Date.now() });
      return doc;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  // ── Usage tracking (the "which stocks are really used" collection) ──────

  /** Batched: N hits inside a flush window become ONE increment write. */
  recordUsage(ticker: string): void {
    this.pendingUsage.set(ticker, (this.pendingUsage.get(ticker) ?? 0) + 1);
    if (!this.usageTimer) {
      this.usageTimer = setInterval(
        () => void this.flushUsage(),
        USAGE_FLUSH_MS,
      );
      this.usageTimer.unref?.();
    }
  }

  private async flushUsage(): Promise<void> {
    if (this.pendingUsage.size === 0) return;
    const toFlush = this.pendingUsage;
    this.pendingUsage = new Map();
    try {
      const db = this.firebase.firestore;
      if (!this.knownUsageTickers) {
        const ids = await db.collection("ticker_usage").select().get();
        this.knownUsageTickers = new Set(ids.docs.map((d) => d.id));
      }
      const batch = db.batch();
      const now = new Date().toISOString();
      for (const [ticker, n] of toFlush) {
        const ref = db.collection("ticker_usage").doc(ticker);
        const payload: Record<string, unknown> = {
          ticker,
          count: FieldValue.increment(n),
          lastUsedAt: now,
          updatedAt: now,
        };
        if (!this.knownUsageTickers.has(ticker)) {
          payload.createdAt = now;
          this.knownUsageTickers.add(ticker);
        }
        batch.set(ref, payload, { merge: true });
      }
      await batch.commit();
      this.stats.usageFlushes++;
    } catch (err) {
      this.stats.lastError = `usage flush: ${(err as Error).message}`;
      this.logger.warn(this.stats.lastError);
      // Usage tracking must never break data serving — counts are best-effort.
    }
  }

  /** Hot list for the premarket warm: most-used tickers, most recent first. */
  async hotTickers(limit = 100): Promise<string[]> {
    try {
      const snap = await this.firebase.firestore
        .collection("ticker_usage")
        .orderBy("count", "desc")
        .limit(limit)
        .get();
      return snap.docs.map((d) => d.id);
    } catch (err) {
      this.logger.warn(`hotTickers query failed: ${(err as Error).message}`);
      return [];
    }
  }
}
