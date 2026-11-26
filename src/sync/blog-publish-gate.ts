import type { Firestore } from "firebase-admin/firestore";

/**
 * Publish gate for generated blog posts (24 Nov 2026 site audit, B-19 / B-21).
 * A post that fails a check is saved as a draft and held in the admin Content
 * pipeline ("Needs review", with the reasons) instead of being published.
 * Pulse and Live Feed are not gated: they post as entered.
 */

/** Text that must never reach a reader: template placeholders and model notes. */
const MARKERS: Array<[RegExp, string]> = [
  [/PLACEHOLDER/i, "Contains a placeholder"],
  [/Optional note/i, "Contains a model note ('Optional note')"],
  [
    /could not be independently verified/i,
    "Contains a model note ('could not be independently verified')",
  ],
  [
    /\[(?:note|todo|tbd|insert)[^\]]*\]/i,
    "Contains an editor's note in brackets",
  ],
  [/\bas an AI\b/i, "Contains model self-reference"],
];

export function textReasons(html: string): string[] {
  const text = html.replace(/<style[\s\S]*?<\/style>/gi, " ");
  return MARKERS.filter(([re]) => re.test(text)).map(([, why]) => why);
}

/**
 * Whether a new post goes live (B-21): every post created through the blog
 * service, by any writer, is checked; one carrying a marker is saved as a
 * draft and `held` names why.
 */
export function createDecision(html: string, wantsPublished: boolean): { published: boolean; held: string[] } {
  const held = wantsPublished ? textReasons(html) : [];
  return { published: wantsPublished && held.length === 0, held };
}

const UP_WORDS =
  /\b(climb|climbs|climbed|rises|rise|rose|rally|rallies|rallied|gains|gained|surges|surged|jumps|jumped|advances|advanced|higher)\b/i;
const DOWN_WORDS =
  /\b(falls|fall|fell|slides|slide|slid|drops|dropped|sinks|sank|tumbles|tumbled|retreats|retreated|slip|plummets|plunges|dive|dives|declines|declined|slips|slipped|lower|sell-?off|slumps|slumped)\b/i;

/**
 * A recap headline/dek whose direction contradicts the S&P 500 in the same
 * post (B-22: "Broad market climbs…" with the S&P 500 at −0.48%). Only clear
 * moves (±0.25%) count, and mixed wording ("Dow climbs while the Nasdaq
 * tumbles") is not flagged.
 */
export function directionReasons(
  headline: string,
  spPct: number | null,
): string[] {
  if (spPct == null || Math.abs(spPct) < 0.25) return [];
  const up = UP_WORDS.test(headline);
  const down = DOWN_WORDS.test(headline);
  if (up && !down && spPct < 0)
    return [
      `Headline says the market rose, but the S&P 500 fell ${spPct.toFixed(2)}%`,
    ];
  if (down && !up && spPct > 0)
    return [
      `Headline says the market fell, but the S&P 500 rose +${spPct.toFixed(2)}%`,
    ];
  return [];
}

/**
 * Owner-approved limits (26 Nov 2026, tightened 27 Nov): figures past these
 * are nearly always a data mismatch. The owner's request was |surprise| > 50%
 * and |YoY| > 80%; where the existing limit was already stricter (25% surprise,
 * -50% YoY) it is kept.
 */
export const MAX_REVENUE_SURPRISE_PCT = 25;
export const MAX_REVENUE_YOY_UP_PCT = 80;
export const MAX_REVENUE_YOY_DOWN_PCT = -50;
/**
 * A company this size rarely beats or misses revenue by more than this; when
 * it "does", the estimate is usually on another basis (B-19, Deere: a $10.38B
 * equipment-sales estimate against $12.12B total revenue, a "17% beat").
 */
export const LARGE_REVENUE = 1e9;
export const MAX_LARGE_REVENUE_SURPRISE_PCT = 10;
export const EPS_GAP_HOLD_DOLLARS = 0.5;
export const EPS_GAP_HOLD_PCT = 100;

