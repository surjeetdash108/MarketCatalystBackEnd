/**
 * Late-reported prints in Polygon/Massive intraday bars.
 *
 * Polygon's aggregates count a trade in the minute it was REPORTED, not the
 * minute it happened. A batch of opening-auction trades reported hours late
 * therefore lands as tall wicks in the middle of the afternoon: ANT on
 * 2026-11-19 showed highs of $112.96 on 30 minutes between 14:26 and 15:02 ET
 * (and $115.10 at 15:05) while it traded at $95–99. Open and close are not
 * moved by those prints, so the candle bodies stay a clean reference.
 *
 * Rule: a bar's high (low) is a late print when it sits more than
 *   max(5% of the bar's price, 10 x the median |close - open| of its neighbours)
 * above (below) every open/close of the bar and its neighbours — 10 bars each
 * side, same New York day. A flagged extreme is clipped to the bar's own body.
 *
 * Calibrated 2026-11-20 on real data: catches all 31 fake ANT bars and flags
 * 0 of 106,314 regular-session minutes over 300 symbol-days (50 small/mid caps
 * + 10 large caps, 5 sessions) — no official day high/low is clipped. A looser
 * 4% / 8x clipped one real official low, so the thresholds are not tighter.
 */
export interface IntradayBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

const WINDOW = 10;
const MIN_PCT = 0.05;
const BODY_MULTIPLE = 10;

const nyDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const finite = (...xs: number[]) =>
  xs.every((x) => typeof x === "number" && Number.isFinite(x));

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Returns a copy of `bars` (sorted by t) with late-print highs/lows clipped to
 * each bar's body. Open, close, volume and time are never changed; bars that
 * aren't flagged are returned as the same objects.
 */
export function clipLatePrintSpikes<B extends IntradayBar>(bars: B[]): B[] {
  if (bars.length < 4) return bars;
  const day = bars.map((b) =>
    Number.isFinite(b.t) ? nyDay.format(new Date(b.t)) : "",
  );
  return bars.map((b, i) => {
    if (!finite(b.o, b.h, b.l, b.c)) return b;
    const nb: B[] = [];
    for (
      let j = Math.max(0, i - WINDOW);
      j <= Math.min(bars.length - 1, i + WINDOW);
      j++
    ) {
      const x = bars[j];
      if (j !== i && day[j] === day[i] && finite(x.o, x.c)) nb.push(x);
    }
    if (nb.length < 3) return b;
    const typicalBody = median(nb.map((x) => Math.abs(x.c - x.o)));
    const bodyTop = Math.max(b.o, b.c);
    const bodyBottom = Math.min(b.o, b.c);
    let top = bodyTop;
    let bottom = bodyBottom;
    for (const x of nb) {
      top = Math.max(top, x.o, x.c);
      bottom = Math.min(bottom, x.o, x.c);
    }
    const threshold = Math.max(MIN_PCT * bodyTop, BODY_MULTIPLE * typicalBody);
    const highOut = b.h - top > threshold;
    const lowOut = bottom - b.l > threshold;
    if (!highOut && !lowOut) return b;
    return { ...b, h: highOut ? bodyTop : b.h, l: lowOut ? bodyBottom : b.l };
  });
}
