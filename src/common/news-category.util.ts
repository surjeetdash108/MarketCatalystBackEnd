/**
 * Buckets a news story into one headline category for the feed's filter chips.
 *
 * Distinct from news-importance.util.ts, which answers "is this worth a
 * notification". This answers "which pill does it sit under". The patterns are
 * deliberately the same family as the importance ones — those are already tuned
 * against the live feed and handle both word orders ("guidance raised" AND
 * "raises full-year guidance").
 *
 * Order matters: the checks run most-specific first, because real headlines
 * routinely satisfy several. "Pfizer raises guidance after beating estimates
 * and announcing a buyback" is an EARNINGS story, not a capital-returns one.
 */

import { looksLikeDealButIsNot } from "./news-filler.util";

export type NewsCategory =
  | "earnings" | "analyst" | "ma" | "legal" | "product" | "capital" | "other";

/** Display labels for the feed chips. */
export const NEWS_CATEGORY_LABEL: Record<NewsCategory, string> = {
  earnings: "Earnings",
  analyst: "Analyst Actions",
  ma: "M&A",
  legal: "Legal & Regulatory",
  product: "Product & Launches",
  capital: "Capital & Dividends",
  other: "Other",
};

/** Chip order in the UI — "Other" always last, however big it gets. */
export const NEWS_CATEGORY_ORDER: NewsCategory[] = [
  "earnings", "analyst", "ma", "legal", "product", "capital", "other",
];

/**
 * Headlines that must never reach the M&A rules — 13F holdings boilerplate and
 * listicle clickbait, where "acquired" and "to buy" are not transactions.
 * Shared with news-filler.util so the patterns live in exactly one place.
 */
const RULES: Array<{ cat: NewsCategory; res: RegExp[]; headlineOnly?: boolean }> = [
  {
    cat: "earnings",
    res: [
      /\b(beats?|misses?|tops?|surpass\w*|fell short)\b[^.]{0,28}\b(estimate|expectation|consensus|eps|revenue|forecast)/i,
      /\b(estimate|expectation|consensus|eps|revenue)\b[^.]{0,28}\b(beat|miss|topped)/i,
      /\b(earnings|q[1-4]|quarterly|full[- ]year)\b[^.]{0,24}\b(beat|miss|result|report|call)/i,
      /\breports?\b[^.]{0,20}\b(q[1-4]|quarter|fiscal|earnings)/i,
      /\b(rais|cut|lower|withdraw|reaffirm|slash|hike)\w*\b[^.]{0,28}\bguidance\b|\bguidance\b[^.]{0,28}\b(rais|cut|lower|withdraw|reaffirm)/i,
    ],
  },
  {
    cat: "analyst",
    res: [
      /\b(upgrade[sd]?|downgrade[sd]?)\b/i,
      /\b(rais|cut|lower|hike|boost|trim)\w*\b[^.]{0,24}\bprice target\b|\bprice target\b[^.]{0,24}\b(rais|cut|lower|hike)/i,
      /\binitiat\w*\b[^.]{0,20}\bcoverage\b|\bcoverage\b[^.]{0,20}\binitiat/i,
      /\b(analyst|brokerage)s?\b[^.]{0,24}\b(rating|outlook|call)/i,
    ],
  },
  {
    cat: "ma",
    // HEADLINE ONLY. A real transaction always leads the headline, whereas the
    // word "acquisition" turns up constantly in body copy — "Why Tempus AI
    // Skyrocketed This Week" was tagged M&A purely off its summary. Every other
    // category still reads the summary, where the extra context helps.
    headlineOnly: true,
    res: [
      /\b(acquisition|merger|merges?|takeover|buyout|tender offer)\b/i,
      // Must be a DEAL verb, not the word "acquire" on its own: bare
      // /acquire[sd]?/ swallowed 13F boilerplate ("Apple Inc. Shares Acquired
      // by Balefire LLC"), which is a holdings disclosure, not a transaction.
      /\b(acquires?|acquiring)\b(?!\s+shares\b)/i,
      /\b(agrees?|agreed|deal|moves?)\s+to\s+(buy|acquire|purchase)\b/i,
      /\b(spin[- ]?off|divest\w*|sells? (its )?(unit|division|business))\b/i,
    ],
  },
  {
    cat: "legal",
    res: [
      /\b(lawsuit|sues?|sued|settlement|class action|investigation|probe|subpoena|fraud)\b/i,
      /\b(antitrust|fine[ds]?|penalt\w+|sanction\w*|charged? with|indict\w*)\b/i,
      /\b(sec|doj|ftc|regulator\w*|compliance)\b[^.]{0,24}\b(charge|suit|action|review|approv|rejec)/i,
      /\b(fda)\b[^.]{0,30}\b(reject|declin|refus|crl|complete response|warning)/i,
      /\b(recall|delist|halt(ed|s)?\b[^.]{0,12}trading|bankrupt|chapter 11)\b/i,
    ],
  },
  {
    cat: "product",
    res: [
      /\b(launch\w*|unveil\w*|introduc\w*|debut\w*|rollout|rolls? out|releases?)\b/i,
      /\b(partnership|partners? with|collaborat\w*|contract award|awarded a contract|selected by)\b/i,
      /\b(fda)\b[^.]{0,30}\b(approv|clearance|authoriz)/i,
      /\b(new|next[- ]gen\w*)\b[^.]{0,20}\b(product|platform|chip|model|service|app)\b/i,
    ],
  },
  {
    cat: "capital",
    res: [
      /\b(dividend)\b/i,
      /\b(buyback|repurchase|share repurchase)\b/i,
      /\b(stock split|reverse split)\b/i,
      /\b(offering|notes? due|convertible|secondary|raises? \$[\d.]+ ?(m|b|million|billion))\b/i,
    ],
  },
];

/**
 * @param headline required; @param summary optional extra context.
 * Summary is weighted the same, so a story whose headline is vague still lands
 * somewhere useful.
 */
export function categoriseNews(
  headline: string | null | undefined,
  summary?: string | null,
): NewsCategory {
  const head = (headline ?? "").replace(/\s+/g, " ").trim();
  const text = `${headline ?? ""} ${summary ?? ""}`.replace(/\s+/g, " ").trim();
  if (!text) return "other";
  const dealLookalike = looksLikeDealButIsNot(text);
  for (const { cat, res, headlineOnly } of RULES) {
    if (cat === "ma" && dealLookalike) continue;
    const hay = headlineOnly ? head : text;
    if (!hay) continue;
    for (const re of res) if (re.test(hay)) return cat;
  }
  return "other";
}
