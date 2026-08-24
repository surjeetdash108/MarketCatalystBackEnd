/**
 * Shapes for the ticker AI analysis collections (spec §5, §8, §9).
 *
 * One CURRENT record per ticker in `ticker_ai_analysis`; weekly and monthly
 * records are append-only history, one document per ticker per period, so a
 * re-run overwrites that period rather than losing the ones around it.
 */

export const TICKER_AI_COLLECTION = "ticker_ai_analysis";
export const TICKER_WEEKLY_AI_COLLECTION = "ticker_weekly_ai_analysis";
export const TICKER_MONTHLY_AI_COLLECTION = "ticker_monthly_ai_analysis";

/** Bumped when the prompt or schema changes, so stale rows are identifiable. */
export const ANALYSIS_VERSION = 1;

export type Sentiment = "positive" | "negative" | "neutral" | "mixed";

/** The LLM's structured verdict — the part the model actually fills in. */
export interface AnalysisBody {
  summary: string;
  sentiment: Sentiment;
  /** 0-1. The model's own confidence, used to flag thin reads in the UI. */
  confidence: number;
  keyDevelopments: string[];
  positiveFactors: string[];
  negativeFactors: string[];
  risks: string[];
  opportunities: string[];
  fundamentalImpact: string;
  priceImpact: string;
  shortTermImpact: string;
  mediumTermImpact: string;
  investorInterpretation: string;
  overallAssessment: string;
}

export interface TickerAiAnalysisDoc extends AnalysisBody {
  ticker: string;
  companyName: string | null;
  /** News doc ids this read was built from — the audit trail for §7. */
  sourceNewsIds: string[];
  sourceNewsCount: number;
  analysisGeneratedAt: string;
  lastUpdatedAt: string;
  analysisVersion: number;
  /** How many incremental updates have folded into this record. */
  revision: number;
  /** "created" on the first pass, "updated" once continuity kicks in. */
  lastMode: "created" | "updated";
}

export interface TickerPeriodAnalysisDoc extends AnalysisBody {
  ticker: string;
  companyName: string | null;
  periodStart: string;
  periodEnd: string;
  sourceNewsIds: string[];
  sourceNewsCount: number;
  generatedAt: string;
  analysisVersion: number;
  /** Weekly rolls up news; monthly rolls up the weeklies as well. */
  sourceWeeklyIds?: string[];
  changeVsPrevious: string;
  forwardOutlook?: string;
}

/** Empty body used when the model is unavailable — never fabricated content. */
export const EMPTY_BODY: AnalysisBody = {
  summary: "",
  sentiment: "neutral",
  confidence: 0,
  keyDevelopments: [],
  positiveFactors: [],
  negativeFactors: [],
  risks: [],
  opportunities: [],
  fundamentalImpact: "",
  priceImpact: "",
  shortTermImpact: "",
  mediumTermImpact: "",
  investorInterpretation: "",
  overallAssessment: "",
};
