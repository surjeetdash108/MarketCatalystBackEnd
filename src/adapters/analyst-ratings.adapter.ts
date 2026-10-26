import { FmpService, type FmpSplitRow } from "../vendors/fmp/fmp.service";
import { consensusLabel } from "../common/consensus-label.util";

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
  /** The target THIS firm posted with THIS call (FMP price-target-news, or
   * parsed from a grades-news headline), within a day before / a few days
   * after the grade. null when the firm posted none with the call — never an
   * older target carried forward, and never the ticker's consensus. */
  priceTarget: number | null;
  /** Date (YYYY-MM-DD, New York) the firm posted `priceTarget`. null with it. */
  priceTargetDate: string | null;
  /** The target this firm's `priceTarget` replaced, so the UI can show
   * "$93 → $80 (−14.0%)". Taken from the firm's own headline ("lowered to $80
   * from $93") when one states it, else the firm's previous post in the feed.
   * On the same (current) share basis as `priceTarget`. null when neither
   * source has it (first call in the feed, or the firm has no target). */
  previousPriceTarget: number | null;
  /** Direction of the target change made with this call, when the firm's own
   * headline says it ("price target raised…", "PT Lowered…") or both figures
   * are known. Lets a "maintain" grade read as the PT Raise / PT Cut it was
   * even when the feed omits the figure. null when nothing says. */
  priceTargetChange?: "raise" | "cut" | null;
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
  /** Every rating change on record for one ticker, newest first. */
  getGradeHistory?(ticker: string): Promise<AnalystRatingChange[]>;
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
 * Firms that rated the stock within this window count toward the consensus
 * tallies. Measured against Yahoo on 9 names (Oct 2026): FMP's raw tallies
 * were off by ~24 analysts on average (CRM 98 vs 56), a 12-month window by
 * ~15 the other way (CRM 36), 36 months by ~8 (CRM 47, XOM 25 = 25). Firms
 * often hold coverage for years without a new grade row, hence the long window.
 */
const ACTIVE_COVERAGE_DAYS = 3 * 365;
/** Firms' standing price targets count toward low/mean/high within this window. */
const ACTIVE_TARGET_DAYS = 365;
/** Below this many active firms, FMP's own tallies are kept. */
const MIN_ACTIVE_FIRMS = 3;

type RatingBucket = "strongBuy" | "buy" | "hold" | "sell" | "strongSell";

/** A firm's rating wording → one of the five consensus buckets (null if unknown). */
export function ratingBucket(grade: string | null | undefined): RatingBucket | null {
  const g = (grade ?? "").toLowerCase().trim();
  if (!g) return null;
  if (/strong\s*sell/.test(g)) return "strongSell";
  if (/strong\s*buy|conviction buy|top pick/.test(g)) return "strongBuy";
  if (/under\s*perform|under\s*weight|\bsell\b|\breduce\b|negative|sector underperform/.test(g)) return "sell";
  if (/out\s*perform|over\s*weight|\bbuy\b|accumulate|positive|\badd\b|speculative buy/.test(g)) return "buy";
  if (/hold|neutral|equal|market perform|sector perform|in-line|inline|peer perform|sector weight|mixed|fair value|perform/.test(g)) return "hold";
  return null;
}

/**
 * Consensus tallies the way Yahoo / TipRanks count them: each firm's LATEST
 * rating, only for firms still covering (rated within ACTIVE_COVERAGE_DAYS).
 * FMP's grades-consensus counts every grade it holds, so firms that dropped
 * coverage years ago inflated it (CRM 98 analysts vs 56 actively covering).
 * Null when too few firms are active to say.
 */
export function activeCoverage(
  rows: ReadonlyArray<{ date: string; gradingCompany: string | null; newGrade: string | null }>,
  now = Date.now(),
): (Record<RatingBucket, number> & { consensus: string }) | null {
  const since = new Date(now - ACTIVE_COVERAGE_DAYS * DAY_MS).toISOString().slice(0, 10);
  const latest = new Map<string, { date: string; bucket: RatingBucket }>();
  for (const r of rows) {
    if (!r.gradingCompany || !r.date || r.date < since) continue;
    const bucket = ratingBucket(r.newGrade);
    if (!bucket) continue;
    const k = canonicalFirm(r.gradingCompany);
    const cur = latest.get(k);
    if (!cur || r.date > cur.date) latest.set(k, { date: r.date, bucket });
  }
  if (latest.size < MIN_ACTIVE_FIRMS) return null;
  const t: Record<RatingBucket, number> = { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 };
  for (const { bucket } of latest.values()) t[bucket]++;
  return { ...t, consensus: consensusLabel(t) as string };
}

