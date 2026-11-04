/**
 * Every number an earnings article prints, computed from FMP rows.
 *
 * Pure: no I/O, no clock unless passed in. The job fetches, this module
 * decides, the writer only words what is decided here. Rules follow the
 * marketcatalyst-earnings-article skill (§3 beat/miss bands, §4 scorecard and
 * change grid, §6 number formats).
 */

/** One report from FMP `/stable/earnings` (or the calendar row for it). */
export interface ReportRow {
  date: string;
  epsActual: number | null;
  epsEstimated: number | null;
  revenueActual: number | null;
  revenueEstimated: number | null;
}

/** One quarter from FMP `/stable/income-statement?period=quarter`. */
export interface StatementRow {
  date: string;
  period: string;
  fiscalYear: string;
  filingDate?: string | null;
  reportedCurrency?: string | null;
  revenue?: number | null;
  grossProfit?: number | null;
  operatingIncome?: number | null;
  netIncome?: number | null;
  epsDiluted?: number | null;
}

/** One quarter from FMP `/stable/analyst-estimates?period=quarter`. */
export interface EstimateRow {
  date: string;
  epsAvg: number | null;
  revenueAvg: number | null;
  numAnalystsEps?: number | null;
  numAnalystsRevenue?: number | null;
}

export interface CompanyInfo {
  symbol: string;
  name: string;
  sector?: string | null;
  industry?: string | null;
  marketCap?: number | null;
}

export interface Reaction {
  session: "regular" | "premarket" | "after-hours";
  pct: number;
  price: number;
  /** The close the move is measured from. */
  reference: number;
  /** Epoch ms of the price. */
  at: number;
}

export type Verdict = "beat" | "miss" | "inline" | "none";
export type Overall = "beat" | "miss" | "mixed" | "inline" | "none";
export type Tone = "pos" | "dn" | "";

export interface MetricFacts {
  actual: number;
  estimate: number | null;
  verdict: Verdict;
  /** Scorecard cell, e.g. "Beat by 84%"; null without an estimate. */
  gapText: string | null;
  /** actual − estimate, unrounded. */
  gap: number | null;
  prior: number | null;
  yearAgo: number | null;
  yoyPct: number | null;
  qoqPct: number | null;
}

export interface ChangeCell {
  text: string;
  cls: Tone;
}

export interface ArticleFacts {
  symbol: string;
  company: string;
  shortName: string;
  reportDate: string;
  /** "Q3 2026" or "fiscal Q3 2026". */
  quarter: string;
  /** "third-quarter 2026" / "fiscal third-quarter 2026" — adjective form for prose. */
  quarterWords: string;
  eps: MetricFacts;
  revenue: MetricFacts;
  overall: Overall;
  hasQoq: boolean;
  hasYoy: boolean;
  /** Up to 8 reports, newest first, that had both an actual and an estimate. */
  record: { epsBeats: number; epsOf: number; revBeats: number; revOf: number };
  /** Revenue for the last up to 5 reports, oldest first (this one last). */
  revenueTrend: number[];
  /** This quarter's statement when it is already filed, with its year-ago statement. */
  gaap: { current: StatementRow; yearAgo: StatementRow | null } | null;
  next: { epsAvg: number | null; revenueAvg: number | null; analysts: number | null; reportDate: string | null } | null;
  reaction: Reaction | null;
}

export type SkipReason =
  | "no-actuals"
  | "no-statements"
  | "non-usd"
  | "no-history";

const DAY = 86_400_000;
const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown): number | null => (finite(v) ? v : null);

// ── beat / miss (skill §3) ────────────────────────────────────────────────────

/** Gap as a percent of the estimate: whole percent at 10% or more, one decimal below. */
export function formatGapPct(pct: number): string {
  const a = Math.abs(pct);
  return a >= 10 ? `${Math.round(a)}%` : `${a.toFixed(1)}%`;
}

export function epsVerdict(actual: number, estimate: number | null): Verdict {
  if (estimate == null) return "none";
  const cents = Math.round((actual - estimate) * 100);
  if (cents >= 1) return "beat";
  if (cents <= -1) return "miss";
  return "inline";
}

