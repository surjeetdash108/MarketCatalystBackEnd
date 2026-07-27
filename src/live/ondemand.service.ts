import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { NEWS_ADAPTER, type NewsAdapter } from '../adapters/types';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { annualTotals, dividendCagr, increaseStreak } from '../sync/corporate-actions.job';
import { mapAnnualRow, mapQuarterRow } from '../sync/financials.job';
import { PolygonService, PolygonAggBar } from '../vendors/polygon/polygon.service';

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

export type BarsTf = '1H' | '1D' | '1W' | '1M' | '3M' | '6M' | '1Y' | '5Y';
type Resolution = '1min' | '5min' | '30min' | 'daily';

export const BARS_TFS: BarsTf[] = ['1H', '1D', '1W', '1M', '3M', '6M', '1Y', '5Y'];

interface TfSpec {
  resolution: Resolution;
  /** Calendar days to request from the vendor for this resolution family. */
  fetchDays: number;
  /** Bars to return to the client (newest N). */
  sliceBars: number;
}

/** fetchDays covers weekends/holidays so the slice always fills. */
const TF: Record<BarsTf, TfSpec> = {
  '1H': { resolution: '1min', fetchDays: 5, sliceBars: 60 },
  '1D': { resolution: '5min', fetchDays: 9, sliceBars: 78 },      // 1 session ≈ 78 5-min bars
  '1W': { resolution: '5min', fetchDays: 9, sliceBars: 390 },     // 5 sessions
  '1M': { resolution: '30min', fetchDays: 40, sliceBars: 286 },   // 22 sessions × 13 bars
  '3M': { resolution: 'daily', fetchDays: 95, sliceBars: 64 },
  '6M': { resolution: 'daily', fetchDays: 190, sliceBars: 128 },
  '1Y': { resolution: 'daily', fetchDays: 380, sliceBars: 252 },
  '5Y': { resolution: 'daily', fetchDays: 1830, sliceBars: 1300 },
};

const RES_PARAMS: Record<Resolution, { multiplier: number; timespan: 'minute' | 'hour' | 'day' }> = {
  '1min': { multiplier: 1, timespan: 'minute' },
  '5min': { multiplier: 5, timespan: 'minute' },
  '30min': { multiplier: 30, timespan: 'minute' },
  daily: { multiplier: 1, timespan: 'day' },
};

export interface StoredBar {
  t: number; o: number; h: number; l: number; c: number; v: number; vw: number | null;
}

interface BarsDoc {
  ticker: string;
  resolution: Resolution;
  bars: StoredBar[];
  rangeDays: number;
  barCount: number;
  createdAt: string;   // ISO — when this data was inserted (the cache clock)
  updatedAt: string;
  source: string;
}

/** Company profile TTL — refreshed by the premarket warm for hot tickers. */
const COMPANY_TTL_MS = 20 * 3600_000;
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

function byPublishedAtDesc(a: Record<string, unknown>, b: Record<string, unknown>): number {
  return String(b.publishedAt as string).localeCompare(String(a.publishedAt as string));
}

/** ET clock parts without a tz library. */
function etParts(now = new Date()): { weekday: number; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: 'numeric',
  });
  const parts = fmt.formatToParts(now);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '12') % 24;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  return { weekday, hour };
}

/** True while US extended trading (pre + regular + after) could move intraday bars. */
function inExtendedSession(): boolean {
  const { weekday, hour } = etParts();
  return weekday >= 1 && weekday <= 5 && hour >= 4 && hour < 20;
}

function isFresh(createdAtIso: string | undefined, resolution: Resolution): boolean {
  if (!createdAtIso) return false;
  const age = Date.now() - Date.parse(createdAtIso);
  if (!Number.isFinite(age) || age < 0) return false;
  if (resolution === 'daily') return age < DAILY_TTL_MS;
  // Intraday: refetch every 15 min while a session is running; once the session
  // is over, anything fetched after it ended stays fresh until the next one.
  if (inExtendedSession()) return age < INTRADAY_SESSION_TTL_MS;
  return age < 12 * 3600_000;
}

@Injectable()
export class OnDemandService implements OnModuleDestroy {
  private readonly logger = new Logger(OnDemandService.name);

