import { Injectable, Logger } from "@nestjs/common";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { FredService } from "../vendors/fred/fred.service";
import { FmpService, type FmpQuote } from "../vendors/fmp/fmp.service";
import { etDate } from "../common/market-calendar.util";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { TapeService, type TapeFrame, type TapeItem } from "./tape.service";
import { TAPE_INDICES } from "./tape-universe";

/**
 * The marketing site's hero figures — S&P 500, gold, VIX and Brent crude —
 * plus the mega-cap marquee under it.
 *
 * WHY A SEPARATE, PUBLIC ENDPOINT
 * The landing page is anonymous, so it cannot use the guarded `/live/tape`,
 * and the SSE frame carries everything the in-app tape needs (proxy tickers,
 * vendor notes, company names, day ranges). This projects that frame down to
 * the handful of numbers the landing page actually renders — nothing else
 * leaves the backend.
 *
 * WHERE THE FOUR HERO FIGURES COME FROM
 * FMP `/stable/quote`, one call per symbol (batch quotes are not on the plan):
 *   S&P 500  ^GSPC   the index itself — not SPY × 10, which also drops by the
 *                    dividend on SPY's ex-dates (Polygon bars are split- but not
 *                    dividend-adjusted)
 *   Gold     GCUSD   gold futures
 *   VIX      ^VIX    the CBOE index — not the VIXY ETN, whose price is not the
 *                    VIX level (real index snapshots are not on the Polygon plan)
 *   Brent    BZUSD   Brent crude futures. WTI (CLUSD) is a premium FMP symbol
 *                    and the free WTI sources (FRED, Alpha Vantage/EIA) are
 *                    days behind, so the hero shows Brent, labelled as Brent.
 * If FMP fails, S&P and gold fall back to the Polygon tape below, VIX to
 * FRED's official close (VIXCLS) and Brent to FRED's daily Brent spot
 * (DCOILBRENTEU) — both labelled with their date.
 *
 * LAST KNOWN VALUES
 * Every real figure a cell gets is remembered — in memory and in one Firestore
 * document (landing_tape/last_good), so it survives restarts and scale-to-zero.
 * When the primary source fails, the cell serves whichever is more recent: the
 * fallback source or the remembered value. A remembered close replays as that
 * close ("Sep 17 close"); a remembered live print replays as basis "saved"
 * ("last recorded Sep 21") so it is never passed off as live. A cell is only
 * ever empty if it has never had a real value.
 *
 * FMP BUDGET
 * The FMP key is shared with the worker's batch jobs and the plan has a hard
 * request limit (it answers 429 "Limit Reach" once spent). So each quote is
 * reused for FMP_TTL_MS, and after a failure the symbol is not retried for
 * FMP_BACKOFF_MS — at most ~4 calls per 15 minutes, far fewer on a bad day.
 *
 * WHY IT DOES NOT CALL A VENDOR PER REQUEST
 * The assembled body is cached (30s, 5 min when the market is closed), so the
 * FMP reads are at most four per window. Marquee prices come from
 * TapeService.currentFrame(), which reuses the one broadcast frame, and the
 * daily-bar fallback below is cached per ET date.
 *
 * THE MARQUEE'S ROLLOVER CORRECTION
 * Outside the regular session the Polygon snapshot rolls over before the next
 * open: `close` and `previous_close` both become the last close and the move
 * reads a flat +0.00%. When that happens the figure is rebuilt from the last
 * two COMPLETED daily bars, so it shows the last session's real move.
 */

export type LandingPhase = TapeFrame["marketPhase"];

export interface LandingCell {
  id: "SPX" | "GOLD" | "VIX" | "BRENT";
  value: number;
  pctChange: number;
  prevClose: number | null;
  /**
   * "live"  = current session (vendor-delayed);
   * "close" = a completed session (see `date`);
   * "saved" = the last value we recorded while every source is failing (`date`
   *           is the ET date it was recorded).
   */
  basis: "live" | "close" | "saved";
  /** ET date (YYYY-MM-DD) for "close" and "saved"; null when live. */
  date: string | null;
}