/** Pages of per-ticker target posts / rating headlines read (100 each). */
const TARGET_HISTORY_PAGES = 3;

/** Reads up to TARGET_HISTORY_PAGES pages, stopping at the first short page. */
async function pagesOf<T>(fetchPage: (page: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < TARGET_HISTORY_PAGES; page++) {
    const rows = await fetchPage(page).catch(() => [] as T[]);
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

/** Upper bound on a stock's full rating history (FMP returns it all in one call). */
const GRADES_HISTORY_MAX = 2000;

type TargetLookup = ((g: { gradingCompany: string | null; date: string; action?: string | null }) => ResolvedFirmTarget | null) & {
  /** A target move the firm's headline states for this call when no figure is known. */
  directionFor: (g: { gradingCompany: string | null; date: string }) => "raise" | "cut" | null;
  /** Each firm's most recent posted target (current share basis). */
  latestByFirm: Map<string, { date: string; priceTarget: number }>;
  /** Initiations discovered from rating news or price-target news headlines. */
  initiations: Array<{
    date: string;
    gradingCompany: string | null;
    previousGrade: string | null;
    newGrade: string | null;
    action: string | null;
  }>;
};

/** Low / high / median / mean of each firm's latest target within ACTIVE_TARGET_DAYS (null under MIN_ACTIVE_FIRMS). */
export function activeTargetStats(
  latestByFirm: ReadonlyMap<string, { date: string; priceTarget: number }>,
  now = Date.now(),
): { low: number; high: number; median: number; mean: number } | null {
  const since = new Date(now - ACTIVE_TARGET_DAYS * DAY_MS).toISOString().slice(0, 10);
  const v = [...latestByFirm.values()].filter((p) => p.date >= since && p.priceTarget > 0).map((p) => p.priceTarget).sort((a, b) => a - b);
  if (v.length < MIN_ACTIVE_FIRMS) return null;
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { low: r2(v[0]), high: r2(v[v.length - 1]), median: r2(median), mean: r2(v.reduce((a, b) => a + b, 0) / v.length) };
}

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
 * Which target posts belong to a grade: only the call's own.
 *
 * Grades used to carry the firm's standing target forward (45 days for a
 * rating change, 180 for a maintain) and the UI marked it "as of …". Checked
 * against the public record (Oct 2026 E2E, 100 tickers) that was wrong far
 * more often than right: a reiteration usually comes WITH a new target the
 * feed lacks, so the carried number was stale (41 rows), the % to target was
 * computed from it (45), and with no "previous" the call read "Maintain" when
 * it was a PT Raise/Cut. A row now shows only a target posted with the call;
 * otherwise "—".
 *
 * The post may be dated a day BEFORE the grade (an after-close note that FMP's
 * grade dates the next session: CSCO / Deutsche Bank 08-31 16:28 ET vs grade
 * 09-01) or a few days AFTER it (news lag). Anything further is another call.
 */
const TARGET_PRE_GRACE_DAYS = 1;
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
// "Roth Capital", "BMO Capital Markets", "Freedom Capital Markets" — the same
// firm with and without the suffix. Only a TRAILING "capital (markets)" is
// dropped, so a name that starts with "Capital" keeps it.
const FIRM_CAPITAL_SUFFIX = /\bcapital(\s+markets)?\s*$/;
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
  // Spellings seen in the Oct 2026 E2E rows that failed to join.
  rothmkm: "roth",
  freedombroker: "freedom",
  canaccordgenuity: "canaccord",
  telseyadvisory: "telsey",
  svbleerink: "leerink",
  cantorfitzgerald: "cantor",
  seaportglobal: "seaport",
  seaport: "seaport",
};

