import type { CanonicalNewsArticle } from '../adapters/types';

/**
 * Decides whether a news article is "important" enough to raise a notification.
 *
 * WHY THIS IS DERIVED RATHER THAN READ FROM THE VENDOR
 * No configured source supplies an importance flag. Polygon's news carries
 * sentiment/keywords but no score; Finnhub carries neither (it is ~80% of the
 * aggregate feed, and every one of its articles arrives with sentiment: null).
 * Benzinga publishes a real editorial `importance` 0-5, but that endpoint
 * returns 403 on the current plan. So importance is inferred from two signals:
 *
 *   1. Vendor sentiment, when present and not neutral.
 *   2. Headline pattern match against events that reliably move a stock.
 *
 * Keeping both matters: sentiment alone would cover only the Polygon subset and
 * would currently never fire on bad news (the feed has zero negative articles),
 * so every downside alert would be missed.
 *
 * Tuning happens here and nowhere else — the job just calls scoreImportance().
 */

/** Headline patterns that reliably indicate a market-moving event. */
const HIGH_IMPACT: Array<{ re: RegExp; label: string }> = [
  { re: /\b(beats?|misses?|tops?)\b.{0,24}\b(estimate|expectation|consensus|eps|revenue)/i, label: 'earnings-surprise' },
  { re: /\b(earnings|q[1-4]|quarterly)\b.{0,20}\b(beat|miss|result|report)/i, label: 'earnings' },
  // Both word orders: "guidance raised" AND "cuts full-year guidance". Real
  // headlines overwhelmingly use the verb-first form, which a noun-first-only
  // pattern silently missed.
  { re: /\b(rais|cut|lower|withdraw|reaffirm|slash|hike)\w*\b.{0,28}\bguidance\b|\bguidance\b.{0,28}\b(rais|cut|lower|withdraw|reaffirm|slash|hike)/i, label: 'guidance' },
  { re: /\b(upgrade[sd]?|downgrade[sd]?)\b/i, label: 'analyst-action' },
  { re: /\b(rais|cut|lower|hike|boost|trim)\w*\b.{0,24}\bprice target\b|\bprice target\b.{0,24}\b(rais|cut|lower|hike|boost|trim)/i, label: 'price-target' },
  { re: /\b(acquire[sd]?|acquisition|merger|takeover|buyout)\b/i, label: 'm-and-a' },
  { re: /\b(fda)\b.{0,30}\b(approv|reject|clearance|decision)/i, label: 'fda' },
  { re: /\b(bankrupt|chapter 11|insolvenc)/i, label: 'distress' },
  { re: /\b(ceo|cfo)\b.{0,24}\b(step[s]? down|resign|depart|out|appoint|nam(e|ing))/i, label: 'leadership' },
  { re: /\b(lawsuit|sues?|settlement|investigation|probe|subpoena)\b/i, label: 'legal' },
  { re: /\b(recall|halt(ed|s)?\b.{0,12}trading|delist)/i, label: 'trading-event' },
  { re: /\b(split|dividend)\b.{0,20}\b(announce|declar|increas|cut|suspend)/i, label: 'capital-return' },
  { re: /\b(soar|plunge|surge|tumble|crash|spike)[sd]?\b/i, label: 'large-move' },
];

/**
 * Directional headline patterns — which way the event moves the stock. Used to
 * infer a +ve/-ve direction when the vendor gives no directional sentiment
 * (Finnhub, ~80% of the feed, always sends sentiment: null), so downside and
 * upside alerts both carry a colour, not just Polygon's subset.
 */
