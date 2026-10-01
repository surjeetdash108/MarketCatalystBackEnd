import { Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { LlmGatewayService } from "../vendors/llm-gateway.service";
import { coerceBody, extractJson } from "./ticker-ai-analysis.service";
import { SYSTEM_PROMPT } from "./ticker-ai-analysis.prompt";
import { ANALYSIS_VERSION, type AnalysisBody } from "./ticker-ai-analysis.types";

/**
 * "What Matters Now" — a market-wide read of the last hour, cached.
 *
 * Generated ON DEMAND with a 1-hour TTL, exactly like the general ticker
 * analysis: the first viewer in an hour pays for the model call, everyone
 * after reads the stored record. Records are append-only so the hourly
 * sequence is preserved and can be looked back over.
 *
 * SOURCES, and the rule that governs them:
 *   - major news from the window (non-filler, real category)
 *   - EVERY analysis written to ticker_ai_analysis in the window
 *   - earnings results that landed in the window
 *
 * The ticker_ai_analysis read is deliberately NOT filtered by analysisType.
 * Whatever types exist — general, announcement, and anything added later such
 * as 13F filings or insider activity — are included automatically. Adding a
 * new type must never require editing this file.
 */

export const WMN_COLLECTION = "what_matters_now";
export const WMN_TTL_MS = 60 * 60 * 1000;
/** Model budget. Reached through the Hosting rewrite, which cuts at 60s. */
const TIMEOUT_MS = 24_000;
const MAX_NEWS = 14;
const MAX_ANALYSES = 10;

export interface WhatMattersNowDoc extends AnalysisBody {
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  analysisVersion: number;
  sourceNewsIds: string[];
  sourceAnalysisIds: string[];
  /** Tickers the read actually discusses, for linking out of the card. */
  tickers: string[];
  sourceCounts: { news: number; analyses: number; earnings: number };
}

@Injectable()
export class WhatMattersNowService {
  private readonly logger = new Logger(WhatMattersNowService.name);
  private static inflight: Promise<WhatMattersNowDoc | null> | null = null;

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly llm: LlmGatewayService,
  ) {}

  private get col() {
    return this.firebase.firestore.collection(WMN_COLLECTION);
  }

  /** Newest stored digest, or null. */
  async getLatest(): Promise<WhatMattersNowDoc | null> {
    const snap = await this.col.orderBy("generatedAt", "desc").limit(1).get();
    return snap.empty ? null : (snap.docs[0].data() as WhatMattersNowDoc);
  }

  static isFresh(doc: WhatMattersNowDoc | null): boolean {
    if (!doc?.generatedAt) return false;
    const age = Date.now() - Date.parse(doc.generatedAt);
    return Number.isFinite(age) && age < WMN_TTL_MS;
  }

  /**
   * Cached read, regenerating at most once an hour. Concurrent callers share
   * one generation through the in-flight promise, so a burst of dashboard
   * loads cannot fan out into several model calls.
   */
  async getOrGenerate(): Promise<WhatMattersNowDoc | null> {
    const existing = await this.getLatest();
    if (WhatMattersNowService.isFresh(existing)) return existing;
    if (!this.llm.enabled) return existing;
    if (WhatMattersNowService.inflight) return WhatMattersNowService.inflight;

    WhatMattersNowService.inflight = this.generate()
      .then((fresh) => fresh ?? existing)
      .finally(() => {
        WhatMattersNowService.inflight = null;
      });
    return WhatMattersNowService.inflight;
  }

  private async generate(): Promise<WhatMattersNowDoc | null> {
    const end = new Date();
    // A 3-hour lookback, not 1: an hour of overnight or weekend market time can
    // legitimately contain nothing, and an empty digest is worse than a
    // slightly wider one.
    const start = new Date(end.getTime() - 3 * 60 * 60 * 1000);
    const startIso = start.toISOString();

    const [newsSnap, analysisSnap] = await Promise.all([
      this.firebase.firestore
        .collection("news")
        .where("publishedAt", ">=", startIso)
        .get(),
      this.firebase.firestore
        .collection("ticker_ai_analysis")
        .where("lastUpdatedAt", ">=", startIso)
        .get(),
    ]);

    const news = newsSnap.docs
      .map((d): Record<string, unknown> => ({ ...d.data(), id: d.id }))
      .filter((a) => a.filler !== true && String(a.tag ?? "other") !== "other")
      .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
      .slice(0, MAX_NEWS);

    // No type filter — see the class comment. New analysis types flow in here
    // automatically.
    const analyses = analysisSnap.docs
      .map((d): Record<string, unknown> => ({ ...d.data(), id: d.id }))
      .sort((a, b) => String(b.lastUpdatedAt).localeCompare(String(a.lastUpdatedAt)))
      .slice(0, MAX_ANALYSES);

    const earnings = analyses.filter((a) => a.analysisType === "announcement");

    if (!news.length && !analyses.length) {
      this.logger.log("what-matters-now: nothing material in the window");
      return null;
    }

    const lines = [
      `Market window: ${startIso.slice(0, 16)} to ${end.toISOString().slice(0, 16)} UTC.`,
      "",
      "MAJOR NEWS:",
      news.length
        ? news
            .map((n, i) => `${i + 1}. [${n.ticker}] ${n.headline}${n.tag ? ` (${n.tag})` : ""}`)
            .join("\n")
        : "(none)",
      "",
      "ANALYSES WRITTEN IN THIS WINDOW:",
      analyses.length
        ? analyses
            .map(
              (a) =>
                `- [${a.ticker}] ${a.analysisType}: ${String(a.summary ?? "").slice(0, 180)}`,
            )
            .join("\n")
        : "(none)",
      "",
      `Write a MARKET-WIDE read of what matters right now. Lead with what a
reader must know first. Name the tickers involved. Where several stories
share a driver, say so rather than listing them separately. If the window is
genuinely quiet, say that plainly instead of inflating minor items.`,
    ];

    const reply = await this.llm.chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: lines.join("\n") },
      ],
      { timeoutMs: TIMEOUT_MS },
    );
    if (!reply) {
      this.logger.warn("what-matters-now: no reply from the model");
      return null;
    }
    const body = coerceBody(extractJson(reply));
    if (!body) {
      this.logger.warn("what-matters-now: unparseable reply");
      return null;
    }

    const generatedAt = end.toISOString();
    const doc: WhatMattersNowDoc = {
      ...body,
      windowStart: startIso,
      windowEnd: generatedAt,
      generatedAt,
      analysisVersion: ANALYSIS_VERSION,
      sourceNewsIds: news.map((n) => String(n.id)),
      sourceAnalysisIds: analyses.map((a) => String(a.id)),
      tickers: [
        ...new Set(
          [...news, ...analyses].map((x) => String(x.ticker ?? "")).filter(Boolean),
        ),
      ].slice(0, 30),
      sourceCounts: {
        news: news.length,
        analyses: analyses.length,
        earnings: earnings.length,
      },
    };
    // Append-only: one record per generation, so the hourly sequence is kept.
    await this.col.doc(generatedAt.slice(0, 13).replace(/[-T:]/g, "")).set(doc);
    return doc;
  }
}
