/**
 * The price a stock's year-to-date move is measured FROM.
 *
 * One definition for every reader, so the app never shows two different YTDs for
 * one stock: the SI peers table (ondemand.service.withYtdBase) and the Heatmap's
 * YTD frame (technical-indicators.job writes it onto the company doc) both call
 * this.
 *
 * It comes from Polygon's split-ADJUSTED daily bars rather than from our stored
 * bars: the stored series is a cached document topped up with only the newest few
 * bars, so after a split its old closes can stay unadjusted. A base up to a year
 * old taken from there would read a 2:1 split as -50% YTD.
 */

/** The two fields of a daily aggregate this reads (`t` = ms epoch, `c` = close). */
export interface YtdAggBar {
  t: number;
  c?: number | null;
}

/** The slice of the vendor client this needs, so a test can pass a stub. */
export interface YtdBarSource {
  getAggsRange(ticker: string, from: string, to: string): Promise<YtdAggBar[]>;
}

export interface YtdBase {
  /** The price YTD is measured from; null when none could be found. */
  close: number | null;
  /**
   * Set only for a stock with no close before this year (listed this year): the
   * ET date of its first close, which is then the base. Null otherwise.
   */
  since: string | null;
  /** The ET calendar year this base is for, i.e. the year the YTD runs in. */
  year: number;
  /**
   * True when a vendor call threw. `close` is then null because we do not know,
   * not because the stock has no history; a writer must keep what it already has.
   */
  failed: boolean;
}

const etIso = (ms: number): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));

/**
 * The last close on or before 31 Dec of the prior ET year, looking back to 15 Dec
 * so a halted or thinly traded name still has one. With no close in that window
 * the stock was listed this year: the base is then its first close since listing
 * (`since` says which day). A stock with no bars at all this year gets null.
 */
export async function fetchYtdBase(
  source: YtdBarSource,
  ticker: string,
  now: number = Date.now(),
): Promise<YtdBase> {
  const year = Number(etIso(now).slice(0, 4));
  const target = `${year - 1}-12-31`;
  const from = `${year - 1}-12-15`;
  let failed = false;
  const range = (a: string, b: string) =>
    source.getAggsRange(ticker, a, b).catch(() => {
      failed = true;
      return [] as YtdAggBar[];
    });

  const bars = await range(from, target);
  const base = bars
    .filter((b) => b.c != null && b.c > 0 && etIso(b.t) <= target)
    .sort((a, b) => a.t - b.t)
    .at(-1);
  let close = base?.c ?? null;
  let since: string | null = null;
  if (close == null) {
    // No close before this year: it was listed this year. Measure from its first close.
    const thisYear = await range(`${year}-01-01`, etIso(now));
    const first = thisYear
      .filter((b) => b.c != null && b.c > 0)
      .sort((a, b) => a.t - b.t)[0];
    if (first) {
      close = first.c ?? null;
      since = etIso(first.t);
    }
  }
  return { close, since, year, failed };
}

/**
 * The fields the nightly job merges onto a company doc. Nothing when no base was
 * found: a vendor hiccup must not overwrite last night's good value with null.
 */
export function ytdFields(
  b: YtdBase,
): { ytdBaseClose: number; ytdSince: string | null; ytdYear: number } | null {
  if (b.close == null) return null;
  return {
    ytdBaseClose: Math.round(b.close * 10000) / 10000,
    ytdSince: b.since,
    ytdYear: b.year,
  };
}
