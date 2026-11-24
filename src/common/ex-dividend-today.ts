import { etParts } from "./et-calendar";

/** One row of FMP's `/stable/dividends-calendar` — only the fields read here. */
export interface DividendCalendarRow {
  symbol?: unknown;
  date?: unknown;
  dividend?: unknown;
}

/** "2026-11-24" for the Eastern calendar day of `ms`. */
function etDay(ms: number): string {
  const p = etParts(ms);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** FMP spells class shares with a dash (BRK-B); the app's ticker is BRK.B. */
function canonical(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/-/g, ".");
}

/**
 * Cash dividends going ex TODAY, by ticker (summed when a stock has a regular
 * and a special one the same day).
 *
 * Why the quote guard needs it: on the ex-date the exchange (and Google, Yahoo,
 * FMP) measure the day's change from the prior close LESS the dividend, so the
 * move shows what the shares did rather than the cash that left them. COST went
 * ex a $30 special dividend on 24 Nov 2026: 1,097.91 - 30 = 1,067.91, so the
 * quote read +2.1% while the raw price was down. Polygon's official close is not
 * adjusted, so without this the app showed -0.7% beside every other site's +2.1%.
 *
 * One calendar request per Eastern day, shared by every caller. A failed load
 * returns an empty map and is retried after RETRY_MS, so a vendor hiccup leaves
 * quotes exactly as they were before this existed.
 */
export class ExDividendToday {
  private day: string | null = null;
  private amounts = new Map<string, number>();
  private failedAt = 0;
  private loading: Promise<void> | null = null;

  private static readonly RETRY_MS = 10 * 60_000;

  constructor(
    private readonly loadCalendar: (
      day: string,
    ) => Promise<DividendCalendarRow[]>,
  ) {}

  async get(now: number = Date.now()): Promise<Map<string, number>> {
    const today = etDay(now);
    if (this.day === today) return this.amounts;
    if (
      this.day !== today &&
      now - this.failedAt < ExDividendToday.RETRY_MS &&
      this.failedAt > 0
    ) {
      return new Map();
    }
    this.loading ??= (async () => {
      try {
        const rows = await this.loadCalendar(today);
        const next = new Map<string, number>();
        for (const r of rows) {
          if (typeof r?.symbol !== "string" || r.date !== today) continue;
          const d =
            typeof r.dividend === "number" ? r.dividend : Number(r.dividend);
          if (!Number.isFinite(d) || d <= 0) continue;
          const t = canonical(r.symbol);
          next.set(t, (next.get(t) ?? 0) + d);
        }
        // An empty answer on a trading day is far more likely a brownout than a
        // day with no dividends at all: don't pin it for the whole day.
        if (next.size === 0) throw new Error("empty dividend calendar");
        this.amounts = next;
        this.day = today;
        this.failedAt = 0;
      } catch {
        this.failedAt = now;
      }
    })().finally(() => {
      this.loading = null;
    });
    await this.loading;
    return this.day === today ? this.amounts : new Map();
  }
}

/** The calendar request both quote services use. */
export function dividendCalendarPath(day: string): string {
  return `dividends-calendar?from=${day}&to=${day}`;
}
