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
  analysisDocId,
  GENERAL_TTL_MS,
  TICKER_AI_COLLECTION,
  type AnalysisType,
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
/** Model budget for the BACKGROUND sweep, which runs in a job — no ceiling. */
const TIMEOUT_MS = 60_000;
/**
 * Budget for an ON-DEMAND generation. Much tighter: that path is reached
 * through the Firebase Hosting rewrite, which kills any request at 60s and
 * returns a 503 the app never sees. This has to cover a cold start too.
 */
const ON_DEMAND_TIMEOUT_MS = 24_000;
/** Newest articles pulled from storage when generating on demand. */
const ON_DEMAND_NEWS = 10;

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

  /**
   * lastUpdatedAt per ticker, for the tickers supplied. Absent from the map
   * means never analysed. One getAll instead of N reads, because the caller
   * runs this every 10 minutes over every ticker that received news.
   */
  async lastUpdatedMap(tickers: string[]): Promise<Map<string, string>> {
    // One scan of the general rows, reduced to the newest per ticker. Cheaper
    // than N per-ticker queries, and the collection stays small because only
    // generations land here, not every article.
    const out = new Map<string, string>();
    const want = new Set(tickers);
    const snap = await this.col.where("analysisType", "==", "general").get();
    for (const d of snap.docs) {
      const a = d.data() as TickerAiAnalysisDoc;
      if (!a.ticker || !want.has(a.ticker) || !a.lastUpdatedAt) continue;
      const prev = out.get(a.ticker);
      if (!prev || a.lastUpdatedAt > prev) out.set(a.ticker, a.lastUpdatedAt);
    }
    return out;
  }

  /**
   * Newest analysis of a given type for a ticker.
   *
   * The collection is append-only, so "current" is a query rather than a doc
   * read: order by generation time and take one.
   */
  async getCurrent(
    ticker: string,
    analysisType: AnalysisType = "general",
  ): Promise<TickerAiAnalysisDoc | null> {
    const snap = await this.col
      .where("ticker", "==", ticker)
      .where("analysisType", "==", analysisType)
      .orderBy("lastUpdatedAt", "desc")
      .limit(1)
      .get();
    return snap.empty ? null : (snap.docs[0].data() as TickerAiAnalysisDoc);
  }

  /** True when the stored general read is still inside its freshness window. */
  static isFresh(doc: TickerAiAnalysisDoc | null): boolean {
    if (!doc?.lastUpdatedAt) return false;
    const age = Date.now() - Date.parse(doc.lastUpdatedAt);
    return Number.isFinite(age) && age < GENERAL_TTL_MS;
  }

  /**
   * Create or incrementally update one ticker's analysis.
   *
   * Returns null when the model is disabled or produced nothing usable — the
   * caller records a failed analysis WITHOUT touching the stored news (§12:
   * "If news is saved but AI analysis fails, keep the news").
   */
  /**
   * Generate on first view, when the background sweep has not reached a ticker.
   *
   * The sweep covers a bounded number of tickers per cycle, so a thinly covered
   * name can legitimately have news in storage and no analysis yet — which
   * reads as broken to someone looking at that exact ticker. This closes the
   * gap: a miss generates once from the ticker's stored news, persists, and
   * every later view is a plain read.
   *
   * Deduped by an in-flight map so a double-click, or two users on the same
   * ticker, share ONE model call rather than racing two.
   */
  async getOrGenerate(ticker: string): Promise<TickerAiAnalysisDoc | null> {
    const existing = await this.getCurrent(ticker, "general");
    // Inside the TTL, serve the stored read — a second viewer within the hour
    // costs nothing. Past it, fall through and APPEND a fresh record.
    if (TickerAiAnalysisService.isFresh(existing)) return existing;
    // Model unavailable: return the stale read rather than nothing. A slightly
    // old analysis is far more useful than an empty widget.
    if (!this.openrouter.enabled) return existing;

    const inflight = TickerAiAnalysisService.inflight;
    const running = inflight.get(ticker);
    if (running) return running;

    const task = (async () => {
      try {
        const snap = await this.firebase.firestore
          .collection("news")
          .where("ticker", "==", ticker)
          .get();
        const news = snap.docs
          .map((d) => ({
            id: d.id,
            headline: String(d.data().headline ?? ""),
            summary: (d.data().summary as string | null) ?? null,
            source: String(d.data().source ?? ""),
            publishedAt: String(d.data().publishedAt ?? ""),
            tag: (d.data().tag as string | null) ?? null,
            filler: d.data().filler === true,
          }))
          // Filler carries a ticker but no event; analysing it produces a read
          // about syndication volume rather than about the company.
          .filter((n) => !n.filler && n.headline)
          .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
          .slice(0, ON_DEMAND_NEWS);
        if (!news.length) return existing;
        const fresh = await this.analyseTicker(ticker, news, {
          timeoutMs: ON_DEMAND_TIMEOUT_MS,
          analysisType: "general",
        });
        // A failed regeneration must not blank a widget that had content.
        return fresh ?? existing;
      } finally {
        inflight.delete(ticker);
      }
    })();
    inflight.set(ticker, task);
    return task;
  }

  /**
   * One-off analysis of a reported earnings result (spec: the "announcement"
   * flavour shown in the Live Feed's announcements section).
   *
   * Called by earnings-actuals.job the moment a figure first lands, so the
   * interpretation is tied to the print rather than waiting for a publisher to
   * write about it. Never expires and is never regenerated — it describes one
   * event at one time.
   */
  async recordAnnouncement(
    ticker: string,
    a: NonNullable<TickerAiAnalysisDoc["announcement"]>,
    news: NewsInput[],
    companyName?: string | null,
  ): Promise<TickerAiAnalysisDoc | null> {
    if (!this.openrouter.enabled) return null;
    const surprise =
      a.surprisePct == null ? "not computable" : `${a.surprisePct.toFixed(1)}%`;
    const context = [
      `EARNINGS RESULT just reported on ${a.reportDate}:`,
      `  EPS actual ${a.epsActual ?? "—"} vs estimate ${a.epsEstimate ?? "—"} (${a.verdict}, surprise ${surprise})`,
      `  Revenue actual ${a.revenueActual ?? "—"} vs estimate ${a.revenueEstimate ?? "—"}`,
      "Analyse THIS RESULT specifically: what the figures show, what they imply",
      "for the business, and how they change the picture. Do not speculate about",
      "the share price reaction — that is not in the data supplied.",
    ].join("\n");
    return this.analyseTicker(ticker, news, {
      companyName,
      context,
      analysisType: "announcement",
      announcement: a,
      timeoutMs: TIMEOUT_MS,
    });
  }

  /** Shared across instances so concurrent requests coalesce. */
  private static readonly inflight = new Map<
    string,
    Promise<TickerAiAnalysisDoc | null>
  >();

  async analyseTicker(
    ticker: string,
    news: NewsInput[],
    opts: {
      companyName?: string | null;
      context?: string;
      timeoutMs?: number;
      analysisType?: AnalysisType;
      announcement?: TickerAiAnalysisDoc["announcement"];
    } = {},
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
      { timeoutMs: opts.timeoutMs ?? TIMEOUT_MS },
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
      analysisType: opts.analysisType ?? "general",
      companyName: opts.companyName ?? previous?.companyName ?? null,
      sourceNewsIds: ids,
      sourceNewsCount: ids.length,
      analysisGeneratedAt: previous?.analysisGeneratedAt ?? now,
      lastUpdatedAt: now,
      analysisVersion: ANALYSIS_VERSION,
      revision: (previous?.revision ?? 0) + 1,
      lastMode: mode,
      ...(opts.announcement ? { announcement: opts.announcement } : {}),
    };
    // APPEND. Each generation is its own record, so the ticker's analysis
    // history survives and the weekly/monthly roll-ups can read the analyses
    // rather than re-reading raw news.
    await this.col
      .doc(analysisDocId(ticker, doc.analysisType, now))
      .set(doc);
    return doc;
  }
}