/** Fold a firm name to a stable key so the two FMP feeds can be joined. */
export function canonicalFirm(name: string | null): string {
  if (!name) return "";
  const stripped = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(FIRM_QUALIFIERS, " ")
    .trim()
    .replace(FIRM_CAPITAL_SUFFIX, "")
    .replace(/[^a-z0-9]/g, "");
  return FIRM_ALIASES[stripped] ?? stripped;
}

/** Words that end a firm name in a headline ("at RBC Capital Following …"). */
const HEADLINE_FIRM_STOP = /^(following|after|on|as|amid|ahead|despite|with|citing|says|sees|over|into|to|for|in|from)$/i;

/**
 * The firm a rating headline attributes the call to, or null.
 *
 * FMP's firm tag is sometimes another firm entirely: CVX "price target raised
 * to $250 from $218 at HSBC" arrives a second time tagged UBS, and Freedom
 * Capital Markets' MAMA posts are tagged "Loop Capital Markets". The headline's
 * "… at <Firm>" / "… by <Firm>" / "<Firm> Starts …" names the real author.
 * A rating word in that slot ("Starts XYZ at Buy") is not a firm.
 */
export function headlineFirm(title: string | null | undefined): string | null {
  const t = String(title ?? "");
  const trailing: string[] = [];
  for (const m of t.matchAll(/\b(?:at|by)\s+([A-Z][\w.&'’-]*(?:,?\s+(?:&\s+)?[A-Z][\w.&'’-]*){0,4})/g)) {
    const words = m[1].split(/\s+/);
    const cut = words.findIndex((w) => HEADLINE_FIRM_STOP.test(w));
    trailing.push((cut === -1 ? words : words.slice(0, cut)).join(" "));
  }
  const lead = /^([A-Z][\w.&'’-]*(?:\s+[A-Z&][\w.&'’-]*){0,4})\s+(?:Starts|Initiates|Resumes|Reinstates|Upgrades|Downgrades|Raises|Lowers|Cuts|Boosts|Reiterates|Maintains)\b/.exec(t);
  // The last "at/by <Firm>" is the attribution; a leading "<Firm> Starts" next.
  for (const c of [...trailing.reverse(), ...(lead ? [lead[1]] : [])]) {
    const name = c.replace(/[,.]+$/, "").trim();
    if (name && !ratingBucket(name) && canonicalFirm(name)) return name;
  }
  return null;
}

/**
 * Direction of the target change a headline states ("price target raised…",
 * "Citi lowers Abbott PT…"), or null when it states none.
 */
export function headlineTargetDirection(title: string | null | undefined): "raise" | "cut" | null {
  const t = String(title ?? "");
  const UP = String.raw`rais(?:e|es|ed|ing)|boost(?:s|ed)?|lift(?:s|ed)?|increas(?:e|es|ed)|hik(?:e|es|ed)|bump(?:s|ed)?`;
  const DOWN = String.raw`lower(?:s|ed)?|cut(?:s)?|reduc(?:e|es|ed)|trim(?:s|med)?|slash(?:es|ed)?|decreas(?:e|es|ed)`;
  const TGT = String.raw`(?:price\s+target|target|PT)`;
  const near = (verbs: string) =>
    new RegExp(String.raw`\b${TGT}\b[^.;$]{0,30}?\b(?:${verbs})\b|\b(?:${verbs})\b[^.;$]{0,40}?\b${TGT}\b`, "i").test(t);
  const up = near(UP);
  const down = near(DOWN);
  return up === down ? null : up ? "raise" : "cut";
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
  /** "raise" / "cut" when the post's headline says which way the target moved. */
  direction?: "raise" | "cut" | null;
  isNative?: boolean;
}

export interface ResolvedFirmTarget {
  priceTarget: number;
  date: string;
  previousPriceTarget: number | null;
  direction: "raise" | "cut" | null;
}

/** Whether a post dated `postTime` can belong to a grade dated `gradeTime`. */
function withinCallWindow(postTime: number, gradeTime: number): boolean {
  return (
    postTime >= gradeTime - TARGET_PRE_GRACE_DAYS * DAY_MS &&
    postTime <= gradeTime + TARGET_POST_GRACE_DAYS * DAY_MS
  );
}