export function revenueVerdict(actual: number, estimate: number | null): Verdict {
  if (estimate == null || estimate === 0) return "none";
  const rel = (actual - estimate) / Math.abs(estimate);
  if (rel > 0.0025) return "beat";
  if (rel < -0.0025) return "miss";
  return "inline";
}

/**
 * The scorecard's Beat/Miss cell. The percent is taken against the UNROUNDED
 * estimate — rounding first turned a $0.10 vs $0.0542 beat into "Beat by 100%".
 * An EPS estimate within half a cent of zero has no meaningful percent, so the
 * gap is stated in cents instead.
 */
export function gapText(kind: "eps" | "revenue", actual: number, estimate: number | null): string | null {
  if (estimate == null) return null;
  const v = kind === "eps" ? epsVerdict(actual, estimate) : revenueVerdict(actual, estimate);
  if (v === "inline") return "In line";
  if (v === "none") return null;
  const word = v === "beat" ? "Beat" : "Miss";
  if (kind === "eps" && Math.abs(estimate) < 0.005) {
    return `${word} by ${formatEps(Math.abs(actual - estimate))}`;
  }
  return `${word} by ${formatGapPct(((actual - estimate) / Math.abs(estimate)) * 100)}`;
}

export function overallVerdict(eps: Verdict, rev: Verdict): Overall {
  const vs = [eps, rev].filter((v) => v !== "none");
  if (vs.length === 0) return "none";
  const beats = vs.filter((v) => v === "beat").length;
  const misses = vs.filter((v) => v === "miss").length;
  if (beats && misses) return "mixed";
  if (beats) return "beat";
  if (misses) return "miss";
  return "inline";
}

// ── change grid ───────────────────────────────────────────────────────────────

export function pctChange(current: number, base: number | null): number | null {
  if (base == null || base === 0) return null;
  return ((current - base) / Math.abs(base)) * 100;
}

/**
 * A change-grid cell. A sign flip (loss to profit or back) has no meaningful
 * percent (skill §6), so the cell names the base instead.
 */
export function changeCell(
  current: number,
  base: number | null,
  format: (v: number) => string,
): ChangeCell | null {
  if (base == null) return null;
  if (current === base) return { text: "Unchanged", cls: "" };
  const cls: Tone = current > base ? "pos" : "dn";
  const arrow = current > base ? "&#9650;" : "&#9660;";
  if (base === 0 || Math.sign(current) !== Math.sign(base)) {
    return { text: `${arrow} from ${format(base)}`, cls };
  }
  return { text: `${arrow} ${formatGapPct(pctChange(current, base)!)}`, cls };
}

// ── number formats (skill §6) ─────────────────────────────────────────────────

export function formatEps(v: number): string {
  const s = `$${Math.abs(v).toFixed(2)}`;
  return v < 0 ? `-${s}` : s;
}

/** "$108.4B", "$391.4M", "$950K" — table and tile form. */
export function formatMoney(v: number, decimals?: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(decimals ?? (a >= 100e9 ? 1 : 2))}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(decimals ?? 1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(decimals ?? 0)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

/** "$108.4 billion", "$391.4 million" — prose form. */
export function formatMoneyProse(v: number, decimals?: number): string {
  const t = formatMoney(v, decimals);
  return t.replace(/B$/, " billion").replace(/M$/, " million").replace(/K$/, " thousand");
}

/**
 * Smallest precision at which actual and estimate print differently, so a
 * beat never reads "$1.89B vs $1.89B" (skill §6: three decimals only when needed).
 */
export function moneyDecimals(actual: number, estimate: number | null): number | undefined {
  if (estimate == null) return undefined;
  const base = Math.abs(actual) >= 1e9 ? (Math.abs(actual) >= 100e9 ? 1 : 2) : 1;
  for (let d = base; d <= 3; d++) {
    if (formatMoney(actual, d) !== formatMoney(estimate, d)) return d === base ? undefined : d;
  }
  return undefined;
}

export function formatPct(v: number): string {
  return `${formatGapPct(v)}`;
}

const MONTHS_AP = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];

