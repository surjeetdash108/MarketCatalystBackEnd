import { FmpService, type FmpSplitRow } from "../vendors/fmp/fmp.service";

/**
 * Analyst-ratings seam — Polygon has no analyst/ratings/consensus endpoint on
 * any tier, so `analyst-actions.job` is a no-op without this. Kept behind an
 * adapter so it is fully optional/removable: when ANALYST_SOURCE is "none"
 * (default) the token resolves to null and the job stays a no-op.
 *
 * The shape matches the frontend `AnalystConsensusDoc` (analyst.tsx / stock.tsx):
 * the five rating tallies + consensus label, plus (FMP) the price-target
 * consensus, its rolling-average trend, and the recent per-firm rating changes
 * that populate the "Per-firm analyst actions" feed.
 */

/** One per-firm rating change (upgrade/downgrade/initiate/maintain). */
export interface AnalystRatingChange {
  date: string;
  firm: string | null;
  previousGrade: string | null;
  newGrade: string | null;
  action: string | null;
  /** THIS firm's own 12-month price target standing as of the grade (from FMP
   * price-target-news, or parsed from a grades-news headline). null when the
   * firm posted no target in the window — never the ticker's consensus, so
   * per-firm rows don't all show the same number. */
  priceTarget: number | null;
  /** Date (YYYY-MM-DD) the firm posted `priceTarget` — lets the UI show "as of"
   * when a reiteration carries forward an earlier target. null with it. */
  priceTargetDate: string | null;
  /** The target this firm's `priceTarget` replaced, so the UI can show
   * "$93 → $80 (−14.0%)". Taken from the firm's own headline ("lowered to $80
   * from $93") when one states it, else the firm's previous post in the feed.
   * On the same (current) share basis as `priceTarget`. null when neither
   * source has it (first call in the feed, or the firm has no target). */
  previousPriceTarget: number | null;
}

export interface AnalystConsensus {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
  consensus: string | null;
  // ── Price target (12-month, across covering firms) ──
  priceTargetConsensus: number | null;
  priceTargetHigh: number | null;
  priceTargetLow: number | null;
  priceTargetMedian: number | null;
  // ── Price-target trend (rolling averages) ──
  ptAvgLastMonth: number | null;
  ptAvgLastQuarter: number | null;
  ptAvgLastYear: number | null;
  // ── Recent per-firm rating changes (newest first) ──
  recentGrades: AnalystRatingChange[];
}

export interface AnalystRatingsAdapter {
  readonly sourceName: string;
  /** Consensus + price target + recent grades for one ticker, or null when the
   * vendor has no coverage. */
  getConsensus(ticker: string): Promise<AnalystConsensus | null>;
}

/**
 * Coerce a rating tally to a non-null number for storage.
 *
 * KNOWN LIMITATION: this collapses a MISSING bucket (vendor didn't report that
 * grade) to 0, so a stored `hold: 0` cannot be distinguished from "0 analysts
 * hold" vs "hold not reported". The shape is preserved deliberately because the
 * UI type (MarketCatalystUI/app/iq/types/analyst.ts) currently types the five
 * tallies as non-null `number`, and the aggregate is salvaged when total === 0
 * (below) — a covered ticker always has at least one non-zero bucket, so the
 * salvage still fires correctly. FMP's `num()` now preserves a genuine 0
 * (previously it dropped to null), so a real reported 0 survives to here.
 *
 * FOLLOW-UP (needs the UI change, out of scope here): widen the UI tallies to
 * `number | null`, keep null for absent buckets, and sum with `(x ?? 0)` so the
 * "not reported" vs "reported 0" distinction is preserved end to end.
 */
const n = (v: number | null | undefined): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/** How many recent per-firm rating changes to keep per ticker. */
/**
 * Grade retention — why this is a selection, not just a slice.
 *
 * This used to keep the 8 most recent rows per ticker. Measured on prod, 89% of
 * all stored grade rows are "maintain" (3,132 of 3,529), so the 8 newest were
 * almost always maintains and the rarer events were truncated away: the
 * Analyst Actions > Initiations tab matched ZERO rows across 460 tickers,
 * because not one initiation survived the cut.
 *
 * FMP's `grades` endpoint ignores its own limit param and returns the full
 * history in one response, so looking deeper costs no extra API call — only a
 * bigger slice of an array we already downloaded. We now scan deep, keep the
 * rating CHANGES first, then backfill with recent maintains for context.
 */
