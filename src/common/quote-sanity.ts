/**
 * One check every quote passes before it reaches a screen (Nov 19 workbook:
 * TCGLF $7.47 −75% on a $30 tape, BRK.B −3.07% measured from the close two
 * sessions back, AAPG $12.72 with no regular-session trade, YXT frozen at its
 * session low after the stock bounced).
 *
 * Measured 2026-11-19: FMP's batch-quote has the right previous close but its
 * price/day range include odd-lot and non-regular prints (AAPG $12.715 on 246
 * shares, below the regular range $12.96–13.05) and can lag; Polygon's v3
 * snapshot has the regular-session range but its `previous_close` is one
 * session stale for every ticker (1,075 of 1,361 differed from the true prior
 * close). So the reference is Polygon's regular session plus the official
 * previous close from Polygon's grouped daily bars of the last completed
 * session — never the snapshot's own previous_close.
 */

/** The fields of a Polygon v3 snapshot row the check reads. */
export interface PolygonSnapshotRow {
  ticker?: string;
  session?: {
    low?: number;
    high?: number;
    price?: number;
    close?: number;
    previous_close?: number;
  };
  last_minute?: { last_updated?: number; otc?: boolean };
}

export interface QuoteRef {
  /** Official close of the last completed session (grouped daily). */
  prevClose: number | null;
  /** A regular-session trade has printed today (last minute bar after today's open). */
  tradedToday: boolean;
  sessionLow: number | null;
  sessionHigh: number | null;
  sessionPrice: number | null;
  /** When Polygon's last minute bar was updated, epoch ms. */
  lastMinuteAt: number | null;
  otc: boolean;
}

export interface RawQuote {
  price: number | null;
  previousClose: number | null;
  dayLow: number | null;
  dayHigh: number | null;
  /** When the vendor last updated this quote, epoch ms (FMP `timestamp`). */
  vendorAt?: number | null;
}

export interface SaneQuote {
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  dayLow: number | null;
  dayHigh: number | null;
  /** Why the price was replaced, or null when it stood. */
  adjusted: null | "no-trade-today" | "outside-session-range" | "stale-quote";
}

const pos = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

/** Range slack before a price counts as outside the regular session. */
const RANGE_SLACK = 0.01;
/** A vendor quote this much older than the tape's last minute is stale. */
const STALE_MS = 5 * 60_000;

/** Reference from one Polygon v3 snapshot result; `openMs` = today's 09:30 ET (null before the open). */
export function quoteRefFromPolygon(
  r: PolygonSnapshotRow | null | undefined,
  officialPrev: number | null | undefined,
  openMs: number | null,
): QuoteRef {
  const s = r?.session ?? {};
  const lm = r?.last_minute ?? {};
  const lastNs = typeof lm.last_updated === "number" ? lm.last_updated : null;
  const lastMinuteAt = lastNs != null ? Math.round(lastNs / 1e6) : null;
  const tradedToday =
    openMs != null && lastMinuteAt != null && lastMinuteAt >= openMs;
  return {
    prevClose: pos(officialPrev),
    tradedToday,
    sessionLow: tradedToday ? pos(s.low) : null,
    sessionHigh: tradedToday ? pos(s.high) : null,
    sessionPrice: tradedToday ? pos(s.price ?? s.close) : null,
    lastMinuteAt,
    otc: lm.otc === true,
  };
}

/**
 * The quote with the official previous close as its base and, once the
 * regular session has opened (`openMs` set), a price that is a regular-session
 * trade: the previous close when nothing has traded today, the regular-session
 * price when the vendor's is outside the session range or stale. Change is
 * always recomputed from the price and base shown.
 */
export function sanitizeQuote(
  q: RawQuote,
  ref: QuoteRef | null | undefined,
  now: number,
  openMs: number | null,
  exDividend?: number | null,
): SaneQuote {
  const prev = pos(ref?.prevClose) ?? pos(q.previousClose);
  const changeBase = exAdjustedPrevious(
    prev,
    pos(q.previousClose),
    pos(exDividend),
  );
  let price = pos(q.price);
  let dayLow = pos(q.dayLow);
  let dayHigh = pos(q.dayHigh);
  let adjusted: SaneQuote["adjusted"] = null;
  if (ref && openMs != null && now >= openMs) {
    if (!ref.tradedToday) {
      if (prev != null) {
        price = prev;
        dayLow = null;
        dayHigh = null;
        adjusted = "no-trade-today";
      }
    } else if (
      ref.sessionLow != null &&
      ref.sessionHigh != null &&
      ref.sessionPrice != null
    ) {
      const outside =
        price == null ||
        price < ref.sessionLow * (1 - RANGE_SLACK) ||
        price > ref.sessionHigh * (1 + RANGE_SLACK);
      const stale =
        q.vendorAt != null &&
        ref.lastMinuteAt != null &&
        ref.lastMinuteAt - q.vendorAt > STALE_MS;
      if (outside || stale) {
        price = ref.sessionPrice;
        adjusted = outside ? "outside-session-range" : "stale-quote";
      }
      // The day range is the regular session's (widened to the price shown):
      // the vendor's can include odd-lot prints, which must not set a new
      // 52-week low or high.
      dayLow = Math.min(ref.sessionLow, price ?? ref.sessionLow);
      dayHigh = Math.max(ref.sessionHigh, price ?? ref.sessionHigh);
    }
  }
  // The move is measured from the dividend-adjusted close on an ex-date. A stock
  // that has not traded today stays at the official close, move 0.
  const base = adjusted === "no-trade-today" ? prev : changeBase;
  const change = price != null && base != null ? price - base : null;
  const changePct =
    price != null && base != null
      ? adjusted === "no-trade-today"
        ? 0
        : ((price - base) / base) * 100
      : null;
  return {
    price,
    previousClose: base,
    change,
    changePct,
    dayLow,
    dayHigh,
    adjusted,
  };
}

