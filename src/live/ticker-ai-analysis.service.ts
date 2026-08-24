import { Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { OpenRouterService } from "../vendors/openrouter/openrouter.service";
import {
  buildCreatePrompt,
  buildUpdatePrompt,
  SYSTEM_PROMPT,
  type NewsInput,
} from "./ticker-ai-analysis.prompt";
import {
  ANALYSIS_VERSION,
  TICKER_AI_COLLECTION,
  type AnalysisBody,
  type Sentiment,
  type TickerAiAnalysisDoc,
} from "./ticker-ai-analysis.types";

/**
 * Maintains ONE current AI analysis per ticker (spec §5–§7).
 *
 * Cost control (§15): a run sends the previous analysis plus the newly
 * inserted articles — never the ticker's whole news history. The previous
 * analysis IS the compressed history, which is the point of keeping continuity
 * rather than regenerating from scratch each cycle.
 */

/** Newly-inserted articles per ticker fed to one incremental run. */
const MAX_NEWS_PER_RUN = 12;
/** Model budget. Generous: this runs in a JOB, so no Hosting 60s ceiling. */
const TIMEOUT_MS = 60_000;

const SENTIMENTS: Sentiment[] = ["positive", "negative", "neutral", "mixed"];

/** Coerce the model's JSON into the schema — never trust field-by-field. */
export function coerceBody(raw: unknown): AnalysisBody | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const arr = (v: unknown) =>
    Array.isArray(v)
      ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 12)
      : [];
  const summary = str(o.summary);
  const overall = str(o.overallAssessment);
  // A read with neither a summary nor an assessment is not a read.
  if (!summary && !overall) return null;
  const sentiment = SENTIMENTS.includes(o.sentiment as Sentiment)
    ? (o.sentiment as Sentiment)
    : "neutral";
  let confidence = Number(o.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.min(1, Math.max(0, confidence));
  return {
    summary,
    sentiment,
    confidence,
    keyDevelopments: arr(o.keyDevelopments),
    positiveFactors: arr(o.positiveFactors),
    negativeFactors: arr(o.negativeFactors),
    risks: arr(o.risks),
    opportunities: arr(o.opportunities),
    fundamentalImpact: str(o.fundamentalImpact),
    priceImpact: str(o.priceImpact),
    shortTermImpact: str(o.shortTermImpact),
    mediumTermImpact: str(o.mediumTermImpact),
    investorInterpretation: str(o.investorInterpretation),
    overallAssessment: overall,
  };
}

/** First balanced JSON object in a reply, tolerating fences and prose. */
export function extractJson(text: string): unknown {
  const fenced = text.replace(/```(?:json)?/gi, " ");
  const start = fenced.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < fenced.length; i++) {
    const ch = fenced[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try { return JSON.parse(fenced.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

@Injectable()
export class TickerAiAnalysisService {
  private readonly logger = new Logger(TickerAiAnalysisService.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly openrouter: OpenRouterService,
  ) {}

  private get col() {
    return this.firebase.firestore.collection(TICKER_AI_COLLECTION);
  }

  async getCurrent(ticker: string): Promise<TickerAiAnalysisDoc | null> {
    const snap = await this.col.doc(ticker).get();
    return snap.exists ? (snap.data() as TickerAiAnalysisDoc) : null;
  }

  /**
   * Create or incrementally update one ticker's analysis.
   *
   * Returns null when the model is disabled or produced nothing usable — the
   * caller records a failed analysis WITHOUT touching the stored news (§12:
   * "If news is saved but AI analysis fails, keep the news").
   */
  async analyseTicker(
    ticker: string,
    news: NewsInput[],
    opts: { companyName?: string | null; context?: string } = {},
  ): Promise<TickerAiAnalysisDoc | null> {
    if (!this.openrouter.enabled) return null;
    if (!news.length) return null;

    const recent = [...news]
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, MAX_NEWS_PER_RUN);

    const previous = await this.getCurrent(ticker);
    const mode: "created" | "updated" = previous ? "updated" : "created";

    const user = previous
      ? buildUpdatePrompt(
          ticker, opts.companyName ?? previous.companyName ?? null,
          previous, previous.analysisGeneratedAt, recent, opts.context,
        )
      : buildCreatePrompt(
          ticker, opts.companyName ?? null, recent, opts.context,
        );

    const reply = await this.openrouter.chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      { timeoutMs: TIMEOUT_MS },
    );
    if (!reply) {
      this.logger.warn(`ticker-ai: no reply for ${ticker} (${mode})`);
      return null;
    }
    const body = coerceBody(extractJson(reply));
    if (!body) {
      this.logger.warn(
        `ticker-ai: unparseable reply for ${ticker}: ${reply.slice(0, 160)}`,
      );
      return null;
    }

    const now = new Date().toISOString();
    // Union of ids so the audit trail accumulates across revisions, capped so
    // the doc cannot grow without bound.
    const ids = [...new Set([...recent.map((n) => n.id), ...(previous?.sourceNewsIds ?? [])])]
      .slice(0, 200);

    const doc: TickerAiAnalysisDoc = {
      ...body,
      ticker,
      companyName: opts.companyName ?? previous?.companyName ?? null,
      sourceNewsIds: ids,
      sourceNewsCount: ids.length,
      analysisGeneratedAt: previous?.analysisGeneratedAt ?? now,
      lastUpdatedAt: now,
      analysisVersion: ANALYSIS_VERSION,
      revision: (previous?.revision ?? 0) + 1,
      lastMode: mode,
    };
    await this.col.doc(ticker).set(doc, { merge: true });
    return doc;
  }
}