/**
 * The target the firm posted WITH the call dated `gradeDate`: the post closest
 * to the grade inside the call window (a day before to a few days after),
 * the earlier on a tie. Null when the firm posted none with this call — an
 * older target is never carried forward (see TARGET_PRE_GRACE_DAYS). Picking
 * the closest rather than the latest keeps back-to-back calls apart (ABT /
 * Wells Fargo: $119 on 10-22 and $120 on 10-23, each on its own row).
 * `posts` may be in any order.
 */
export function resolveFirmTarget(
  posts: ReadonlyArray<FirmTargetPost>,
  gradeDate: string,
  action?: string | null,
): ResolvedFirmTarget | null {
  const gradeTime = Date.parse(gradeDate);
  if (!Number.isFinite(gradeTime)) return null;
  let best: FirmTargetPost | null = null;
  let bestTime = NaN;
  for (const p of posts) {
    const t = Date.parse(p.date);
    if (!Number.isFinite(t) || !withinCallWindow(t, gradeTime)) continue;
    const d = Math.abs(t - gradeTime);
    const bestD = Math.abs(bestTime - gradeTime);
    if (
      !best ||
      d < bestD ||
      (d === bestD && t < bestTime) ||
      (d === bestD && t === bestTime && p.isNative && !best.isNative)
    ) {
      best = p;
      bestTime = t;
    }
  }
  if (!best) return null;
  const isInitiation = action ? /^(init|reinstat|resum)/i.test(action) : false;
  const previousPriceTarget = isInitiation ? null : previousFirmTarget(posts, best, bestTime);
  // The figures decide when both are known; otherwise the headline's own word.
  const direction = isInitiation
    ? null
    : previousPriceTarget != null && previousPriceTarget !== best.priceTarget
      ? best.priceTarget > previousPriceTarget ? "raise" : "cut"
      : previousPriceTarget == null ? best.direction ?? sameCallDirection(posts, best, bestTime) : null;
  return { priceTarget: best.priceTarget, date: best.date, previousPriceTarget, direction };
}