/** "Nov. 4, 2026" (AP style). */
export function apDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${MONTHS_AP[m - 1]} ${d}, ${y}`;
}

const ET = "America/New_York";

/** "4:40 p.m. ET" for an epoch-ms instant. */
export function etTime(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(ms));
  const h = parts.find((p) => p.type === "hour")!.value;
  const m = parts.find((p) => p.type === "minute")!.value;
  const pm = parts.find((p) => p.type === "dayPeriod")!.value.toUpperCase().startsWith("P");
  return `${h}:${m} ${pm ? "p.m." : "a.m."} ET`;
}

/** ISO 8601 with the Eastern offset, e.g. "2026-11-04T16:34:00-05:00". */
export function etIso(ms: number): string {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(ms));
  const g = (t: string) => f.find((p) => p.type === t)!.value;
  const off = g("timeZoneName").replace("GMT", "") || "+0";
  const m = off.match(/^([+-])(\d{1,2})(?::(\d{2}))?$/);
  const offset = m ? `${m[1]}${m[2].padStart(2, "0")}:${m[3] ?? "00"}` : "+00:00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}${offset}`;
}

// ── quarter label ─────────────────────────────────────────────────────────────

const ORDINAL = ["first", "second", "third", "fourth"];

function quarterNum(period: string): number | null {
  const m = /^Q([1-4])$/.exec(period);
  return m ? Number(m[1]) : null;
}

/** True when a statement's period end sits within 10 days of the matching calendar quarter end. */
function calendarAligned(endIso: string, q: number): boolean {
  const end = Date.parse(`${endIso}T00:00:00Z`);
  const y = Number(endIso.slice(0, 4));
  for (const year of [y - 1, y, y + 1]) {
    const qe = Date.UTC(year, q * 3, 0); // last day of month q*3
    if (Math.abs(end - qe) <= 10 * DAY) return true;
  }
  return false;
}

/**
 * The reported quarter's label. FMP's newest statement is either THIS quarter
 * (when the 10-Q landed with the release) or the previous one; the previous
 * one's label steps forward (Q4 FY2026 → Q1 FY2027). "fiscal" is added unless
 * the company's quarters end with the calendar's.
 */
export function quarterLabel(
  reportDate: string,
  statements: StatementRow[],
): { quarter: string; words: string; current: StatementRow | null } | null {
  const sorted = [...statements].filter((s) => quarterNum(s.period)).sort((a, b) => b.date.localeCompare(a.date));
  const top = sorted[0];
  if (!top) return null;
  const lag = daysBetween(reportDate, top.date);
  const isCurrent = lag >= 0 && lag <= 120 && !!top.filingDate && daysBetween(top.filingDate, reportDate) >= -1;
  let q = quarterNum(top.period)!;
  let fy = Number(top.fiscalYear);
  let endIso = top.date;
  if (!isCurrent) {
    if (lag < 45 || lag > 220) return null;
    q = q === 4 ? 1 : q + 1;
    if (q === 1) fy += 1;
    endIso = new Date(Date.parse(`${top.date}T00:00:00Z`) + 91 * DAY).toISOString().slice(0, 10);
  }
  if (!Number.isFinite(fy)) return null;
  const fiscal = !calendarAligned(endIso, q);
  return {
    quarter: `${fiscal ? "fiscal " : ""}Q${q} ${fy}`,
    words: `${fiscal ? "fiscal " : ""}${ORDINAL[q - 1]}-quarter ${fy}`,
    current: isCurrent ? top : null,
  };
}

// ── company name ──────────────────────────────────────────────────────────────

