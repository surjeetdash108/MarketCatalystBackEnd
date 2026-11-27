/**
 * "What Matters Now" carousel: the data-backed slides.
 *
 * Pure builders, no I/O. `WmnSlidesService` reads the (already cached)
 * collections and hands the rows here, so every rule below can be tested with a
 * fixture and nothing in this file can reach Firestore or a vendor.
 *
 * What is NOT here, on purpose:
 *   - Slide 1's index levels, VIX, dollar, 10-year yield and Fear & Greed. The
 *     dashboard already holds those live from the shared ticker tape. The
 *     backend's own `market_indices` VIX is a futures-ETN proxy and its DXY is a
 *     fund price, so repeating them here would show a second, wrong number.
 *   - An options-implied move on the earnings slide: the product has no options
 *     chain (see the 26 Nov legal copy fix).
 *   - The 5-minute futures/yield reaction after a release: no source supplies it.
 */

import type { StockInFocusEntry } from "../stock-in-focus/stock-in-focus.service";

type Row = Record<string, unknown>;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

const DAY_MS = 86_400_000;

/** YYYY-MM-DD on the New York calendar. */
export function etDayOf(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** 0-23 on the New York clock. */
export function etHourOf(d: Date): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false,
  }).format(d);
  return parseInt(h, 10) % 24;
}

/** 0 = Sunday … 6 = Saturday on the New York calendar. */
function etWeekday(d: Date): number {
  const w = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(d);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(w);
}

// ─────────────────────────────── Slide 1 ───────────────────────────────

export interface BreadthSlice {
  date: string;
  advancers: number;
  decliners: number;
  unchanged: number;
}

/** A session is "settled" once at least this share of the universe has a bar. */
const BREADTH_MIN_COVERAGE = 0.5;
/** Breadth older than this is not "the session" any more. */
const BREADTH_MAX_AGE_DAYS = 4;

/**
 * Newest settled advance/decline count. A row that covers under half the
 * universe is a session still being counted, and reading it would report a
 * lopsided tape that is really just a short list.
 */
export function latestBreadth(rows: Row[], now: Date): BreadthSlice | null {
  const dated = rows
    .map((r) => ({ r, date: str(r.date) ?? str(r.id) ?? "" }))
    .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date))
    .sort((a, b) => b.date.localeCompare(a.date));
  for (const { r, date } of dated) {
    const adv = num(r.advancers);
    const dec = num(r.decliners);
    const covered = num(r.covered);
    const universe = num(r.universe);
    if (adv == null || dec == null) continue;
    if (covered != null && universe && covered / universe < BREADTH_MIN_COVERAGE) continue;
    const ageDays = (now.getTime() - Date.parse(`${date}T12:00:00Z`)) / DAY_MS;
    if (ageDays > BREADTH_MAX_AGE_DAYS) return null;
    return {
      date,
      advancers: adv,
      decliners: dec,
      unchanged: covered != null ? Math.max(0, covered - adv - dec) : 0,
    };
  }
  return null;
}

export interface IndexWeight {
  ticker: string;
  name: string;
  /** Share of the index's total market cap, %. */
  weightPct: number;
}

/** Fewer index members priced than this means the weights are not trustworthy. */
const MIN_PRICED_MEMBERS = 400;
/** How many of the heaviest names to hand the app. A name outside the top 40 needs a 10%+ day to rank. */
const WEIGHT_NAMES = 40;

/**
 * The heaviest S&P 500 names and each one's share of the index's market cap.
 *
 * This is the backend's half of "who moved the S&P 500". The other half, each
 * stock's move, is NOT read here: the stored `companies.pctChange` is exactly 0
 * for almost every name outside the regular session (measured 27 Nov: 502 of 503
 * members), so a contribution computed on the server would be blank all evening.
 * The app multiplies these weights by the live quotes it already polls, which do
 * carry the last completed session's move.
 *
 * Returns null when too few members have a market cap to weight them honestly.
 */
export function sp500Weights(
  companies: Row[],
  members: ReadonlySet<string>,
  n = WEIGHT_NAMES,
): IndexWeight[] | null {
  const priced: Array<{ ticker: string; name: string; cap: number }> = [];
  for (const c of companies) {
    const ticker = str(c.ticker) ?? str(c.id);
    if (!ticker || !members.has(ticker)) continue;
    const cap = num(c.marketCap);
    if (cap == null || cap <= 0) continue;
    priced.push({ ticker, name: str(c.name) ?? ticker, cap });
  }
  if (priced.length < MIN_PRICED_MEMBERS) return null;
  const total = priced.reduce((s, p) => s + p.cap, 0);
  return priced
    .sort((a, b) => b.cap - a.cap)
    .slice(0, n)
    .map((p) => ({ ticker: p.ticker, name: p.name, weightPct: round((p.cap / total) * 100, 3) }));
}