const GRADES_SCAN = 200;
/** Rating changes (anything not "maintain") retained per ticker. */
const GRADES_EVENTS = 14;
/** Hard cap on stored rows per ticker — keeps the doc small. */
const GRADES_TOTAL = 20;

/**
 * FMP's `grades` feed never labels a coverage initiation: across 8,546 stored
 * rows the only action values are maintain / upgrade / downgrade. The one
 * structural signal it does carry is an EMPTY previousGrade with a real
 * newGrade — a firm rating a stock it had no prior rating on. That is an
 * initiation, so it is labelled as one here rather than shipping a blank
 * action the UI cannot categorise.
 *
 * This currently matches a single row in the whole universe, so it does not
 * make the Initiations tab useful on its own — the vendor simply does not
 * supply the event. It is here so the classification is correct if FMP starts
 * populating it, and so the row stops rendering with an empty action.
 */
export function normaliseGradeAction(
  action: string | null,
  previousGrade: string | null,
  newGrade: string | null,
): string | null {
  const a = (action ?? "").trim();
  const prev = (previousGrade ?? "").trim();
  const next = (newGrade ?? "").trim();
  if (prev === "" && next !== "" && (a === "" || /^init/i.test(a))) return "initiate";
  return a === "" ? null : a;
}

/** A rating CHANGE rather than a reiteration. Anything that is not an explicit
 *  "maintain" counts, so an action FMP adds later (resume, drop coverage) is
 *  surfaced rather than silently discarded. */
function isRatingEvent(action: string | null | undefined): boolean {
  return !/^\s*maintain/i.test(action ?? "");
}

/**
 * Newest-first rows in, at most GRADES_TOTAL out: every rating change up to
 * GRADES_EVENTS, then the most recent maintains to fill the remainder.
 */