/** "CVS Health Corporation" → "CVS Health"; "Figma, Inc." → "Figma". */
export function shortCompanyName(name: string): string {
  let s = name.trim();
  for (let i = 0; i < 3; i++) {
    const next = s
      .replace(/,?\s+(Inc|Incorporated|Corp|Corporation|Co|Company|Ltd|Limited|plc|PLC|L\.?P|LLC|N\.V|S\.A|AG|SE|Holdings?|Group|Technologies)\.?$/i, "")
      .trim();
    if (next === s || next.length < 2) break;
    s = next;
  }
  return s.replace(/^The\s+/i, "") || name.trim();
}

// ── assembly ──────────────────────────────────────────────────────────────────

export interface FactsInput {
  company: CompanyInfo;
  /** The calendar row that announced the actuals. */
  report: ReportRow;
  /** FMP `/stable/earnings` rows for the symbol (any order, may include future rows). */
  history: ReportRow[];
  statements: StatementRow[];
  estimates: EstimateRow[];
  reaction: Reaction | null;
}

export function buildFacts(input: FactsInput): ArticleFacts | { skip: SkipReason } {
  const { report } = input;
  const epsA = numOrNull(report.epsActual);
  const revA = numOrNull(report.revenueActual);
  if (epsA == null || revA == null) return { skip: "no-actuals" };

  if (!input.statements.length) return { skip: "no-statements" };
  const newest = [...input.statements].sort((a, b) => b.date.localeCompare(a.date))[0];
  if ((newest.reportedCurrency ?? "USD").toUpperCase() !== "USD") return { skip: "non-usd" };

  const label = quarterLabel(report.date, input.statements);
  if (!label) return { skip: "no-statements" };

  // Reported history, newest first, with this report pinned to the calendar's numbers.
  const past = input.history
    .filter((r) => r.date < report.date && (finite(r.epsActual) || finite(r.revenueActual)))
    .sort((a, b) => b.date.localeCompare(a.date));
  const reported: ReportRow[] = [report, ...past];
  if (reported.length < 2) return { skip: "no-history" };

  // A comparison row is used only when it sits where a prior quarter / year-ago
  // quarter should, so a missing report never shifts every comparison by one.
  const at = (i: number, minDays: number, maxDays: number): ReportRow | null => {
    const r = reported[i];
    if (!r) return null;
    const d = daysBetween(report.date, r.date);
    return d >= minDays && d <= maxDays ? r : null;
  };
  const prior = at(1, 45, 140);
  const yearAgo = at(4, 300, 430);

  const epsEst = numOrNull(report.epsEstimated);
  const revEst = numOrNull(report.revenueEstimated);
  const metric = (kind: "eps" | "revenue", actual: number, estimate: number | null): MetricFacts => {
    const pick = (r: ReportRow | null) =>
      r ? numOrNull(kind === "eps" ? r.epsActual : r.revenueActual) : null;
    const p = pick(prior);
    const y = pick(yearAgo);
    return {
      actual,
      estimate,
      verdict: kind === "eps" ? epsVerdict(actual, estimate) : revenueVerdict(actual, estimate),
      gapText: gapText(kind, actual, estimate),
      gap: estimate == null ? null : actual - estimate,
      prior: p,
      yearAgo: y,
      yoyPct: pctChange(actual, y),
      qoqPct: pctChange(actual, p),
    };
  };
  const eps = metric("eps", epsA, epsEst);
  const revenue = metric("revenue", revA, revEst);

  const scored = reported.slice(0, 8);
  const record = { epsBeats: 0, epsOf: 0, revBeats: 0, revOf: 0 };
  for (const r of scored) {
    if (finite(r.epsActual) && finite(r.epsEstimated)) {
      record.epsOf++;
      if (epsVerdict(r.epsActual, r.epsEstimated) === "beat") record.epsBeats++;
    }
    if (finite(r.revenueActual) && finite(r.revenueEstimated)) {
      record.revOf++;
      if (revenueVerdict(r.revenueActual, r.revenueEstimated) === "beat") record.revBeats++;
    }
  }

  const revenueTrend = reported
    .slice(0, 5)
    .map((r) => numOrNull(r.revenueActual))
    .filter((v): v is number => v != null)
    .reverse();

  let gaap: ArticleFacts["gaap"] = null;
  if (label.current && finite(label.current.epsDiluted)) {
    // Guard against a statement that is not this report's quarter: its revenue
    // must agree with the reported revenue within 2%.
    const sRev = numOrNull(label.current.revenue);
    if (sRev != null && Math.abs(sRev - revA) / Math.abs(revA) <= 0.02) {
      const curEnd = label.current.date;
      const ya =
        input.statements.find((s) => {
          const d = daysBetween(curEnd, s.date);
          return d >= 340 && d <= 390;
        }) ?? null;
      gaap = { current: label.current, yearAgo: ya };
    }
  }

  // Next quarter: the first estimate row ending at least 20 days after this quarter.
  const thisEnd = label.current?.date ?? new Date(Date.parse(`${newest.date}T00:00:00Z`) + 91 * DAY).toISOString().slice(0, 10);
  const nextEst = [...input.estimates]
    .filter((e) => daysBetween(e.date, thisEnd) >= 20 && (finite(e.epsAvg) || finite(e.revenueAvg)))
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  const nextReport = input.history
    .filter((r) => r.date > report.date && !finite(r.epsActual))
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  const next =
    nextEst || nextReport
      ? {
          epsAvg: nextEst ? numOrNull(nextEst.epsAvg) : null,
          revenueAvg: nextEst ? numOrNull(nextEst.revenueAvg) : null,
          analysts: nextEst ? numOrNull(nextEst.numAnalystsEps) ?? numOrNull(nextEst.numAnalystsRevenue) : null,
          reportDate: nextReport?.date ?? null,
        }
      : null;

  return {
    symbol: input.company.symbol.toUpperCase(),
    company: input.company.name,
    shortName: shortCompanyName(input.company.name),
    reportDate: report.date,
    quarter: label.quarter,
    quarterWords: label.words,
    eps,
    revenue,
    overall: overallVerdict(eps.verdict, revenue.verdict),
    hasQoq: eps.prior != null && revenue.prior != null,
    hasYoy: eps.yearAgo != null && revenue.yearAgo != null,
    record,
    revenueTrend,
    gaap,
    next,
    reaction: input.reaction,
  };
}

