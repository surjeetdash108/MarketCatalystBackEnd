import { Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { LlmGatewayService } from "../vendors/llm-gateway.service";
import { SYSTEM_PROMPT, type NewsInput } from "./ticker-ai-analysis.prompt";
import { coerceBody, extractJson } from "./ticker-ai-analysis.service";
import {
  ANALYSIS_VERSION,
  TICKER_MONTHLY_AI_COLLECTION,
  TICKER_WEEKLY_AI_COLLECTION,
  type TickerAiAnalysisDoc,
  type TickerPeriodAnalysisDoc,
} from "./ticker-ai-analysis.types";

/**
 * Weekly and monthly period analyses (spec §8, §10).
 *
 * Append-only history: the doc id is `${ticker}_${periodStart}`, so re-running
 * a period corrects THAT period and never disturbs the ones around it — §8's
 * "Do not overwrite previous weeks".
 */

const TIMEOUT_MS = 90_000;
const MAX_NEWS = 60;

@Injectable()
export class TickerPeriodAnalysisService {
  private readonly logger = new Logger(TickerPeriodAnalysisService.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly llm: LlmGatewayService,
  ) {}

  private col(kind: "weekly" | "monthly") {
    return this.firebase.firestore.collection(
      kind === "weekly" ? TICKER_WEEKLY_AI_COLLECTION : TICKER_MONTHLY_AI_COLLECTION,
    );
  }

  /** Weekly rows inside a date range — the monthly roll-up's extra input. */
  async weeklyBetween(
    ticker: string, start: string, end: string,
  ): Promise<TickerPeriodAnalysisDoc[]> {
    const snap = await this.col("weekly")
      .where("ticker", "==", ticker)
      .where("periodStart", ">=", start)
      .where("periodStart", "<=", end)
      .get();
    return snap.docs.map((d) => d.data() as TickerPeriodAnalysisDoc);
  }

  /** Has a successful analysis been persisted for this period? Gates cleanup. */
  async exists(
    kind: "weekly" | "monthly", ticker: string, periodStart: string,
  ): Promise<boolean> {
    const snap = await this.col(kind).doc(`${ticker}_${periodStart}`).get();
    return snap.exists;
  }

  async generate(
    kind: "weekly" | "monthly",
    ticker: string,
    period: { start: string; end: string },
    news: NewsInput[],
    opts: {
      companyName?: string | null;
      current?: TickerAiAnalysisDoc | null;
      weeklies?: TickerPeriodAnalysisDoc[];
      previousPeriod?: TickerPeriodAnalysisDoc | null;
    } = {},
  ): Promise<TickerPeriodAnalysisDoc | null> {
    if (!this.llm.enabled) return null;
    // Nothing to analyse is not a failure — it just means a quiet period.
    if (!news.length && !(opts.weeklies?.length)) return null;

    const trimmed = [...news]
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, MAX_NEWS);

    const label = kind === "weekly" ? "week" : "month";
    const parts = [
      `Ticker: ${ticker}${opts.companyName ? ` (${opts.companyName})` : ""}`,
      `Period: ${period.start} to ${period.end} (one ${label})`,
    ];
    if (opts.current) {
      parts.push(
        `\nCURRENT ROLLING ANALYSIS:\n${JSON.stringify(
          { summary: opts.current.summary, sentiment: opts.current.sentiment,
            overallAssessment: opts.current.overallAssessment }, null, 1)}`,
      );
    }
    if (opts.previousPeriod) {
      parts.push(
        `\nPREVIOUS ${label.toUpperCase()} (${opts.previousPeriod.periodStart}):\n` +
        `${opts.previousPeriod.summary}\nAssessment: ${opts.previousPeriod.overallAssessment}`,
      );
    }
    if (opts.weeklies?.length) {
      parts.push(
        `\nWEEKLY ANALYSES FROM THIS MONTH:\n` +
        opts.weeklies.map((w) => `- ${w.periodStart}: ${w.summary}`).join("\n"),
      );
    }
    parts.push(
      `\nNEWS IN PERIOD (${trimmed.length} of ${news.length}, newest first):\n` +
      (trimmed.length
        ? trimmed.map((n, i) =>
            `${i + 1}. [${n.publishedAt.slice(0, 10)}] ${n.headline} — ${n.source}`,
          ).join("\n")
        : "(none)"),
    );
    parts.push(
      `\nProduce the ${label}ly analysis. Beyond the standard fields, make sure:
- summary answers "what happened this ${label}"
- keyDevelopments lists the most important events, most significant first
- overallAssessment gives the ${label}ly verdict
- state explicitly how this ${label} DIFFERS from the previous one` +
      (kind === "monthly"
        ? `\n- mediumTermImpact should read as a forward outlook for next month`
        : ""),
    );

    const reply = await this.llm.chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: parts.join("\n") },
      ],
      { timeoutMs: TIMEOUT_MS },
    );
    if (!reply) {
      this.logger.warn(`${kind}: no reply for ${ticker} ${period.start}`);
      return null;
    }
    const body = coerceBody(extractJson(reply));
    if (!body) {
      this.logger.warn(`${kind}: unparseable reply for ${ticker} ${period.start}`);
      return null;
    }

    const doc: TickerPeriodAnalysisDoc = {
      ...body,
      ticker,
      companyName: opts.companyName ?? opts.current?.companyName ?? null,
      periodStart: period.start,
      periodEnd: period.end,
      sourceNewsIds: trimmed.map((n) => n.id),
      sourceNewsCount: news.length,
      generatedAt: new Date().toISOString(),
      analysisVersion: ANALYSIS_VERSION,
      changeVsPrevious: body.investorInterpretation,
      ...(kind === "monthly"
        ? {
            sourceWeeklyIds: (opts.weeklies ?? []).map(
              (w) => `${w.ticker}_${w.periodStart}`,
            ),
            forwardOutlook: body.mediumTermImpact,
          }
        : {}),
    };
    // Keyed by period, so a retry corrects this period only.
    await this.col(kind).doc(`${ticker}_${period.start}`).set(doc);
    return doc;
  }
}