/**
 * The previous close a day's change is measured from.
 *
 * Normally the official close (`official`). On a stock's ex-dividend date the
 * exchange and every consumer feed use that close LESS the cash dividend, which
 * the vendor's own `previousClose` carries. It is adopted only when it matches
 * `official - dividend` to within rounding, so a vendor close that is merely
 * stale (BRK.B, two sessions back) is never mistaken for an adjustment.
 */
export function exAdjustedPrevious(
  official: number | null,
  vendorPrev: number | null,
  dividend: number | null,
): number | null {
  if (official == null || vendorPrev == null || dividend == null)
    return official;
  const adjusted = official - dividend;
  if (!(adjusted > 0)) return official;
  const tolerance = Math.max(0.02, official * 0.0005);
  return Math.abs(vendorPrev - adjusted) <= tolerance ? vendorPrev : official;
}

/** Today's 09:30 ET as epoch ms when it has passed on a weekday, else null. */
export function regularOpenMs(now: number): number | null {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date(now))
      .map((x) => [x.type, x.value]),
  );
  if (p.weekday === "Sat" || p.weekday === "Sun") return null;
  const mins = (Number(p.hour) % 24) * 60 + Number(p.minute);
  if (mins < 9 * 60 + 30) return null;
  return now - (mins - (9 * 60 + 30)) * 60_000 - (now % 60_000);
}

/**
 * Reference data for sanitizeQuote, cached: the official previous closes (one
 * grouped-daily call per session) and Polygon's regular-session snapshot rows
 * (reused for `refMs`, 60 s by default — Polygon's own minute cadence).
 */
export class QuoteReferenceCache {
  private prev: { forDay: string; closes: Map<string, number> } | null = null;
  private prevLoading: Promise<void> | null = null;
  private readonly rows = new Map<
    string,
    { at: number; row: PolygonSnapshotRow }
  >();

  constructor(
    private readonly rawSnapshot: (tickers: string[]) => Promise<unknown[]>,
    private readonly groupedDaily: (
      date: string,
    ) => Promise<Array<{ T?: string; c?: number }>>,
    private readonly refMs = 60_000,
  ) {}

  /** ET calendar date of `ms`. */
  private static etDay(ms: number): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  }

  /** Closes of the last completed session before today (ET): weekdays back, skipping holidays. */
  private async officialPrev(now: number): Promise<Map<string, number>> {
    const today = QuoteReferenceCache.etDay(now);
    if (this.prev?.forDay === today) return this.prev.closes;
    this.prevLoading ??= (async () => {
      for (let back = 1; back <= 7; back++) {
        const d = new Date(
          Date.parse(`${today}T12:00:00Z`) - back * 86_400_000,
        );
        if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
        const bars: Array<{ T?: string; c?: number }> = await this.groupedDaily(
          d.toISOString().slice(0, 10),
        ).catch(() => []);
        if (bars.length > 100) {
          const closes = new Map<string, number>();
          for (const b of bars)
            if (b.T && typeof b.c === "number" && b.c > 0) closes.set(b.T, b.c);
          this.prev = { forDay: today, closes };
          return;
        }
      }
    })().finally(() => {
      this.prevLoading = null;
    });
    await this.prevLoading;
    return this.prev?.forDay === today ? this.prev.closes : new Map();
  }

  async refs(
    tickers: string[],
    now = Date.now(),
  ): Promise<Map<string, QuoteRef>> {
    const out = new Map<string, QuoteRef>();
    if (tickers.length === 0) return out;
    const [prev] = await Promise.all([
      this.officialPrev(now),
      (async () => {
        const need = tickers.filter((t) => {
          const hit = this.rows.get(t);
          return !hit || now - hit.at > this.refMs;
        });
        for (let i = 0; i < need.length; i += 250) {
          const got = (await this.rawSnapshot(need.slice(i, i + 250)).catch(
            () => [],
          )) as PolygonSnapshotRow[];
          for (const r of got)
            if (r?.ticker) this.rows.set(String(r.ticker), { at: now, row: r });
        }
        if (this.rows.size > 20_000) this.rows.clear();
      })(),
    ]);
    const openMs = regularOpenMs(now);
    for (const t of tickers) {
      const row = this.rows.get(t)?.row;
      if (row)
        out.set(t, quoteRefFromPolygon(row, prev.get(t) ?? null, openMs));
      // No snapshot row (a failed call, not proof of no trade): only the base.
      else if (prev.has(t))
        out.set(t, {
          prevClose: prev.get(t) ?? null,
          tradedToday: true,
          sessionLow: null,
          sessionHigh: null,
          sessionPrice: null,
          lastMinuteAt: null,
          otc: false,
        });
    }
    return out;
  }
}
