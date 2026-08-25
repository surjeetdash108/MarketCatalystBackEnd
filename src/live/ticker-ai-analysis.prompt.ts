import type { AnalysisBody } from "./ticker-ai-analysis.types";

/**
 * Prompt construction for ticker analysis (spec §6, §7).
 *
 * Kept separate from the service so the wording is reviewable and testable
 * without standing up Firestore or the LLM client.
 */

export interface NewsInput {
  id: string;
  headline: string;
  summary: string | null;
  source: string;
  publishedAt: string;
  tag?: string | null;
}

const SCHEMA_KEYS = [
  "summary", "sentiment", "confidence", "keyDevelopments", "positiveFactors",
  "negativeFactors", "risks", "opportunities", "fundamentalImpact",
  "priceImpact", "shortTermImpact", "mediumTermImpact",
  "investorInterpretation", "overallAssessment",
];

/**
 * §7 is explicit that the read must not invent facts and must separate what
 * the news says from what is inferred. That instruction lives here, once.
 */
export const SYSTEM_PROMPT = `You are an equity analyst producing a structured read on ONE ticker.

Rules, in order of importance:
1. NEVER invent facts. Every claim must trace to the supplied news or the prior
   analysis. If the news does not support a field, say so plainly or leave it
   brief — do not fill space.
2. Separate FACT from INFERENCE. State what happened, then label reasoning as
   likely/possible. Flag genuine uncertainty rather than resolving it.
3. Analyse implications, do not summarise headlines. The reader can already see
   the headlines; they want to know what it MEANS for the company.
4. No price targets, no buy/sell recommendations.
5. Respond with ONLY a JSON object using exactly these keys:
   ${SCHEMA_KEYS.join(", ")}.
   sentiment is one of: positive, negative, neutral, mixed.
   confidence is a number from 0 to 1 reflecting how well the evidence supports
   the read — thin or ambiguous news means a LOW number, not a hedged essay.
   The array fields are arrays of short strings. The rest are prose strings.`;

function renderNews(news: NewsInput[]): string {
  if (!news.length) return "(no new articles)";
  return news
    .map(
      (n, i) =>
        `${i + 1}. [${n.publishedAt.slice(0, 10)}] ${n.headline}` +
        (n.tag ? ` (${n.tag})` : "") +
        ` — ${n.source}` +
        // 200 not 400: summary text is the bulk of the prompt, and the
        // headline plus a short lede carries the signal. Halving this keeps
        // reads inside Groq's per-minute token ceiling.
        (n.summary ? `\n   ${n.summary.slice(0, 200)}` : ""),
    )
    .join("\n");
}

/** Case 1 (§6): no prior analysis exists. */
export function buildCreatePrompt(
  ticker: string,
  companyName: string | null,
  news: NewsInput[],
  context?: string,
): string {
  return [
    `Ticker: ${ticker}${companyName ? ` (${companyName})` : ""}`,
    context ? `\nCompany context:\n${context}` : "",
    `\nNews (newest first):\n${renderNews(news)}`,
    `\nProduce the first analysis for this ticker from the news above.`,
  ].join("\n");
}

/**
 * Case 2 (§6): a prior analysis exists.
 *
 * The spec is emphatic that this must not be a blind overwrite NOR a
 * concatenation — the model has to read the previous verdict and revise it.
 * So the prior analysis is supplied as context to be reconciled, with explicit
 * instructions about what to keep, what to change and what to drop.
 */
export function buildUpdatePrompt(
  ticker: string,
  companyName: string | null,
  previous: AnalysisBody,
  previousGeneratedAt: string,
  news: NewsInput[],
  context?: string,
): string {
  return [
    `Ticker: ${ticker}${companyName ? ` (${companyName})` : ""}`,
    context ? `\nCompany context:\n${context}` : "",
    `\nPREVIOUS ANALYSIS (generated ${previousGeneratedAt}):`,
    JSON.stringify(
      {
        summary: previous.summary,
        sentiment: previous.sentiment,
        keyDevelopments: previous.keyDevelopments,
        risks: previous.risks,
        opportunities: previous.opportunities,
        overallAssessment: previous.overallAssessment,
      },
      null,
      1,
    ),
    `\nNEW NEWS SINCE THEN (newest first):\n${renderNews(news)}`,
    `\nProduce an UPDATED analysis that supersedes the previous one.
- Carry forward prior points that still hold; do not repeat them verbatim if
  the new news refines them.
- Where the new news CHANGES a prior conclusion, say what changed and why.
- Drop prior points the new news has resolved or made obsolete.
- Do not simply append the new items to the old lists — reconcile them into a
  single current picture.
- If the new news is immaterial, say so and keep the prior read largely intact
  rather than manufacturing change.`,
  ].join("\n");
}