// ─────────────────────────────── Slide 2 ───────────────────────────────

export type CatalystStatus = "upcoming" | "released";
export type CatalystVersus = "above" | "below" | "in-line";

export interface CatalystItem {
  id: string;
  name: string;
  importance: "high" | "medium";
  unit: string | null;
  /** Calendar day (YYYY-MM-DD, New York). */
  date: string;
  /** Release time as a UTC ISO string, when the feed gave one; else null. */
  time: string | null;
  kind: "speech" | "report" | "data" | null;
  status: CatalystStatus;
  previous: number | null;
  /** Consensus forecast. */
  estimate: number | null;
  actual: number | null;
  /**
   * How the print compares with the forecast. Deliberately neutral ("above" /
   * "below") rather than beat / miss: whether a higher number is good news
   * depends on the series (unemployment, CPI), and this builder does not know.
   */
  versus: CatalystVersus | null;
}

/**
 * Weekly positioning and inventory tallies the calendar rates "medium". They fill
 * a five-row slide with names nobody means by "catalysts", so this slide skips
 * them; the Calendar screen still lists every one.
 */
const CATALYST_NOISE = /^(?:cftc|api|eia|mba)\b|speculative net positions|baker hughes|rig count/i;

/** A release can sit unprinted for a while; show it as "upcoming" up to this long. */
const RELEASE_GRACE_MS = 3 * 60 * 60 * 1000;
const CATALYST_AHEAD_MS = 24 * 60 * 60 * 1000;
const MAX_CATALYSTS = 5;

export function compareToForecast(
  actual: number | null,
  estimate: number | null,
): CatalystVersus | null {
  if (actual == null || estimate == null) return null;
  // Rounded to the precision the feeds print, so 3.0000001 vs 3.0 reads "in line".
  const a = round(actual, 4);
  const e = round(estimate, 4);
  if (a === e) return "in-line";
  return a > e ? "above" : "below";
}

/**
 * Releases from a few hours ago to the next 24 hours.
 *
 * With a release time the window is exact. Rows written before the job stored
 * times have only a day, so they fall back to "today and tomorrow" on the New
 * York calendar rather than disappearing until the job next runs.
 */
export function upcomingCatalysts(
  rows: Row[],
  now: Date,
  kindOf: (name: string) => CatalystItem["kind"],
): CatalystItem[] {
  const today = etDayOf(now);
  const tomorrow = etDayOf(new Date(now.getTime() + DAY_MS));
  const nowMs = now.getTime();
  const out: CatalystItem[] = [];
  for (const r of rows) {
    const name = str(r.name);
    const date = str(r.eventDate);
    const importance = str(r.importance)?.toLowerCase();
    if (!name || !date) continue;
    if (importance !== "high" && importance !== "medium") continue;
    if (CATALYST_NOISE.test(name)) continue;
    const time = str(r.eventTime);
    const t = time ? Date.parse(time) : NaN;
    const hasTime = Number.isFinite(t);
    if (hasTime) {
      if (t < nowMs - RELEASE_GRACE_MS || t > nowMs + CATALYST_AHEAD_MS) continue;
    } else if (date !== today && date !== tomorrow) {
      continue;
    }
    const actual = num(r.actual);
    const estimate = num(r.estimate);
    const kind = kindOf(name);
    out.push({
      id: str(r.id) ?? `${date}|${name}`,
      name,
      importance,
      unit: str(r.unit),
      date,
      time: hasTime ? new Date(t).toISOString() : null,
      kind,
      status: actual != null ? "released" : "upcoming",
      previous: num(r.previous),
      estimate,
      actual,
      versus: compareToForecast(actual, estimate),
    });
  }
  const when = (c: CatalystItem) => (c.time ? Date.parse(c.time) : Date.parse(`${c.date}T12:00:00Z`));
  out.sort(
    (a, b) =>
      Number(b.importance === "high") - Number(a.importance === "high") || when(a) - when(b),
  );
  // Keep the heavy hitters, then show them in clock order.
  return out.slice(0, MAX_CATALYSTS).sort((a, b) => when(a) - when(b));
}