  /** In-memory hot cache: parsed Firestore docs, keyed {TICKER}_{res}. */
  private readonly memBars = new Map<string, BarsDoc>();
  private readonly memCompany = new Map<string, { data: Record<string, unknown>; at: number }>();
  private readonly memDividendHistory = new Map<string, { data: Record<string, unknown>; at: number }>();
  private readonly memSplits = new Map<string, { data: Record<string, unknown>; at: number }>();
  private readonly memFinancials = new Map<string, { data: Record<string, unknown>; at: number }>();
  private readonly memNews = new Map<string, { data: Record<string, unknown>[]; at: number }>();
  private readonly memOptions = new Map<string, { data: Record<string, unknown>; at: number }>();
  /** Coalescing: concurrent misses for the same key share one vendor promise. */
  private readonly inflight = new Map<string, Promise<unknown>>();

  /** Usage accumulator — flushed as ONE batched write per interval. */
  private pendingUsage = new Map<string, number>();
  private usageTimer: NodeJS.Timeout | null = null;
  private knownUsageTickers: Set<string> | null = null;

  readonly stats = {
    barsRequests: 0, barsVendorCalls: 0, barsFirestoreHits: 0, barsMemHits: 0,
    companyRequests: 0, companyVendorCalls: 0, usageFlushes: 0, lastError: '',
  };

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly polygon: PolygonService,
    @Inject(NEWS_ADAPTER) private readonly news: NewsAdapter,
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
  async getBars(ticker: string, tf: BarsTf): Promise<{
    ticker: string; tf: BarsTf; bars: StoredBar[]; source: 'memory' | 'firestore' | 'vendor'; asOf: string;
  }> {
    this.stats.barsRequests++;
    this.recordUsage(ticker);
    const spec = TF[tf];
    const key = `${ticker}_${spec.resolution}`;

    // 1. Per-instance memory (already-parsed doc).
    const mem = this.memBars.get(key);
    if (mem && isFresh(mem.createdAt, spec.resolution) && mem.rangeDays >= spec.fetchDays) {
      this.stats.barsMemHits++;
      return { ticker, tf, bars: this.slice(mem, spec), source: 'memory', asOf: mem.createdAt };
    }

    // 2. Firestore shared cache.
    const ref = this.firebase.firestore.collection('stock_bars').doc(key);
    const snap = await ref.get();
    if (snap.exists) {
      const doc = snap.data() as BarsDoc;
      if (isFresh(doc.createdAt, spec.resolution) && (doc.rangeDays ?? 0) >= spec.fetchDays) {
        this.memBars.set(key, doc);
        this.stats.barsFirestoreHits++;
        return { ticker, tf, bars: this.slice(doc, spec), source: 'firestore', asOf: doc.createdAt };
      }
      // Wide enough but STALE → INCREMENTAL refresh: history never changes, so
      // fetch only the days since the last stored bar and append. A 5-year doc
      // costs a ~2-day fetch per day of staleness — old data is never re-pulled.
      if ((doc.rangeDays ?? 0) >= spec.fetchDays && doc.bars.length > 0) {
        const fresh = await this.refreshIncremental(ticker, spec.resolution, doc, ref);
        return { ticker, tf, bars: this.slice(fresh, spec), source: 'vendor', asOf: fresh.createdAt };
      }
      // Too narrow — a wider window was requested than ever stored. This is the
      // one genuine full fetch (backfill), still a single vendor call.
      const widest = Math.max(spec.fetchDays, doc.rangeDays ?? 0);
      const fresh = await this.fetchAndStore(ticker, spec.resolution, widest, ref);
      return { ticker, tf, bars: this.slice(fresh, spec), source: 'vendor', asOf: fresh.createdAt };
    }

    // 3. Vendor (coalesced) — first-ever request for this ticker+resolution.
    const fresh = await this.fetchAndStore(ticker, spec.resolution, spec.fetchDays, ref);
    return { ticker, tf, bars: this.slice(fresh, spec), source: 'vendor', asOf: fresh.createdAt };
  }

