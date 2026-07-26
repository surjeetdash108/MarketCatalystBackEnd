import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { PolygonService, PolygonAggBar } from '../vendors/polygon/polygon.service';

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

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
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
      // Stale or too narrow — refetch at least as wide as ever stored, so a
      // 1Y-widened doc never shrinks back when a 3M user comes along.
      spec satisfies TfSpec;
      const widest = Math.max(spec.fetchDays, doc.rangeDays ?? 0);
      const fresh = await this.fetchAndStore(ticker, spec.resolution, widest, ref);
      return { ticker, tf, bars: this.slice(fresh, spec), source: 'vendor', asOf: fresh.createdAt };
    }

    // 3. Vendor (coalesced).
    const fresh = await this.fetchAndStore(ticker, spec.resolution, spec.fetchDays, ref);
    return { ticker, tf, bars: this.slice(fresh, spec), source: 'vendor', asOf: fresh.createdAt };
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