// ─────────────────────────────── Slide 3 ───────────────────────────────

export type GuidanceDir = "raised" | "cut" | "mixed" | "reaffirmed";

export interface EarningsFocusItem {
  ticker: string;
  name: string;
  marketCap: number | null;
  session: "BMO" | "AMC" | "Intraday" | null;
  date: string;
  /** The company has filed its numbers (actual EPS is on file). */
  reported: boolean;
  eps: { actual: number | null; estimate: number | null; surprisePct: number | null };
  revenue: { actual: number | null; estimate: number | null; surprisePct: number | null };
  guidance: { direction: GuidanceDir | null; range: string | null } | null;
  /** Price reaction recorded with the 8-K announcement, %. */
  reactionPct: number | null;
}

export interface EarningsFocus {
  date: string;
  items: EarningsFocusItem[];
  /** Every report on the calendar for the day, of which `items` are the biggest few. */
  total: number;
}

const MAX_EARNINGS = 3;

function surprise(actual: number | null, estimate: number | null): number | null {
  if (actual == null || estimate == null || Math.abs(estimate) < 0.005) return null;
  return round(((actual - estimate) / Math.abs(estimate)) * 100, 1);
}

/**
 * The three biggest reports of the day by market cap.
 *
 * NO SIZE FLOOR (owner decision, 27 Nov 2026): whoever reports is eligible and
 * the biggest by market cap are shown, so on a quiet day the slide shows small
 * names rather than disappearing. It returns null only when nobody reports at
 * all, so the dashboard drops the slide instead of showing an empty one. A
 * company with no market cap on file is still counted, ranked after every one
 * that has one. Before 12:00 New York time the list also carries yesterday's
 * after-close reporters, because their after-hours reaction is the story that
 * morning.
 */
export function earningsFocus(
  events: Row[],
  announcements: Row[],
  companies: Row[],
  now: Date,
): EarningsFocus | null {
  const today = etDayOf(now);
  const yesterday = etDayOf(new Date(now.getTime() - DAY_MS));
  const morning = etHourOf(now) < 12;

  const co = new Map<string, Row>();
  for (const c of companies) {
    const t = str(c.ticker) ?? str(c.id);
    if (t) co.set(t, c);
  }
  const annByKey = new Map<string, Row>();
  for (const a of announcements) {
    const t = str(a.ticker);
    const d = str(a.announceDate);
    if (t && d) annByKey.set(`${t}|${d}`, a);
  }

  const picked = new Map<string, EarningsFocusItem>();
  for (const e of events) {
    const ticker = str(e.ticker);
    const date = str(e.date);
    if (!ticker || !date || picked.has(ticker)) continue;
    const ann = annByKey.get(`${ticker}|${date}`);
    const session = (str(e.session) ?? str(ann?.session)) as EarningsFocusItem["session"];
    const isToday = date === today;
    const isYesterdayAfterClose = morning && date === yesterday && session === "AMC";
    if (!isToday && !isYesterdayAfterClose) continue;
    const cap = num(co.get(ticker)?.marketCap);

    const epsActual = num(e.epsActual);
    const epsEstimate = num(e.epsEstimate);
    const revActual = num(e.revenueActual);
    const revEstimate = num(e.revenueEstimate);
    const dir = str(ann?.guidanceDirection) as GuidanceDir | null;
    const range = str(ann?.guidanceRange);
    picked.set(ticker, {
      ticker,
      name: str(co.get(ticker)?.name) ?? str(e.companyName) ?? ticker,
      marketCap: cap,
      session: session ?? null,
      date,
      reported: epsActual != null,
      eps: { actual: epsActual, estimate: epsEstimate, surprisePct: surprise(epsActual, epsEstimate) },
      revenue: { actual: revActual, estimate: revEstimate, surprisePct: surprise(revActual, revEstimate) },
      guidance: dir || range ? { direction: dir, range } : null,
      reactionPct: num(ann?.reactionPct),
    });
  }
  if (picked.size === 0) return null;
  // An unknown market cap sorts below any known one (below 0 as well), then by ticker so the order never depends on the feed's.
  const all = [...picked.values()].sort(
    (a, b) => (b.marketCap ?? -1) - (a.marketCap ?? -1) || a.ticker.localeCompare(b.ticker),
  );
  return { date: today, items: all.slice(0, MAX_EARNINGS), total: all.length };
}