// ── stock reaction ────────────────────────────────────────────────────────────

/** Minutes since midnight ET, and the ET weekday (0 = Sunday). */
export function etClockOf(ms: number): { minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")!.value);
  const m = Number(parts.find((p) => p.type === "minute")!.value);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday")!.value);
  return { minutes: h * 60 + m, weekday: wd };
}

/**
 * The share move to print, or null. Skill rule 7: only with a percent AND a
 * time. In the regular session it is the quote's change; outside it, the
 * latest extended-hours trade against the last regular close — and only when
 * that trade is recent, so a stale print never reads as the reaction.
 */
export function pickReaction(
  quote: { price: number | null; changePercentage: number | null; timestamp: number | null } | null,
  extended: { price: number; at: number } | null,
  nowMs: number,
): Reaction | null {
  const { minutes, weekday } = etClockOf(nowMs);
  const weekdayOpen = weekday >= 1 && weekday <= 5;
  const regular = weekdayOpen && minutes >= 570 && minutes < 960;
  if (regular) {
    if (!quote || !finite(quote.price) || !finite(quote.changePercentage) || !finite(quote.timestamp)) return null;
    const at = quote.timestamp * 1000;
    if (nowMs - at > 30 * 60_000) return null;
    return {
      session: "regular",
      pct: quote.changePercentage,
      price: quote.price,
      reference: quote.price / (1 + quote.changePercentage / 100),
      at,
    };
  }
  if (!quote || !finite(quote.price) || !extended) return null;
  if (nowMs - extended.at > 30 * 60_000 || extended.at > nowMs + 60_000) return null;
  const session = minutes < 570 && weekdayOpen ? "premarket" : "after-hours";
  return {
    session,
    pct: ((extended.price - quote.price) / quote.price) * 100,
    price: extended.price,
    reference: quote.price,
    at: extended.at,
  };
}