  /**
   * Append-only refresh of an existing doc: fetch from the last stored bar's
   * date (inclusive — the tail bar may have been partial when captured) to
   * today, replace that tail bar and append the rest. rangeDays is preserved,
   * so a 5Y-widened doc stays 5Y without ever re-downloading 5 years.
   */
  private async refreshIncremental(
    ticker: string, resolution: Resolution, doc: BarsDoc,
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
        ticker, from, to, timespan, multiplier, 50_000,
      );
      const now = new Date().toISOString();
      const kept = doc.bars.filter((b) => b.t < lastT); // drop the possibly-partial tail
      const appended = raw
        .filter((b) => b.t >= lastT)
        .map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw ?? null }));
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
    ticker: string, resolution: Resolution, rangeDays: number,
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
        ticker, isoDate(from), isoDate(to), timespan, multiplier, 50_000,
      );
      const now = new Date().toISOString();
      const doc: BarsDoc = {
        ticker,
        resolution,
        bars: raw.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw ?? null })),
        rangeDays,
        barCount: raw.length,
        createdAt: now,
        updatedAt: now,
        source: 'polygon-ondemand',
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
   */
  async getCompany(ticker: string): Promise<Record<string, unknown> | null> {
    this.stats.companyRequests++;
    this.recordUsage(ticker);

    const mem = this.memCompany.get(ticker);
    if (mem && Date.now() - mem.at < 5 * 60_000) return mem.data;

    const ref = this.firebase.firestore.collection('companies').doc(ticker);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      const created = typeof data.createdAt === 'string' ? Date.parse(data.createdAt) : NaN;
      if (Number.isFinite(created) && Date.now() - created < COMPANY_TTL_MS && data.price != null) {
        this.memCompany.set(ticker, { data, at: Date.now() });
        return data;
      }
    }

    const key = `company_${ticker}`;
    const existing = this.inflight.get(key) as Promise<Record<string, unknown> | null> | undefined;
    if (existing) return existing;

    const p = (async () => {
      this.stats.companyVendorCalls++;
      let details: Record<string, unknown> | null = null;
      try {
        details = await this.polygon.getTickerDetails(ticker);
      } catch {
        details = null; // unknown ticker — still try the snapshot
      }
      const quotes = await this.polygon.getUniversalSnapshot([ticker]).catch(() => []);
      const q = quotes[0] as Record<string, unknown> | undefined;
      if (!details && !q) return null;

      const now = new Date().toISOString();
      const doc: Record<string, unknown> = {
        ticker,
        name: (details?.name as string) ?? ticker,
        sector: (details?.sic_description as string) ?? null,
        marketCap: (details?.market_cap as number) ?? null,
        exchange: (details?.primary_exchange as string) ?? null,
        price: (q?.price as number) ?? null,
        pctChange: (q?.changePercent as number) ?? null,
        prevClose: (q?.previousClose as number) ?? null,
        volume: (q?.volume as number) ?? null,
        createdAt: now,
        updatedAt: now,
        source: 'polygon-ondemand',
      };
      await ref.set(doc, { merge: true });
      this.memCompany.set(ticker, { data: doc, at: Date.now() });
      return doc;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  // ── Dividend history ────────────────────────────────────────────────────

  /**
   * Per-ticker dividend history, cache-aside on `dividend_history/{ticker}` —
   * the same collection/doc shape `corporate-actions.job.ts`'s bulk cursor
   * sweep writes, so a ticker the sweep hasn't reached yet gets its doc
   * created here on first request instead of waiting for the cron to arrive.
   */
  async getDividendHistory(ticker: string): Promise<Record<string, unknown> | null> {
    const mem = this.memDividendHistory.get(ticker);
    if (mem && Date.now() - mem.at < 5 * 60_000) return mem.data;

    const ref = this.firebase.firestore.collection('dividend_history').doc(ticker);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      const created = typeof data.createdAt === 'string' ? Date.parse(data.createdAt) : NaN;
      if (Number.isFinite(created) && Date.now() - created < DAILY_TTL_MS) {
        this.memDividendHistory.set(ticker, { data, at: Date.now() });
        return data;
      }
    }

    const key = `dividend_history_${ticker}`;
    const existing = this.inflight.get(key) as Promise<Record<string, unknown> | null> | undefined;
    if (existing) return existing;

    const p = (async () => {
      const history = await this.polygon.getDividendHistory(ticker, DIV_HISTORY_LIMIT);
      const totals = annualTotals(history);
      const cutoff = new Date();
      cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
      const cutoffIso = cutoff.toISOString().slice(0, 10);
      const ttm = history.filter((d) => d.exDividendDate != null && d.exDividendDate >= cutoffIso);
      const ttmTotal = ttm.reduce((s, d) => s + (d.cashAmount ?? 0), 0);
      const company: Record<string, unknown> | null = await this.getCompany(ticker).catch(() => null);
      const price: number | null = (company?.price as number | undefined) ?? null;

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
        yieldPct: price != null && ttm.length > 0 ? Math.round((ttmTotal / price) * 10000) / 100 : null,
        yieldBasisPrice: price,
        cagr5yPct: dividendCagr(totals, DIV_CAGR_YEARS),
        increaseStreakYears: increaseStreak(totals),
        frequency: history[0]?.frequency ?? null,
        isPayer: history.length > 0,
        source: 'polygon-ondemand',
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

    const ref = this.firebase.firestore.collection('splits').doc(ticker);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      const created = typeof data.createdAt === 'string' ? Date.parse(data.createdAt) : NaN;
      if (Number.isFinite(created) && Date.now() - created < DAILY_TTL_MS) {
        this.memSplits.set(ticker, { data, at: Date.now() });
        return data;
      }
    }

    const key = `splits_${ticker}`;
    const existing = this.inflight.get(key) as Promise<Record<string, unknown> | null> | undefined;
    if (existing) return existing;

    const p = (async () => {
      const splits = await this.polygon.getSplits(ticker);
      const now = new Date().toISOString();
      const doc: Record<string, unknown> = {
        ticker,
        splits,
        latestSplit: splits[0] ?? null,
        source: 'polygon-ondemand',
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
   * (same shape financials.job.ts's bulk cursor sweep writes). EPS estimates
   * are matched against synced `earnings_events` only — unlike the bulk job,
   * this skips the Finnhub cross-reference to avoid a second vendor
   * dependency on a request-latency-sensitive path; a ticker the bulk sweep
   * later reaches gets the richer Finnhub-enriched estimate instead.
   */
  async getFinancials(ticker: string): Promise<Record<string, unknown> | null> {
    const mem = this.memFinancials.get(ticker);
    if (mem && Date.now() - mem.at < 5 * 60_000) return mem.data;

    const ref = this.firebase.firestore.collection('financials').doc(ticker);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      const created = typeof data.createdAt === 'string' ? Date.parse(data.createdAt) : NaN;
      if (Number.isFinite(created) && Date.now() - created < DAILY_TTL_MS) {
        this.memFinancials.set(ticker, { data, at: Date.now() });
        return data;
      }
    }

    const key = `financials_${ticker}`;
    const existing = this.inflight.get(key) as Promise<Record<string, unknown> | null> | undefined;
    if (existing) return existing;

    const p = (async () => {
      const [rows, estimates] = await Promise.all([
        this.polygon.getFinancialStatements(ticker, 'quarterly', FIN_QUARTERS),
        this.earningsEstimatesFor(ticker),
      ]);
      const quarters = rows.map((r) => mapQuarterRow(r, this.matchEpsEstimate(estimates, r.endDate)));

      let annual: ReturnType<typeof mapAnnualRow>[] = [];
      try {
        const yr = await this.polygon.getFinancialStatements(ticker, 'annual', FIN_ANNUAL_YEARS);
        annual = yr.map(mapAnnualRow);
      } catch {
        // Annual is a secondary tab — a failure there shouldn't block quarterly data.
      }

      const now = new Date().toISOString();
      const doc: Record<string, unknown> = {
        ticker, quarters, annual, source: 'polygon-ondemand', createdAt: now, updatedAt: now,
      };
      await ref.set(doc);
      this.memFinancials.set(ticker, { data: doc, at: Date.now() });
      return doc;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  /** Raw {reportDate, epsEstimate} pairs for one ticker's synced earnings_events (see getFinancials doc-comment: skips Finnhub, unlike the bulk job). */
  private async earningsEstimatesFor(ticker: string): Promise<Array<{ date: string; epsEstimate: number }>> {
    const snap = await this.firebase.firestore
      .collection('earnings_events')
      .where('ticker', '==', ticker)
      .get();
    const out: Array<{ date: string; epsEstimate: number }> = [];
    for (const d of snap.docs) {
      const data = d.data();
      if (data.epsEstimate != null && data.date) out.push({ date: data.date, epsEstimate: data.epsEstimate });
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
      const gap = Math.abs(new Date(`${e.date}T00:00:00Z`).getTime() - target) / 86_400_000;
      if (gap <= 90 && (!best || gap < best.gap)) best = { v: e.epsEstimate, gap };
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

    const snap = await this.firebase.firestore.collection('news').where('ticker', '==', ticker).get();
    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>);
    const freshestUpdate = docs.reduce((max, d) => {
      const t = typeof d.updatedAt === 'string' ? Date.parse(d.updatedAt) : NaN;
      return Number.isFinite(t) ? Math.max(max, t) : max;
    }, 0);

    if (docs.length > 0 && Date.now() - freshestUpdate < NEWS_TTL_MS) {
      const sorted = [...docs].sort(byPublishedAtDesc);
      this.memNews.set(ticker, { data: sorted, at: Date.now() });
      return sorted;
    }

    const key = `news_${ticker}`;
    const existing = this.inflight.get(key) as Promise<Record<string, unknown>[]> | undefined;
    if (existing) return existing;

    const p = (async () => {
      const to = new Date();
      const from = new Date(to.getTime() - NEWS_LOOKBACK_DAYS * 86_400_000);
      const isoDate = (d: Date) => d.toISOString().slice(0, 10);
      const result = await this.news.fetchNews(ticker, isoDate(from), isoDate(to));
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
          batch.set(this.firebase.firestore.collection('news').doc(a.docId), a.data, { merge: true });
        }
        await batch.commit();
      }
      const sorted = articles
        .map((a) => ({ id: a.docId, ...a.data }))
        .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
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
  async getOptionsChain(ticker: string): Promise<Record<string, unknown> | null> {
    const mem = this.memOptions.get(ticker);
    if (mem && Date.now() - mem.at < 5 * 60_000) return mem.data;

    const ref = this.firebase.firestore.collection('options_chains').doc(ticker);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      const created = typeof data.createdAt === 'string' ? Date.parse(data.createdAt) : NaN;
      if (Number.isFinite(created) && Date.now() - created < DAILY_TTL_MS) {
        this.memOptions.set(ticker, { data, at: Date.now() });
        return data;
      }
    }

    const key = `options_${ticker}`;
    const existing = this.inflight.get(key) as Promise<Record<string, unknown> | null> | undefined;
    if (existing) return existing;

    const p = (async () => {
      const today = isoDate(new Date());
      const lookback = new Date();
      lookback.setUTCDate(lookback.getUTCDate() - OPTIONS_AGG_LOOKBACK_DAYS);
      const from = isoDate(lookback);

      const contracts = await this.polygon.getOptionContracts(ticker, today, OPTIONS_CONTRACTS_LIMIT);
      const enriched: Record<string, unknown>[] = [];
      for (const c of contracts) {
        try {
          const bar = await this.polygon.getOptionLatestBar(c.ticker, from, today);
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
            lastRangePct: bar && bar.o > 0 ? Math.round(((bar.h - bar.l) / bar.o) * 10000) / 100 : null,
          });
        } catch (err) {
          this.logger.warn(`options on-demand: bar fetch failed for ${c.ticker}: ${(err as Error).message}`);
        }
        await sleep(this.polygon.requestDelayMs);
      }

      const now = new Date().toISOString();
      const doc = {
        underlyingTicker: ticker,
        contracts: enriched,
        source: 'polygon-ondemand',
        note: 'Strikes, expirations and per-contract OHLCV/VWAP/volume are real (delayed). Bid/ask, IV, greeks and open interest return NOT_AUTHORIZED on the current Polygon plan — they need the Options add-on or Tradier.',
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

  // ── Usage tracking (the "which stocks are really used" collection) ──────

  /** Batched: N hits inside a flush window become ONE increment write. */
  recordUsage(ticker: string): void {
    this.pendingUsage.set(ticker, (this.pendingUsage.get(ticker) ?? 0) + 1);
    if (!this.usageTimer) {
      this.usageTimer = setInterval(() => void this.flushUsage(), USAGE_FLUSH_MS);
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
        const ids = await db.collection('ticker_usage').select().get();
        this.knownUsageTickers = new Set(ids.docs.map((d) => d.id));
      }
      const batch = db.batch();
      const now = new Date().toISOString();
      for (const [ticker, n] of toFlush) {
        const ref = db.collection('ticker_usage').doc(ticker);
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
        .collection('ticker_usage')
        .orderBy('count', 'desc')
        .limit(limit)
        .get();
      return snap.docs.map((d) => d.id);
    } catch (err) {
      this.logger.warn(`hotTickers query failed: ${(err as Error).message}`);
      return [];
    }
  }
}