export interface LandingQuote {
  sym: string;
  value: number;
  pctChange: number;
}

export interface LandingTape {
  asOf: string;
  phase: LandingPhase;
  /** True when the backend's last vendor refresh failed and these are the last good values. */
  stale: boolean;
  delayMinutes: number;
  cells: LandingCell[];
  quotes: LandingQuote[];
}

/** How long one assembled body is reused while prices can move (pre, regular
 *  and after-hours sessions). The feed underneath is ~15 min delayed. */
const TTL_MS = 30_000;
/** When the market is closed the figures are frozen, so reuse the body far
 *  longer — this only bounds how late we notice the next session opening. */
const CLOSED_TTL_MS = 5 * 60_000;
/** FRED series are daily; an hour is far finer than their update cadence. */
const FRED_TTL_MS = 60 * 60_000;
/** How long one FMP quote is reused. The hero is a snapshot, not a ticker. */
const FMP_TTL_MS = 15 * 60_000;
/** After a failed FMP read (429 when the plan's limit is spent), leave the
 *  symbol alone this long and serve the fallback instead. */
const FMP_BACKOFF_MS = 30 * 60_000;
/** An FMP quote older than this is a completed session, not a live print. */
const LIVE_WINDOW_MS = 30 * 60_000;
/** Daily-bar lookback — wide enough to span a long weekend plus a holiday. */
const LOOKBACK_DAYS = 14;

const DELAY_MINUTES = 15;

/**
 * Weekday window where the marquee goes blank instead of showing the prior
 * session's close next to the coming one. Not tied to the vendor's own
 * "pre" phase (that starts ~4am ET) or to the premarket orchestrator's
 * 08:00 ET run — this is purely a display reset in the window right before
 * the open.
 */
const RESET_START_MIN = 7 * 60 + 30; // 07:30 ET
const RESET_END_MIN = 8 * 60; // 08:00 ET

/** Minutes since midnight ET, and the ET weekday (0=Sun…6=Sat), no tz library. */
function etClock(now: Date = new Date()): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return {
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd),
    minutes: hour * 60 + minute,
  };
}

/** True Mon–Fri 07:30–08:00 ET. Weekends are skipped — there is no open to reset into. */
function inMorningReset(now: Date = new Date()): boolean {
  const { weekday, minutes } = etClock(now);
  if (weekday === 0 || weekday === 6) return false;
  return minutes >= RESET_START_MIN && minutes < RESET_END_MIN;
}

/** Where the last known value of each cell is kept between restarts. */
const SAVED_COLLECTION = "landing_tape";
const SAVED_DOC = "last_good";
/** At most one Firestore write per this window, and only when a value changed. */
const PERSIST_EVERY_MS = 10 * 60_000;

type CellId = LandingCell["id"];
type Saved = LandingCell & { savedAt: string };

type Close = { date: string; c: number };
type Pair = { last: Close; prev: Close };

@Injectable()
export class LandingTapeService {
  private readonly logger = new Logger(LandingTapeService.name);

  private cache: { at: number; body: LandingTape } | null = null;
  private inFlight: Promise<LandingTape> | null = null;

  /** Last two completed daily closes per ticker, valid for one ET date. */
  private closes = new Map<string, { day: string; pair: Pair }>();
  private fred = new Map<string, { at: number; pair: Pair }>();
  /** Last FMP answer per symbol; `quote` null means the read failed at `at`. */
  private fmpQuotes = new Map<string, { at: number; quote: FmpQuote | null }>();

  /** Last real value per cell (see LAST KNOWN VALUES above). */
  private saved = new Map<CellId, Saved>();
  private savedLoad: Promise<void> | null = null;
  private savedDirty = false;
  private lastPersist = 0;