export function selectGrades<T extends { action: string | null; date: string }>(
  rows: T[],
): T[] {
  const events = rows.filter((r) => isRatingEvent(r.action)).slice(0, GRADES_EVENTS);
  const room = Math.max(0, GRADES_TOTAL - events.length);
  const maintains = rows.filter((r) => !isRatingEvent(r.action)).slice(0, room);
  return [...events, ...maintains].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * How far back a grade may reach for its firm's standing target.
 *
 * A rating CHANGE (upgrade/downgrade/initiate) almost always comes with a new
 * target the same day, so an older one belongs to a different thesis and a stale
 * number pinned to the row is worse than none (BUG-DATA-012) — keep it tight.
 *
 * A "maintain" is the firm reiterating its stance, and its target stands until
 * the firm posts a new one. Reiterations routinely land 2–5 months after the
 * last PT post (AME/Baird 61d, AMZN/TD Cowen 66d, BETA/Cantor 145d), so the old
 * shared 45-day window blanked exactly the rows users check against the web.
 */
const MAX_TARGET_AGE_DAYS_EVENT = 45;
const MAX_TARGET_AGE_DAYS_MAINTAIN = 180;
/** A target may post shortly AFTER the grade it belongs to (news lag vs the
 *  grade's own date). Anything later is the firm's NEXT call, never this one's. */
const TARGET_POST_GRACE_DAYS = 3;
/** How far before a target post its firm's prior post may be to count as the
 *  target it replaced. FMP keeps only ~100 posts, so an older one may skip
 *  calls that fell out of the window. */
const MAX_PREVIOUS_TARGET_AGE_DAYS = 365;
/** A "from" figure can predate a split the "to" figure already reflects, often
 *  months later (CVNA 5:1 on 2026-05-08; Oppenheimer "to $90 from $450" on
 *  2026-09-30). Splits this far back are considered when reading one. */
const SPLIT_LOOKBACK_DAYS = 365;
const DAY_MS = 86_400_000;

// COVERAGE NOTE: some firms publish rating changes to `grades` but never post
// to `price-target-news` — verified against the raw feed, where Citigroup (169
// actions), JP Morgan (148), TD Cowen (125), B of A, Keefe Bruyette, Benchmark
// and Citizens are absent from all 100 rows FMP will return. Their PT changes
// DO appear as `grades-news` headlines ("price target raised to $350 from $340
// at TD Cowen"), so targets parsed from those headlines are merged in (see
// headlineTarget). A firm in neither feed (e.g. Citizens on BRZE, whose
// headlines state no number) stays blank by design; substituting the ticker's
// consensus would pin a number that firm never published (BUG-DATA-012).
//
// FMP's `grades` and `price-target-news` feeds spell the SAME firm differently
// ("JP Morgan" vs "JPMorgan Chase", "TD Cowen" vs "Cowen", "Piper Sandler" vs
// "Piper Jaffray"), so an exact normalized-name match dropped ~30% of per-firm
// targets. canonicalFirm() strips generic corporate qualifiers and folds
// well-known variants to one key so the feeds join — still an EXACT match on
// the canonical key (no risky prefix/substring fallback that could attach a
// different firm's number, BUG-DATA-012).
const FIRM_QUALIFIERS =
  /\b(and|co|inc|incorporated|llc|lp|plc|ltd|group|holdings|securities|research|partners|advisors|advisers|corp|corporation|company|financial)\b/g;
const FIRM_ALIASES: Record<string, string> = {
  jpmorganchase: "jpmorgan",
  jpmorgan: "jpmorgan",
  tdcowen: "cowen",
  cowen: "cowen",
  bankofamerica: "bofa",
  bofa: "bofa",
  merrilllynch: "bofa",
  bofamerrilllynch: "bofa",
  piperjaffray: "pipersandler",
  pipersandler: "pipersandler",
  evercoreisi: "evercore",
  evercore: "evercore",
  sanfordcbernstein: "bernstein",
  bernstein: "bernstein",
  citigroup: "citi",
  citi: "citi",
  robertwbaird: "baird",
  baird: "baird",
  stifelnicolaus: "stifel",
  stifel: "stifel",
  deutschebank: "deutsche",
  deutsche: "deutsche",
  goldmansachs: "goldman",
  goldman: "goldman",
  keybanccapitalmarkets: "keybanc",
  keybanc: "keybanc",
  rbccapitalmarkets: "rbc",
  rbc: "rbc",
  wellsfargo: "wellsfargo",
  morganstanley: "morganstanley",
  raymondjames: "raymondjames",
  truist: "truist",
  mizuho: "mizuho",
  susquehanna: "susquehanna",
  // JMP Securities rebranded as Citizens JMP; `grades` now says "Citizens".
  citizensjmp: "citizens",
  jmp: "citizens",
  citizens: "citizens",
  keefebruyettewoods: "kbw",
  kbw: "kbw",
};

/** Fold a firm name to a stable key so the two FMP feeds can be joined. */
function canonicalFirm(name: string | null): string {
  if (!name) return "";
  const stripped = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(FIRM_QUALIFIERS, " ")
    .replace(/[^a-z0-9]/g, "");
  return FIRM_ALIASES[stripped] ?? stripped;
}

/**
 * True when the headline itself names the firm `firmKey` (a canonicalFirm key).
 *
 * `grades-news` firm attribution is not trustworthy on its own: every BRZE
 * "…Reiterated at Market Outperform by Citizens…" headline is tagged
 * gradingCompany "Citigroup". Trusting the tag would pin one firm's target on
 * another (BUG-DATA-012), so the headline must independently name the firm.
 * Matches canonicalised 1–4 word runs, so "TD Cowen" ↔ "Cowen & Co." and
 * "J.P. Morgan" ↔ "JPMorgan Chase" agree while "Citizens" never reads as "Citi".
 */
export function headlineNamesFirm(title: string, firmKey: string): boolean {
  if (!firmKey) return false;
  const words = title.toLowerCase().split(/[^a-z0-9&]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let len = 1; len <= 4 && i + len <= words.length; len++) {
      if (canonicalFirm(words.slice(i, i + len).join(" ")) === firmKey) return true;
    }
  }
  return false;
}