/** A direction stated by another feed's copy of the same call. */
function sameCallDirection(
  posts: ReadonlyArray<FirmTargetPost>,
  current: FirmTargetPost,
  currentTime: number,
): "raise" | "cut" | null {
  for (const p of posts) {
    if (
      p.direction &&
      p.priceTarget === current.priceTarget &&
      Math.abs(Date.parse(p.date) - currentTime) <= TARGET_POST_GRACE_DAYS * DAY_MS
    )
      return p.direction;
  }
  return null;
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

type GradeLike = { date: string; gradingCompany: string | null; previousGrade: string | null; newGrade: string | null; action: string | null };

/**
 * One row per call. FMP's `grades` repeats a call under each spelling of the
 * firm it has ("Sidoti" and "Sidoti & Co.", "KeyBanc" and "Keybanc", same day,
 * same grades), which rendered as two analyst actions. Order is preserved.
 */
export function dedupeGrades<T extends GradeLike>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((g) => {
    const k = `${canonicalFirm(g.gradingCompany)}|${g.date}|${(g.newGrade ?? "").toLowerCase().trim()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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
    const [pt, summary, gradesHistorical, rawGrades, targetFor] = await Promise.all([
      this.fmp.getPriceTargetConsensus(ticker).catch(() => null),
      this.fmp.getPriceTargetSummary(ticker).catch(() => null),
      typeof this.fmp.getGradesHistorical === "function"
        ? this.fmp.getGradesHistorical(ticker).catch(() => [])
        : Promise.resolve([]),
      this.fmp.getGrades(ticker, GRADES_HISTORY_MAX).catch(() => []),
      this.targetIndex(ticker),
    ]);

    // Merge discovered initiations into the grade history stream
    const grades = this.mergeInitiations(rawGrades, targetFor.initiations, ticker);

    // Active coverage: prefer /stable/grades-historical row 0 if available
    const hist0 = gradesHistorical[0];
    const histTotal = hist0
      ? n(hist0.strongBuy) +
        n(hist0.buy) +
        n(hist0.hold) +
        n(hist0.sell) +
        n(hist0.strongSell)
      : 0;
    const active = histTotal > 0 ? null : activeCoverage(grades);
    const ptStats = activeTargetStats(targetFor.latestByFirm);

    return {
      strongBuy: histTotal > 0 && hist0 ? n(hist0.strongBuy) : active ? active.strongBuy : n(row.strongBuy),
      buy: histTotal > 0 && hist0 ? n(hist0.buy) : active ? active.buy : n(row.buy),
      hold: histTotal > 0 && hist0 ? n(hist0.hold) : active ? active.hold : n(row.hold),
      sell: histTotal > 0 && hist0 ? n(hist0.sell) : active ? active.sell : n(row.sell),
      strongSell: histTotal > 0 && hist0 ? n(hist0.strongSell) : active ? active.strongSell : n(row.strongSell),
      // Fix B-1: use grades-consensus.consensus whenever FMP provides it;
      // fall back to computed label only when FMP has none.
      consensus: row.consensus ?? (histTotal > 0 && hist0 ? hist0.consensus : active ? active.consensus : (consensusLabel(row) ?? null)),
      priceTargetConsensus: pt?.targetConsensus ?? ptStats?.mean ?? null,
      priceTargetHigh: pt?.targetHigh ?? ptStats?.high ?? null,
      priceTargetLow: pt?.targetLow ?? ptStats?.low ?? null,
      priceTargetMedian: pt?.targetMedian ?? ptStats?.median ?? null,
      ptAvgLastMonth: summary?.lastMonthAvg ?? null,
      ptAvgLastQuarter: summary?.lastQuarterAvg ?? null,
      ptAvgLastYear: summary?.lastYearAvg ?? null,
      recentGrades: selectGrades(grades.slice(0, GRADES_SCAN)).map((g) => this.toChange(g, targetFor)),
    };
  }

  /** Full rating history for one ticker (every FMP grade row, newest first),
   *  each with its firm's own standing price target. */
  async getGradeHistory(ticker: string): Promise<AnalystRatingChange[]> {
    const [rawGrades, targetFor] = await Promise.all([
      this.fmp.getGrades(ticker, GRADES_HISTORY_MAX).catch(() => []),
      this.targetIndex(ticker),
    ]);
    const grades = this.mergeInitiations(rawGrades, targetFor.initiations, ticker);
    return grades.filter((g) => g.date).map((g) => this.toChange(g, targetFor));
  }

  private mergeInitiations<T extends { date: string; gradingCompany: string | null; previousGrade: string | null; newGrade: string | null; action: string | null }>(
    grades: T[],
    initiations: Array<{ date: string; gradingCompany: string | null; previousGrade: string | null; newGrade: string | null; action: string | null }>,
    ticker: string,
  ): T[] {
    const list = dedupeGrades(grades).map((g) => ({ ...g }));
    for (const init of initiations) {
      const firmKey = canonicalFirm(init.gradingCompany);
      const gap = (g: T) => Math.abs(Date.parse(g.date) - Date.parse(init.date));
      const sameFirm = list.filter((g) => canonicalFirm(g.gradingCompany) === firmKey);
      // The firm's own "initiated with a Buy" headline outranks how `grades`
      // labelled the same call: CSCO / Deutsche Bank is "upgrade Hold → Buy"
      // there (a stale Hold from coverage it had dropped).
      const sameCall = sameFirm.find((g) => gap(g) <= TARGET_POST_GRACE_DAYS * DAY_MS);
      if (sameCall) {
        sameCall.action = "initiate";
        sameCall.previousGrade = null;
        continue;
      }
      const exists = sameFirm.some((g) => gap(g) <= 7 * DAY_MS);
      if (!exists) {
        list.push({
          symbol: ticker,
          date: init.date,
          gradingCompany: init.gradingCompany,
          previousGrade: init.previousGrade,
          newGrade: init.newGrade,
          action: init.action,
        } as unknown as T);
      }
    }
    return list.sort((a, b) => b.date.localeCompare(a.date));
  }

  private toChange(
    g: { date: string; gradingCompany: string | null; previousGrade: string | null; newGrade: string | null; action: string | null },
    targetFor: TargetLookup,
  ): AnalystRatingChange {
    const action = normaliseGradeAction(g.action, g.previousGrade, g.newGrade);
    const target = targetFor({ ...g, action });
    const isInitiation = action ? /^(init|reinstat|resum)/i.test(action) : false;
    return {
      date: g.date,
      firm: g.gradingCompany,
      previousGrade: g.previousGrade,
      newGrade: g.newGrade,
      action,
      priceTarget: target?.priceTarget ?? null,
      priceTargetDate: target?.date ?? null,
      previousPriceTarget: isInitiation ? null : (target?.previousPriceTarget ?? null),
      priceTargetChange: isInitiation ? null : (target ? target.direction : targetFor.directionFor(g)),
    };
  }

  /** Each covering firm's posted targets, as a lookup from a grade row to the
   *  target that firm had standing on that day. */
  private async targetIndex(ticker: string): Promise<TargetLookup> {
    // FMP serves 100 posts a page; one page covers only the last few months on
    // a heavily covered name, so older calls fell back to "consensus".
    const [targets, gradeNews, splits] = await Promise.all([
      pagesOf((page) => this.fmp.getPriceTargets(ticker, 100, page)),
      pagesOf((page) => this.fmp.getGradeNews(ticker, 100, page)),
      this.fmp.getSplits(ticker).catch(() => []),
    ]);

    const ptByFirm = new Map<string, FirmTargetPost[]>();
    /** Headlines that state a target move but no figure ("PT Raised at RBC"). */
    const movesByFirm = new Map<string, Array<{ date: string; direction: "raise" | "cut" }>>();
    const addTarget = (
      key: string,
      date: string,
      priceTarget: number,
      statedPrevious: number | null,
      direction: "raise" | "cut" | null,
      isNative = false,
    ) => {
      if (!key || !date) return;
      const value = toCurrentShareBasis(priceTarget, date, splits);
      const list = ptByFirm.get(key) ?? [];
      // The same post often arrives twice (both feeds, or re-tagged): keep one,
      // preferring the copy that states a "from", and preferring native firm copy.
      const dup = list.find((p) => p.date === date && (p.priceTarget === value || (!p.isNative && isNative)));
      const previous =
        statedPrevious == null
          ? null
          : toCurrentShareBasis(alignPreviousToSplits(statedPrevious, priceTarget, date, splits), date, splits);
      if (dup) {
        if (!dup.isNative && isNative) {
          dup.priceTarget = value;
          dup.isNative = true;
          dup.previousTarget = previous ?? dup.previousTarget;
          dup.direction = direction ?? dup.direction;
        } else {
          dup.previousTarget ??= previous;
          dup.direction ??= direction;
          if (isNative) dup.isNative = true;
        }
        return;
      }
      list.push({ date, priceTarget: value, previousTarget: previous, direction, isNative });
      ptByFirm.set(key, list);
    };
    const addMove = (key: string, date: string, direction: "raise" | "cut" | null) => {
      if (!key || !date || !direction) return;
      const list = movesByFirm.get(key) ?? [];
      list.push({ date, direction });
      movesByFirm.set(key, list);
    };
    /**
     * The firm a post belongs to: FMP's tag, unless the headline names a
     * DIFFERENT firm and not the tagged one (CVX HSBC call tagged UBS; Freedom
     * Capital Markets' posts tagged Loop Capital Markets).
     */
    const firmOf = (tag: string | null, title: string | null): string => {
      const tagKey = canonicalFirm(tag);
      if (!title || (tagKey && headlineNamesFirm(title, tagKey))) return tagKey;
      const named = headlineFirm(title);
      if (!named) return tagKey;
      const namedKey = canonicalFirm(named);
      if (!namedKey || namedKey === tagKey) return tagKey;
      return namedKey;
    };
    for (const t of targets) {
      if (!t.firm || t.priceTarget == null) continue;
      const targetFirm = firmOf(t.firm, t.title);
      const isReattributed = canonicalFirm(t.firm) !== targetFirm;
      const stated = t.title ? headlineTarget(t.title) : null;
      // A post re-attributed to another firm carries the TAGGED firm's number in
      // priceTarget, so only a target its headline states can be the named
      // firm's; without one the post gives that firm nothing (PEP 2026-09-29
      // "JPMorgan Downgrades Pepsico", tagged Jefferies at 138).
      if (isReattributed && stated == null) continue;
      const rawValue = isReattributed ? (stated as number) : t.priceTarget;
      // The vendor's number is sometimes not the headline's: CVX / HSBC carries
      // priceTarget 90 on "price target raised to $250 from $218 at HSBC". A
      // gross disagreement means the field is wrong — the headline is the
      // firm's own words. Small gaps are left to the field (a later correction).
      const value =
        stated != null && Math.abs(Math.log(stated / rawValue)) > Math.log(1.2)
          ? stated
          : rawValue;
      // Trust the headline's "from" only when its "to" is this row's target.
      const statedPrevious = stated === value && t.title ? headlinePreviousTarget(t.title) : null;
      addTarget(targetFirm, t.date, value, statedPrevious, headlineTargetDirection(t.title), !isReattributed);
    }
    // Headline-stated targets fill firms price-target-news omits, attributed to
    // the firm the headline names (FMP mis-tags some: BRZE Citizens as Citigroup).
    for (const h of gradeNews) {
      const key = firmOf(h.firm, h.title);
      const isReattributed = canonicalFirm(h.firm) !== key;
      const value = headlineTarget(h.title);
      const direction = headlineTargetDirection(h.title);
      if (value != null && headlineNamesFirm(h.title, key))
        addTarget(key, h.date, value, headlinePreviousTarget(h.title), direction, !isReattributed);
      else if (value == null && headlineNamesFirm(h.title, key)) addMove(key, h.date, direction);
    }

    // Discover initiations from gradeNews & targets
    const initiations: Array<{
      date: string;
      gradingCompany: string | null;
      previousGrade: string | null;
      newGrade: string | null;
      action: string | null;
    }> = [];

    const addInitiation = (date: string, firm: string | null, grade: string | null) => {
      if (!date || !firm) return;
      const d = date.slice(0, 10);
      initiations.push({
        date: d,
        gradingCompany: firm,
        previousGrade: null,
        // Unknown stays unknown — never a guessed "Buy".
        newGrade: grade || null,
        action: "initiate",
      });
    };

    // Only the headline counts: FMP tags market roundups ("What You Missed On
    // Wall Street On Friday") with action "initialise" for every firm in them,
    // which made AAPL show seven initiations in a year. The headline must say
    // the firm started coverage, and name that firm.
    const INIT_HEADLINE = /\binitiated\b|\binitiates\b|\binitiating\b|\bstarts\b|\bresumes\b|\breinstates\b/i;
    const initGrade = (title: string): string | null => {
      const m = /\bwith an? ([A-Za-z ]+?) at\b|\bstarts .+? at ([A-Za-z ]+)/i.exec(title);
      return m ? (m[1] || m[2]).trim() : null;
    };
    for (const row of [...gradeNews.map((h) => ({ ...h, tag: h.firm })), ...targets.map((t) => ({ ...t, tag: t.firm }))]) {
      const title = row.title ?? "";
      const key = firmOf(row.tag, title);
      if (!INIT_HEADLINE.test(title) || !headlineNamesFirm(title, key)) continue;
      const firm = canonicalFirm(row.tag) === key ? row.tag : headlineFirm(title) ?? row.tag;
      addInitiation(row.date, firm, initGrade(title));
    }

    const lookup = (g: { gradingCompany: string | null; date: string; action?: string | null }) =>
      resolveFirmTarget(ptByFirm.get(canonicalFirm(g.gradingCompany)) ?? [], g.date, g.action);
    const directionFor = (g: { gradingCompany: string | null; date: string }) => {
      const gradeTime = Date.parse(g.date);
      if (!Number.isFinite(gradeTime)) return null;
      const near = (movesByFirm.get(canonicalFirm(g.gradingCompany)) ?? [])
        .filter((m) => withinCallWindow(Date.parse(m.date), gradeTime));
      const dirs = new Set(near.map((m) => m.direction));
      return dirs.size === 1 ? [...dirs][0] : null;
    };
    const latestByFirm = new Map<string, { date: string; priceTarget: number }>();
    for (const [firm, posts] of ptByFirm) {
      const last = posts.reduce((a, b) => (b.date > a.date ? b : a));
      latestByFirm.set(firm, { date: last.date, priceTarget: last.priceTarget });
    }
    return Object.assign(lookup, { directionFor, latestByFirm, initiations });
  }
}