export interface ScorecardFigures {
  revenueActual: number | null;
  revenueEstimate: number | null;
  revenueYoyPct: number | null;
  epsActual: number | null;
  epsEstimate: number | null;
}

/** Why an earnings scorecard's numbers look wrong (B-19: AECOM +103%, Shift4 -100%, JBS -81%). */
export function figureReasons(f: ScorecardFigures): string[] {
  const out: string[] = [];
  if (
    f.revenueActual != null &&
    f.revenueEstimate != null &&
    f.revenueEstimate > 0
  ) {
    const s = ((f.revenueActual - f.revenueEstimate) / f.revenueEstimate) * 100;
    if (Math.abs(s) > MAX_REVENUE_SURPRISE_PCT)
      out.push(
        `Revenue ${s > 0 ? "beat" : "miss"} of ${Math.round(Math.abs(s))}% vs the estimate (over ${MAX_REVENUE_SURPRISE_PCT}%)`,
      );
    else if (
      f.revenueActual >= LARGE_REVENUE &&
      Math.abs(s) > MAX_LARGE_REVENUE_SURPRISE_PCT
    )
      out.push(
        `Revenue ${s > 0 ? "beat" : "miss"} of ${Math.round(Math.abs(s))}% for a company with over $${LARGE_REVENUE / 1e9}B in revenue: the estimate may be on another basis`,
      );
  }
  if (
    f.revenueYoyPct != null &&
    (f.revenueYoyPct > MAX_REVENUE_YOY_UP_PCT ||
      f.revenueYoyPct < MAX_REVENUE_YOY_DOWN_PCT)
  ) {
    out.push(
      `Revenue ${f.revenueYoyPct > 0 ? "up" : "down"} ${Math.round(Math.abs(f.revenueYoyPct))}% year over year`,
    );
  }
  if (f.epsActual != null && f.epsEstimate != null) {
    const gap = Math.abs(f.epsActual - f.epsEstimate);
    const pct =
      f.epsEstimate !== 0 ? (gap / Math.abs(f.epsEstimate)) * 100 : Infinity;
    if (gap > EPS_GAP_HOLD_DOLLARS && pct > EPS_GAP_HOLD_PCT)
      out.push(
        `EPS ${f.epsActual.toFixed(2)} vs ${f.epsEstimate.toFixed(2)} expected (off by $${gap.toFixed(2)})`,
      );
  }
  return out;
}

/**
 * A listing that isn't the company's common stock (B-05: DAVEW warrant,
 * VSECU unit, SCCF/DUKB notes): a 5-letter symbol ending W/U/R, a class
 * suffix (".WS", "-U"), or a name carrying a coupon ("7.125%").
 */
export function notCommonStock(symbol: string, name: string): boolean {
  const s = symbol.toUpperCase();
  if (/^[A-Z]{4}[WUR]$/.test(s)) return true;
  if (/[.-](W|WS|WT|U|UN|R|RT|P[A-Z]?)$/.test(s)) return true;
  if (/\d+(\.\d+)?\s*%/.test(name)) return true;
  return false;
}

/**
 * Holds a drafted post for review: one content_items row the admin approves
 * (it publishes as is) or deletes.
 */
export async function holdForReview(
  db: Firestore,
  p: {
    postId: string;
    title: string;
    reasons: string[];
    tickers: string[];
    source: string;
    section?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db.collection("content_items").add({
    kind: "blog",
    status: "review",
    source: "generator",
    heldReasons: p.reasons,
    note: `Held for review: ${p.reasons.join("; ")}`,
    batchId: `held-${p.postId}`,
    submittedBy: p.source,
    createdAt: now,
    updatedAt: now,
    tickers: p.tickers,
    section: p.section ?? "Earnings",
    headline: p.title,
    blogPostId: p.postId,
    attempts: 0,
    error: null,
  });
}