  private readonly multiplier = new Map(
    TAPE_INDICES.map((s) => [s.id, s.multiplier ?? 1]),
  );

  constructor(
    private readonly tape: TapeService,
    private readonly polygon: PolygonService,
    private readonly fredApi: FredService,
    private readonly fmp: FmpService,
    private readonly firebase: FirebaseAdminService,
  ) {}

  /** Never throws — a failed build serves the last good body, or an empty one. */
  async get(): Promise<LandingTape> {
    if (inMorningReset()) return this.resetBody();
    if (this.cache) {
      const ttl = this.cache.body.phase === "closed" ? CLOSED_TTL_MS : TTL_MS;
      if (Date.now() - this.cache.at < ttl) return this.cache.body;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      try {
        const body = await this.build();
        this.cache = { at: Date.now(), body };
        return body;
      } catch (err) {
        this.logger.warn(`landing tape build failed: ${(err as Error)?.message ?? err}`);
        return (
          this.cache?.body ?? {
            asOf: new Date().toISOString(),
            phase: "unknown",
            stale: true,
            delayMinutes: DELAY_MINUTES,
            cells: [],
            quotes: [],
          }
        );
      }
    })();

    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  /** Blank body served during the 07:30–08:00 ET reset window — no vendor calls. */
  private resetBody(): LandingTape {
    return {
      asOf: new Date().toISOString(),
      phase: "pre",
      stale: false,
      delayMinutes: DELAY_MINUTES,
      cells: [],
      quotes: [],
    };
  }

  private async build(): Promise<LandingTape> {
    const frame = await this.tape.currentFrame();
    const by = new Map(frame.items.map((i) => [i.id, i]));
    const phase = frame.marketPhase;

    const stocks = frame.items.filter((i) => i.kind === "stock");
    await this.loadSaved();

    const [spx, gold, vix, brent, quotes] = await Promise.all([
      this.resolve("SPX", this.fmpCell("SPX", "^GSPC"), () => this.equityCell("SPX", by.get("SPX"), phase)),
      this.resolve("GOLD", this.fmpCell("GOLD", "GCUSD"), () => this.equityCell("GOLD", by.get("GOLD"), phase)),
      this.resolve("VIX", this.fmpCell("VIX", "^VIX"), () => this.fredCell("VIX", "VIXCLS")),
      this.resolve("BRENT", this.fmpCell("BRENT", "BZUSD"), () => this.fredCell("BRENT", "DCOILBRENTEU")),
      Promise.all(stocks.map((s) => this.quote(s, phase))),
    ]);
    this.persistSaved();

    return {
      asOf: frame.asOf,
      phase,
      stale: frame.stale,
      delayMinutes: DELAY_MINUTES,
      cells: [spx, gold, vix, brent].filter((c): c is LandingCell => c !== null),
      quotes: quotes.filter((q): q is LandingQuote => q !== null),
    };
  }

  /* ── Source selection + last known values ──────────────────────────── */

  /**
   * Primary source first; if it fails, the more recent of the fallback source
   * and the remembered value (a tie goes to the fallback, which is fresh).
   */
  private async resolve(
    id: CellId,
    primary: Promise<LandingCell | null>,
    fallback: () => Promise<LandingCell | null>,
  ): Promise<LandingCell | null> {
    const p = await primary;
    if (p) return this.remember(p);

    const f = await fallback();
    const s = this.saved.get(id);
    const replay = s ? this.replay(s) : null;
    if (f && replay) return replay.date! > asOfDate(f) ? replay : this.remember(f);
    if (f) return this.remember(f);
    return replay;
  }

  private remember(c: LandingCell): LandingCell {
    const prev = this.saved.get(c.id);
    if (!prev || prev.value !== c.value || prev.pctChange !== c.pctChange || prev.basis !== c.basis) {
      this.saved.set(c.id, { ...c, savedAt: new Date().toISOString() });
      this.savedDirty = true;
    }
    return c;
  }

