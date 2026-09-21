import { Injectable, Logger } from "@nestjs/common";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { FredService } from "../vendors/fred/fred.service";
import { FmpService, type FmpQuote } from "../vendors/fmp/fmp.service";
import { etDate } from "../common/market-calendar.util";
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
 * If FMP fails, S&P and gold fall back to the Polygon tape below and VIX to
 * FRED's official close; crude has no fallback and the cell is omitted.
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
  /** "live" = current session (vendor-delayed); "close" = a completed session. */
  basis: "live" | "close";
  /** ET date (YYYY-MM-DD) of the close when basis is "close"; null when live. */
  date: string | null;
}

export interface LandingQuote {
  sym: string;
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
/** An FMP quote older than this is a completed session, not a live print. */
const LIVE_WINDOW_MS = 30 * 60_000;
/** Daily-bar lookback — wide enough to span a long weekend plus a holiday. */
const LOOKBACK_DAYS = 14;

const DELAY_MINUTES = 15;

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

  private readonly multiplier = new Map(
    TAPE_INDICES.map((s) => [s.id, s.multiplier ?? 1]),
  );

  constructor(
    private readonly tape: TapeService,
    private readonly polygon: PolygonService,
    private readonly fredApi: FredService,
    private readonly fmp: FmpService,
  ) {}

  /** Never throws — a failed build serves the last good body, or an empty one. */
  async get(): Promise<LandingTape> {
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

  private async build(): Promise<LandingTape> {
    const frame = await this.tape.currentFrame();
    const by = new Map(frame.items.map((i) => [i.id, i]));
    const phase = frame.marketPhase;

    const stocks = frame.items.filter((i) => i.kind === "stock");

    const [spx, gold, vix, brent, quotes] = await Promise.all([
      this.fmpCell("SPX", "^GSPC").then((c) => c ?? this.equityCell("SPX", by.get("SPX"), phase)),
      this.fmpCell("GOLD", "GCUSD").then((c) => c ?? this.equityCell("GOLD", by.get("GOLD"), phase)),
      this.fmpCell("VIX", "^VIX").then((c) => c ?? this.fredCell("VIX", "VIXCLS")),
      this.fmpCell("BRENT", "BZUSD"),
      Promise.all(stocks.map((s) => this.quote(s, phase))),
    ]);

    return {
      asOf: frame.asOf,
      phase,
      stale: frame.stale,
      delayMinutes: DELAY_MINUTES,
      cells: [spx, gold, vix, brent].filter((c): c is LandingCell => c !== null),
      quotes: quotes.filter((q): q is LandingQuote => q !== null),
    };
  }

  /* ── FMP (primary source for the four hero figures) ─────────────────── */

  /**
   * A hero cell from one FMP quote. A print inside the last half hour is
   * "live"; anything older is the close of the session it was printed in, and
   * says which one — so a weekend reading is never presented as current.
   */
  private async fmpCell(id: LandingCell["id"], symbol: string): Promise<LandingCell | null> {
    const q: FmpQuote | null = await this.fmp.getQuote(symbol);
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
    if (!this.isRolled(it, phase)) return { sym: it.label, pctChange: it.pctChange! };
    const pair = it.proxyTicker ? await this.lastTwoCloses(it.proxyTicker) : null;
    return pair ? { sym: it.label, pctChange: pct(pair.last.c, pair.prev.c) } : null;
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

  private async fredCell(id: "VIX", series: string): Promise<LandingCell | null> {
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