// ─────────────────────────────── Slide 5 ───────────────────────────────

export type AnalystActionKind = "upgrade" | "downgrade" | "initiate";

export interface AnalystRow {
  ticker: string;
  name: string;
  firm: string | null;
  action: AnalystActionKind;
  previousGrade: string | null;
  newGrade: string | null;
  priceTarget: number | null;
  priceTargetChange: "raise" | "cut" | null;
}

export interface AnalystSummary {
  /** First day counted (YYYY-MM-DD, New York). */
  since: string;
  upgrades: number;
  downgrades: number;
  initiations: number;
  ptRaises: number;
  ptCuts: number;
  /** The calls on the biggest companies, largest first. */
  rows: AnalystRow[];
}

const MAX_ANALYST_ROWS = 5;

function actionKind(raw: unknown): AnalystActionKind | null {
  const a = (str(raw) ?? "").toLowerCase();
  if (a.includes("downgrade")) return "downgrade";
  if (a.includes("upgrade")) return "upgrade";
  if (a.includes("init")) return "initiate";
  return null;
}

/**
 * What the Street did since the last session: rating changes and target moves,
 * counted across every covered name, with the calls on the largest companies
 * listed. Plain counts and quotes of what firms did, never a view of our own.
 * Monday's window reaches back over the weekend.
 */
export function analystSummary(
  docs: Row[],
  companies: Row[],
  now: Date,
): AnalystSummary | null {
  const back = etWeekday(now) === 1 ? 3 : etWeekday(now) === 0 ? 2 : 1;
  const since = etDayOf(new Date(now.getTime() - back * DAY_MS));
  const co = new Map<string, Row>();
  for (const c of companies) {
    const t = str(c.ticker) ?? str(c.id);
    if (t) co.set(t, c);
  }
  const s: AnalystSummary = { since, upgrades: 0, downgrades: 0, initiations: 0, ptRaises: 0, ptCuts: 0, rows: [] };
  const candidates: Array<AnalystRow & { cap: number }> = [];
  for (const d of docs) {
    const ticker = str(d.ticker) ?? str(d.id);
    const grades = Array.isArray(d.recentGrades) ? (d.recentGrades as Row[]) : [];
    if (!ticker) continue;
    for (const g of grades) {
      const day = str(g.date)?.slice(0, 10);
      if (!day || day < since) continue;
      const kind = actionKind(g.action);
      const ptc = g.priceTargetChange === "raise" || g.priceTargetChange === "cut" ? g.priceTargetChange : null;
      if (kind === "upgrade") s.upgrades++;
      else if (kind === "downgrade") s.downgrades++;
      else if (kind === "initiate") s.initiations++;
      if (ptc === "raise") s.ptRaises++;
      else if (ptc === "cut") s.ptCuts++;
      if (kind) {
        candidates.push({
          ticker,
          name: str(co.get(ticker)?.name) ?? ticker,
          firm: str(g.firm),
          action: kind,
          previousGrade: str(g.previousGrade),
          newGrade: str(g.newGrade),
          priceTarget: num(g.priceTarget),
          priceTargetChange: ptc,
          cap: num(co.get(ticker)?.marketCap) ?? 0,
        });
      }
    }
  }
  const total = s.upgrades + s.downgrades + s.initiations + s.ptRaises + s.ptCuts;
  if (total === 0) return null;
  s.rows = candidates
    .sort((a, b) => b.cap - a.cap)
    .slice(0, MAX_ANALYST_ROWS)
    .map(({ cap: _cap, ...row }) => row);
  return s;
}

// ──────────────────────────────── shared ────────────────────────────────

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/**
 * Deliberately has no timestamp: the response is ETag'd, and a field that changes
 * every compose (every 2 minutes) would make every poll a full 200 instead of a 304.
 */
export interface WmnSlidesPayload {
  breadth: BreadthSlice | null;
  /** Heaviest S&P 500 names by weight; the app applies live moves to them. */
  weights: IndexWeight[] | null;
  catalysts: CatalystItem[];
  earnings: EarningsFocus | null;
  analysts: AnalystSummary | null;
  /** The desk's latest Stock in Focus note, or null when none has been posted. */
  stockInFocus: StockInFocusEntry | null;
}

/** What the 2-minute composed cache holds: everything except the entry, which is read fresher. */
export type WmnComposed = Omit<WmnSlidesPayload, "stockInFocus">;