  /** A remembered value as served: its own close, or dated "saved". */
  private replay(s: Saved): LandingCell {
    const { savedAt, ...cell } = s;
    if (cell.basis === "close" && cell.date) return cell;
    return { ...cell, basis: "saved", date: etDate(new Date(savedAt)) };
  }

  /** Reads the remembered values once per instance. A failure just starts empty. */
  private loadSaved(): Promise<void> {
    this.savedLoad ??= (async () => {
      try {
        const snap = await this.firebase.firestore.collection(SAVED_COLLECTION).doc(SAVED_DOC).get();
        const cells = (snap.data()?.cells ?? {}) as Record<string, Saved>;
        for (const [id, c] of Object.entries(cells)) {
          if (c && Number.isFinite(c.value) && !this.saved.has(id as CellId)) this.saved.set(id as CellId, c);
        }
      } catch (err) {
        this.logger.warn(`loading saved landing values failed: ${(err as Error)?.message ?? err}`);
      }
    })();
    return this.savedLoad;
  }

  /** Fire-and-forget write of the remembered values; throttled, only on change. */
  private persistSaved(): void {
    if (!this.savedDirty || Date.now() - this.lastPersist < PERSIST_EVERY_MS) return;
    this.savedDirty = false;
    this.lastPersist = Date.now();
    const cells = Object.fromEntries(this.saved);
    void this.firebase.firestore
      .collection(SAVED_COLLECTION)
      .doc(SAVED_DOC)
      // merge: several instances (and a developer's local backend, which uses
      // the same database) share this document; each only knows the cells it
      // has seen, so a plain set() would erase the others'.
      .set({ cells, updatedAt: new Date().toISOString() }, { merge: true })
      .catch((err: unknown) => {
        this.savedDirty = true;
        this.logger.warn(`saving landing values failed: ${(err as Error)?.message ?? err}`);
      });
  }

  /* ── FMP (primary source for the four hero figures) ─────────────────── */

  /**
   * A hero cell from one FMP quote. A print inside the last half hour is
   * "live"; anything older is the close of the session it was printed in, and
   * says which one — so a weekend reading is never presented as current.
   */
  private async fmpCell(id: LandingCell["id"], symbol: string): Promise<LandingCell | null> {
    const q = await this.fmpQuote(symbol);
    if (!q) return null;
    const at = q.timestamp * 1000;
    const live = Date.now() - at <= LIVE_WINDOW_MS;
    return {
      id,
      value: q.price,
      pctChange: Math.round(q.changePercentage * 100) / 100,
      prevClose: q.previousClose,
      basis: live ? "live" : "close",
      date: live ? null : etDate(new Date(at)),
    };
  }

  /** One FMP quote through the budget: cached on success, backed off on failure. */
  private async fmpQuote(symbol: string): Promise<FmpQuote | null> {
    const hit = this.fmpQuotes.get(symbol);
    const now = Date.now();
    if (hit) {
      const ttl = hit.quote ? FMP_TTL_MS : FMP_BACKOFF_MS;
      if (now - hit.at < ttl) return hit.quote;
    }
    const quote = await this.fmp.getQuote(symbol);
    this.fmpQuotes.set(symbol, { at: now, quote });
    return quote;
  }

  /* ── Polygon fallback for S&P and gold ──────────────────────────────── */

  /**
   * True when the snapshot has rolled over and no longer describes a session:
   * outside regular hours with the price sitting exactly on the previous close.
   */
  private isRolled(it: TapeItem | undefined, phase: LandingPhase): boolean {
    if (!it || it.value == null || it.pctChange == null || it.prevClose == null) return true;
    if (phase === "open") return false;
    return Math.abs(it.value - it.prevClose) < 1e-9 || it.pctChange === 0;
  }