const AMOUNT = String.raw`\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)`;
const HEADLINE_TARGET_PATTERNS = [
  // "price target raised to $350 from $340", "PT Lowered to $38"
  new RegExp(String.raw`(?:\btarget|\bPT)\b[^$]{0,40}?\bto ${AMOUNT}`, "gi"),
  // "price target of $45", "PT at $45"
  new RegExp(String.raw`(?:\btarget|\bPT)\s+(?:of|at)\s+${AMOUNT}`, "gi"),
  // "sets $50 price target", "with $50 PT"
  new RegExp(String.raw`${AMOUNT}\s+(?:price\s+)?(?:target|PT)\b`, "gi"),
];

/**
 * The NEW price target stated in a rating-news headline, or null.
 *
 * Returns null unless exactly one target figure is stated: a roundup headline
 * quoting several firms' numbers cannot be attributed safely. The "from $340"
 * half of a change is never captured — only the figure the target moved TO.
 */
export function headlineTarget(title: string): number | null {
  const found = new Set<number>();
  for (const re of HEADLINE_TARGET_PATTERNS) {
    for (const m of title.matchAll(re)) {
      const v = parseAmount(m[1]);
      if (v != null) found.add(v);
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

// "price target lowered to $80 from $93" — the "from" figure is group 2.
const HEADLINE_PREVIOUS_PATTERN = new RegExp(
  String.raw`\bto ${AMOUNT},?\s+from ${AMOUNT}`,
  "gi",
);

/**
 * The target a rating-news headline says was REPLACED ("to $80 from $93" → 93),
 * or null. Only read when the headline states exactly one new target and the
 * "from" is attached to that same figure, so a roundup cannot leak another
 * firm's number in.
 */
export function headlinePreviousTarget(title: string): number | null {
  const target = headlineTarget(title);
  if (target == null) return null;
  const found = new Set<number>();
  for (const m of title.matchAll(HEADLINE_PREVIOUS_PATTERN)) {
    const prev = parseAmount(m[2]);
    if (parseAmount(m[1]) === target && prev != null) found.add(prev);
  }
  return found.size === 1 ? [...found][0] : null;
}

function parseAmount(raw: string): number | null {
  const v = Number(raw.replace(/,/g, ""));
  return Number.isFinite(v) && v > 0 && v < 1_000_000 ? v : null;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Restate a price quoted on `date` on today's share basis: divided by every
 * split executed after that date. Targets from both sides of a split are then
 * comparable with each other and with the current share price.
 */
export function toCurrentShareBasis(
  value: number,
  date: string,
  splits: ReadonlyArray<FmpSplitRow>,
): number {
  let factor = 1;
  for (const s of splits) if (s.date > date) factor *= s.ratio;
  return round2(value / factor);
}

/**
 * Put a headline's "from" figure on the same share basis as its "to" figure.
 *
 * Posted after a split, "adjusted to $93 from $475" quotes the old target on
 * the PRE-split basis. Nothing in the headline says which basis the "from" is
 * on, so it is rescaled by a recent split only when that lands it closer to the
 * new target: genuine target changes are far smaller than split ratios.
 */
export function alignPreviousToSplits(
  previous: number,
  target: number,
  date: string,
  splits: ReadonlyArray<FmpSplitRow>,
): number {
  const postTime = Date.parse(date);
  if (!Number.isFinite(postTime)) return previous;
  const distance = (v: number) => Math.abs(Math.log(v / target));
  let best = previous;
  for (const s of splits) {
    const age = postTime - Date.parse(s.date);
    if (!(age >= 0 && age <= SPLIT_LOOKBACK_DAYS * DAY_MS)) continue;
    const rescaled = previous / s.ratio;
    if (distance(rescaled) < distance(best)) best = rescaled;
  }
  return best;
}

/** One target post for a firm, on the current share basis. `previousTarget` is
 *  the replaced target its headline stated, when it stated one. */
export interface FirmTargetPost {
  date: string;
  priceTarget: number;
  previousTarget?: number | null;
}

export interface ResolvedFirmTarget {
  priceTarget: number;
  date: string;
  previousPriceTarget: number | null;
}

/**
 * The firm's target standing as of `gradeDate`: its most recent post on or
 * before the grade (plus a short news-lag grace), no older than the action's
 * window. Never a target posted well after the grade — that is the firm's next
 * call, and the old "nearest in either direction" rule pinned future numbers
 * onto past rows. `posts` may be in any order.
 */
export function resolveFirmTarget(
  posts: ReadonlyArray<FirmTargetPost>,
  gradeDate: string,
  action: string | null,
): ResolvedFirmTarget | null {
  const gradeTime = Date.parse(gradeDate);
  if (!Number.isFinite(gradeTime)) return null;
  const maxAgeDays = isRatingEvent(action)
    ? MAX_TARGET_AGE_DAYS_EVENT
    : MAX_TARGET_AGE_DAYS_MAINTAIN;
  const earliest = gradeTime - maxAgeDays * DAY_MS;
  const latest = gradeTime + TARGET_POST_GRACE_DAYS * DAY_MS;
  let best: FirmTargetPost | null = null;
  let bestTime = -Infinity;
  for (const p of posts) {
    const t = Date.parse(p.date);
    if (Number.isFinite(t) && t >= earliest && t <= latest && t > bestTime) {
      bestTime = t;
      best = p;
    }
  }
  if (!best) return null;
  return {
    priceTarget: best.priceTarget,
    date: best.date,
    previousPriceTarget: previousFirmTarget(posts, best, bestTime),
  };
}

/**
 * The target `current` replaced.
 *
 * The firm's own headline wins: the feed's history can disagree with it (CVNA
 * Barclays: the feed's prior post is $94, the headline and Benzinga both say
 * "$80 from $93"). The same call often arrives twice (price-target-news and
 * grades-news, a day or two apart), so a stated "from" on either copy counts.
 * Without one, fall back to the firm's last earlier post, skipping those
 * duplicate copies so a call is never compared with itself.
 */
function previousFirmTarget(
  posts: ReadonlyArray<FirmTargetPost>,
  current: FirmTargetPost,
  currentTime: number,
): number | null {
  const isSameCall = (p: FirmTargetPost, t: number) =>
    p.priceTarget === current.priceTarget &&
    Math.abs(t - currentTime) <= TARGET_POST_GRACE_DAYS * DAY_MS;

  if (current.previousTarget != null) return current.previousTarget;
  for (const p of posts) {
    if (p.previousTarget != null && isSameCall(p, Date.parse(p.date)))
      return p.previousTarget;
  }

  const earliest = currentTime - MAX_PREVIOUS_TARGET_AGE_DAYS * DAY_MS;
  let prev: number | null = null;
  let prevTime = -Infinity;
  for (const p of posts) {
    const t = Date.parse(p.date);
    if (!Number.isFinite(t) || t >= currentTime || t < earliest || t <= prevTime) continue;
    if (isSameCall(p, t)) continue;
    prevTime = t;
    prev = p.priceTarget;
  }
  return prev;
}

/** FMP-backed ratings: grades-consensus + price-target + grades (per ticker). */
export class FmpAnalystRatingsAdapter implements AnalystRatingsAdapter {
  readonly sourceName = "fmp";

  constructor(private readonly fmp: FmpService) {}

  async getConsensus(ticker: string): Promise<AnalystConsensus | null> {
    const row = await this.fmp.getAnalystConsensus(ticker);
    if (!row) return null;
    const total =
      n(row.strongBuy) +
      n(row.buy) +
      n(row.hold) +
      n(row.sell) +
      n(row.strongSell);
    if (total === 0) return null; // no coverage — leave the ticker untouched

    // Enrich a covered ticker with price target + recent grades. Each is
    // independent and best-effort: a miss degrades that field to null/[] rather
    // than dropping the whole (already-valid) consensus row.
    const [pt, summary, grades, targets, gradeNews, splits] = await Promise.all([
      this.fmp.getPriceTargetConsensus(ticker).catch(() => null),
      this.fmp.getPriceTargetSummary(ticker).catch(() => null),
      this.fmp.getGrades(ticker, GRADES_SCAN).catch(() => []),
      this.fmp.getPriceTargets(ticker).catch(() => []),
      this.fmp.getGradeNews(ticker).catch(() => []),
      this.fmp.getSplits(ticker).catch(() => []),
    ]);

    // Index each firm's posted targets so a grade can pick up its OWN firm's
    // target. Match on an EXACT canonicalFirm() key: canonicalization folds
    // spelling variants between the FMP feeds ("JP Morgan"/"JPMorgan Chase") to
    // one key, but it is still an exact key match — no prefix/substring
    // fallback, which could collide between distinct firms ("Morgan" ⊂ "Morgan
    // Stanley") and attach the wrong firm's number (BUG-DATA-012). An unmapped
    // firm still yields null rather than a guess.
    //
    // Every post is restated on today's share basis, so targets from either
    // side of a split compare with each other and with the current price.
    const ptByFirm = new Map<string, FirmTargetPost[]>();
    const addTarget = (
      key: string,
      date: string,
      priceTarget: number,
      statedPrevious: number | null,
    ) => {
      if (!key || !date) return;
      const previous =
        statedPrevious == null
          ? null
          : alignPreviousToSplits(statedPrevious, priceTarget, date, splits);
      const list = ptByFirm.get(key) ?? [];
      list.push({
        date,
        priceTarget: toCurrentShareBasis(priceTarget, date, splits),
        previousTarget:
          previous == null ? null : toCurrentShareBasis(previous, date, splits),
      });
      ptByFirm.set(key, list);
    };
    for (const t of targets) {
      if (!t.firm || t.priceTarget == null) continue;
      // Trust the headline's "from" only when its "to" is this row's target.
      const stated =
        t.title && headlineTarget(t.title) === t.priceTarget
          ? headlinePreviousTarget(t.title)
          : null;
      addTarget(canonicalFirm(t.firm), t.date, t.priceTarget, stated);
    }
    // Headline-stated targets fill firms price-target-news omits. Only kept when
    // the headline itself names the tagged firm (FMP mis-tags some headlines).
    for (const h of gradeNews) {
      const key = canonicalFirm(h.firm);
      const value = headlineTarget(h.title);
      if (value != null && headlineNamesFirm(h.title, key))
        addTarget(key, h.date, value, headlinePreviousTarget(h.title));
    }
    const targetFor = (g: { gradingCompany: string | null; date: string; action: string | null }) =>
      resolveFirmTarget(ptByFirm.get(canonicalFirm(g.gradingCompany)) ?? [], g.date, g.action);

    return {
      strongBuy: n(row.strongBuy),
      buy: n(row.buy),
      hold: n(row.hold),
      sell: n(row.sell),
      strongSell: n(row.strongSell),
      consensus: row.consensus ?? null,
      priceTargetConsensus: pt?.targetConsensus ?? null,
      priceTargetHigh: pt?.targetHigh ?? null,
      priceTargetLow: pt?.targetLow ?? null,
      priceTargetMedian: pt?.targetMedian ?? null,
      ptAvgLastMonth: summary?.lastMonthAvg ?? null,
      ptAvgLastQuarter: summary?.lastQuarterAvg ?? null,
      ptAvgLastYear: summary?.lastYearAvg ?? null,
      recentGrades: selectGrades(grades).map((g) => {
        const target = targetFor(g);
        return {
          date: g.date,
          firm: g.gradingCompany,
          previousGrade: g.previousGrade,
          newGrade: g.newGrade,
          action: normaliseGradeAction(g.action, g.previousGrade, g.newGrade),
          priceTarget: target?.priceTarget ?? null,
          priceTargetDate: target?.date ?? null,
          previousPriceTarget: target?.previousPriceTarget ?? null,
        };
      }),
    };
  }
}