const POSITIVE_HEADLINE: RegExp[] = [
  /\b(beat|beats|tops?|topped|surpass\w*)\b.{0,24}\b(estimate|expectation|consensus|eps|revenue|forecast)/i,
  /\bguidance\b.{0,28}\b(rais|hik|boost|increas|lift)/i,
  /\b(rais|hik|boost|increas|lift)\w*\b.{0,28}\bguidance\b/i,
  /\bupgrade[sd]?\b/i,
  /\bprice target\b.{0,24}\b(rais|hik|boost|increas)/i,
  /\b(rais|hik|boost|increas)\w*\b.{0,24}\bprice target\b/i,
  /\b(fda)\b.{0,30}\b(approv|clearance|authoriz)/i,
  /\b(soar|surge|spike|jump|rally|rallie|climb|gain|rocket|jumps?)\w*\b/i,
  /\b(dividend|buyback|repurchase)\b.{0,20}\b(increas|rais|declar|announce|boost|hik)/i,
  /\b(record|strong|robust|blowout)\b.{0,16}\b(revenue|profit|earnings|sales|quarter|results?)/i,
];
const NEGATIVE_HEADLINE: RegExp[] = [
  /\b(miss|misses|missed|fell short|shortfall|disappoint\w*)\b.{0,24}\b(estimate|expectation|consensus|eps|revenue|forecast)/i,
  /\bguidance\b.{0,28}\b(cut|lower|slash|withdraw|reduc|trim)/i,
  /\b(cut|lower|slash|withdraw|reduc|trim)\w*\b.{0,28}\bguidance\b/i,
  /\bdowngrade[sd]?\b/i,
  /\bprice target\b.{0,24}\b(cut|lower|slash|reduc)/i,
  /\b(cut|lower|slash|reduc)\w*\b.{0,24}\bprice target\b/i,
  /\b(fda)\b.{0,30}\b(reject|declin|refus|crl|complete response)/i,
  /\b(plunge|tumble|crash|slump|sink|slide|plummet|sell-?off|drop)\w*\b/i,
  /\b(bankrupt|chapter 11|insolvenc|default)/i,
  /\b(lawsuit|sues?|sued|investigation|probe|subpoena|fraud|recall|delist|halt(ed|s)?\b.{0,12}trading)/i,
  /\b(ceo|cfo)\b.{0,24}\b(step[s]? down|resign|depart|oust|fire[ds]?)/i,
  /\bdividend\b.{0,20}\b(cut|suspend|slash|omit)/i,
  /\b(layoff|job cut|restructur|writedown|write-down|impairment|warn(s|ing)?)\b/i,
];

export type NewsDirection = 'positive' | 'negative' | 'neutral';

export interface ImportanceVerdict {
  important: boolean;
  /** Whether the news reads +ve, -ve or neutral for the stock — vendor
   *  sentiment first, then directional headline keywords. */
  direction: NewsDirection;
  /** Why it fired — stored on the notification so a human can audit the rule. */
  reasons: string[];
}

/** +ve/-ve/neutral: vendor sentiment when directional, else headline keywords. */
function scoreDirection(sentiment: string | null | undefined, headline: string): NewsDirection {
  if (sentiment === 'positive') return 'positive';
  if (sentiment === 'negative') return 'negative';
  const pos = POSITIVE_HEADLINE.some((re) => re.test(headline));
  const neg = NEGATIVE_HEADLINE.some((re) => re.test(headline));
  if (pos && !neg) return 'positive';
  if (neg && !pos) return 'negative';
  return 'neutral'; // mixed signals or none — don't guess a direction
}

/**
 * @param a canonical article (any vendor)
 * @returns verdict plus the specific signals that triggered it
 */
export function scoreImportance(a: CanonicalNewsArticle): ImportanceVerdict {
  const reasons: string[] = [];

  // 1. Vendor sentiment — only meaningful when present AND directional.
  if (a.sentiment === 'positive' || a.sentiment === 'negative') {
    reasons.push(`sentiment:${a.sentiment}`);
  }

  // 2. Headline patterns. Summary is deliberately NOT searched: it is long,
  //    frequently boilerplate, and matching it produced far more noise than
  //    signal in practice.
  const headline = a.headline ?? '';
  for (const { re, label } of HIGH_IMPACT) {
    if (re.test(headline)) reasons.push(`keyword:${label}`);
  }

  const direction = scoreDirection(a.sentiment, headline);
  if (direction !== 'neutral') reasons.push(`direction:${direction}`);

  return { important: reasons.length > 0, direction, reasons };
}