  private async equityCell(
    id: "SPX" | "GOLD",
    it: TapeItem | undefined,
    phase: LandingPhase,
  ): Promise<LandingCell | null> {
    if (!this.isRolled(it, phase)) {
      return {
        id,
        value: it!.value!,
        pctChange: it!.pctChange!,
        prevClose: it!.prevClose,
        basis: "live",
        date: null,
      };
    }
    const ticker = it?.proxyTicker ?? TAPE_INDICES.find((s) => s.id === id)?.proxyTicker;
    if (!ticker) return null;
    const pair = await this.lastTwoCloses(ticker);
    if (!pair) return null;
    const m = this.multiplier.get(id) ?? 1;
    return {
      id,
      value: pair.last.c * m,
      pctChange: pct(pair.last.c, pair.prev.c),
      prevClose: pair.prev.c * m,
      basis: "close",
      date: pair.last.date,
    };
  }

  private async quote(it: TapeItem, phase: LandingPhase): Promise<LandingQuote | null> {
    if (!this.isRolled(it, phase)) {
      return { sym: it.label, value: it.value!, pctChange: it.pctChange! };
    }
    const pair = it.proxyTicker ? await this.lastTwoCloses(it.proxyTicker) : null;
    return pair
      ? { sym: it.label, value: pair.last.c, pctChange: pct(pair.last.c, pair.prev.c) }
      : null;
  }

  /**
   * The last two COMPLETED sessions for a ticker. Today's bar is excluded:
   * before the open it holds only pre-market prints, which is exactly the
   * half-formed session this fallback exists to avoid. Cached for the ET day.
   */
  private async lastTwoCloses(ticker: string): Promise<Pair | null> {
    const today = etDate();
    const hit = this.closes.get(ticker);
    if (hit && hit.day === today) return hit.pair;

    try {
      const from = etDate(new Date(Date.now() - LOOKBACK_DAYS * 86_400_000));
      const bars = (await this.polygon.getAggsRange(ticker, from, today))
        .map((b) => ({ date: etDate(new Date(b.t)), c: b.c }))
        .filter((b) => b.date < today && Number.isFinite(b.c));
      if (bars.length < 2) return hit?.pair ?? null;
      const pair = { last: bars[bars.length - 1], prev: bars[bars.length - 2] };
      this.closes.set(ticker, { day: today, pair });
      return pair;
    } catch (err) {
      this.logger.warn(`daily closes for ${ticker} failed: ${(err as Error)?.message ?? err}`);
      return hit?.pair ?? null;
    }
  }

  /* ── FRED (official daily closes) ───────────────────────────────────── */

  private async fredCell(id: "VIX" | "BRENT", series: string): Promise<LandingCell | null> {
    const pair = await this.fredPair(series);
    if (!pair) return null;
    return {
      id,
      value: pair.last.c,
      pctChange: pct(pair.last.c, pair.prev.c),
      prevClose: pair.prev.c,
      basis: "close",
      date: pair.last.date,
    };
  }

  private async fredPair(series: string): Promise<Pair | null> {
    const hit = this.fred.get(series);
    if (hit && Date.now() - hit.at < FRED_TTL_MS) return hit.pair;
    try {
      // FRED reports "." for a missing day, so read a small window and keep
      // the two most recent numeric observations.
      const obs = (await this.fredApi.getLatestObservations(series, 8))
        .map((o) => ({ date: o.date, c: Number(o.value) }))
        .filter((o) => Number.isFinite(o.c));
      if (obs.length < 2) return hit?.pair ?? null;
      const pair = { last: obs[0], prev: obs[1] };
      this.fred.set(series, { at: Date.now(), pair });
      return pair;
    } catch (err) {
      this.logger.warn(`FRED ${series} failed: ${(err as Error)?.message ?? err}`);
      return hit?.pair ?? null;
    }
  }
}

function pct(now: number, prev: number): number {
  return prev ? Math.round(((now - prev) / prev) * 10_000) / 100 : 0;
}

/** The ET date a cell's figure describes: its close date, or today if live. */
function asOfDate(c: LandingCell): string {
  return c.basis !== "live" && c.date ? c.date : etDate();
}
