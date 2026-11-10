/**
 * Shapes for the ticker AI analysis collections (spec §5, §8, §9).
 *
 * One CURRENT record per ticker in `ticker_ai_analysis`; weekly and monthly
 * records are append-only history, one document per ticker per period, so a
 * re-run overwrites that period rather than losing the ones around it.
 */

export const TICKER_AI_COLLECTION = "ticker_ai_analysis";

/**
 * Record id. The collection is APPEND-ONLY — every generation adds a row so
 * the analysis history for a ticker is preserved and the weekly/monthly
 * roll-ups can read the analyses themselves rather than re-reading raw news.
 * Second-resolution timestamp keeps ids sortable and collision-free in
 * practice (one ticker cannot generate twice within a second — the in-flight
 * map in the service prevents it).
 */
export function analysisDocId(
  ticker: string,
  type: string,
  generatedAt: string,
): string {
  return `${ticker}_${type}_${generatedAt.slice(0, 19).replace(/[:.]/g, "")}`;
}
export const TICKER_WEEKLY_AI_COLLECTION = "ticker_weekly_ai_analysis";
export const TICKER_MONTHLY_AI_COLLECTION = "ticker_monthly_ai_analysis";

/** Bumped when the prompt or schema changes, so stale rows are identifiable. */
export const ANALYSIS_VERSION = 1;

export type Sentiment = "positive" | "negative" | "neutral" | "mixed";

/**
 * Two kinds of ticker analysis live in the same collection.
 *
 * "general"      — the rolling read behind the stock-detail AI widget.
 *                  Regenerated on view once GENERAL_TTL_MS has elapsed.
 * "announcement" — a one-off read produced when an earnings result lands
 *                  (beat/miss/in-line). Surfaced in the Live Feed's
 *                  announcements section. Never expires: it describes a
 *                  specific event at a specific time.
 * "13fAnnouncement" — the same idea for a 13-F institutional filing: produced
 *                  once when a ticker's reporting quarter advances, so the
 *                  change in institutional positioning is read and kept
 *                  alongside the earnings reads. Quarterly by nature, so there
 *                  is at most one per ticker per quarter.
 */
export type AnalysisType = "general" | "announcement" | "13fAnnouncement";

/**
 * How long a general analysis stays fresh. A second viewer inside this window
 * reads the stored record instead of paying for another model call; past it,
 * the next view regenerates and APPENDS a new record.
 */
export const GENERAL_TTL_MS = 60 * 60 * 1000;

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
  /** Which flavour this record is — see AnalysisType. */
  analysisType: AnalysisType;
  companyName: string | null;
  /** News doc ids this read was built from — the audit trail for §7. */
  sourceNewsIds: string[];
  sourceNewsCount: number;
  analysisGeneratedAt: string;
  lastUpdatedAt: string;
  analysisVersion: number;
  /** How many incremental updates have folded into this record. */
  revision: number;
  /** Announcement rows only: the reported figures the read was built from,
   *  so the Live Feed can show the numbers beside the interpretation. */
  announcement?: {
    reportDate: string;
    epsActual: number | null;
    epsEstimate: number | null;
    surprisePct: number | null;
    revenueActual: number | null;
    revenueEstimate: number | null;
    verdict: "beat" | "miss" | "in-line" | "unknown";
  };
  /** 13fAnnouncement rows only: the filed position the read was built from, so
   *  the feed can show the numbers beside the interpretation — same contract as
   *  `announcement` above. */
  f13?: {
    /** Reporting period the filings cover, e.g. 2026 Q2. */
    year: number;
    quarter: number;
    investorsHolding: number | null;
    investorsHoldingChange: number | null;
    numberOf13Fshares: number | null;
    numberOf13FsharesChange: number | null;
    /** Share of the float held by 13-F filers. */
    ownershipPercent: number | null;
    totalInvested: number | null;
    putCallRatio: number | null;
    /** Direction of the share-count change — the headline read. */
    verdict: "accumulating" | "distributing" | "flat" | "unknown";
  };
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
