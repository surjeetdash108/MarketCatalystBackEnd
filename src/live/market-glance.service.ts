import { Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { LlmGatewayService } from "../vendors/llm-gateway.service";
import type { ChatMessage } from "../vendors/openrouter/openrouter.service";
import { extractJson } from "./ticker-ai-analysis.service";
import {
  TICKER_AI_COLLECTION,
  type TickerAiAnalysisDoc,
} from "./ticker-ai-analysis.types";

/**
 * "Week at a glance" / "Month at a glance" — one market-wide digest PER
 * CALENDAR PERIOD, summarised by the LLM from the per-ticker analyses already
 * in `ticker_ai_analysis` (both `general` and `announcement` rows; the input
 * gatherer — loadPeriodAnalyses — is the one place to extend when other
 * sources are folded in later).
 *
 * APPEND-ONLY HISTORY, so the tab is an expandable list and users can open old
 * periods. One doc per period keyed by its start:
 *   market_weekly_glance/2026-08-18   (ISO week, Monday-based, UTC)
 *   market_monthly_glance/2026-08     (calendar month, UTC)
 * A completed period is never overwritten once finalised.
 *
 * ON-DEMAND, then everyone reads the cache. Generation is SYNCHRONOUS inside the
 * request — the public `/live/*` service is scale-to-zero with CPU throttling,
 * so fire-and-forget work after the response isn't guaranteed CPU; doing it in
 * the request keeps CPU allocated and matches the on-demand ticker-AI pattern.
 * It stays under the 60s Firebase-Hosting-rewrite limit via a tight per-provider
 * LLM budget and AT MOST ONE generation per request. On a request:
 *  - the CURRENT period is (re)generated if missing or older than its cutoff;
 *  - otherwise, the PREVIOUS period is finalised once if it was last built
 *    before it closed (so a week viewed mid-week ends up covering all of it).
 * Concurrent viewers share one in-flight generation; the first viewer of a stale
 * period waits for it, everyone after reads the cache.
 *
 * Cutoffs (how stale the CURRENT period may get): weekly 12h, monthly 24h.
 */

type Period = "weekly" | "monthly";

interface Bounds {
  /** Firestore doc id — the period key. */
  key: string;
  start: string;
  end: string;
}

const COLLECTION: Record<Period, string> = {
  weekly: "market_weekly_glance",
  monthly: "market_monthly_glance",
};
const TTL_MS: Record<Period, number> = {
  weekly: 12 * 60 * 60 * 1000,
  monthly: 24 * 60 * 60 * 1000,
};
const HISTORY_LIMIT: Record<Period, number> = {
  weekly: 26,
  monthly: 12,
};

/** Cap the model input — a market digest needs a representative set, not every row. */
const MAX_ANALYSES = 200;
/** Budget PER PROVIDER. The gateway tries at most two (Groq → OpenRouter), so
 *  keep this well under 30s to stay inside the 60s Hosting-rewrite limit even
 *  when the first provider times out and the fallback runs. */
const GEN_TIMEOUT_MS = 22_000;
/** After a transient generation failure, don't retry this period for a while,
 *  so an outage doesn't make every viewer pay the full (failing) budget. */
const FAILURE_COOLDOWN_MS = 3 * 60 * 1000;
const SUMMARY_CHARS = 240;

export type GlanceSentiment = "bullish" | "bearish" | "neutral" | "mixed";

/** The digest the model fills in — the human-facing content of one period. */
export interface GlanceDigest {
  marketTone: string;
  sentiment: GlanceSentiment;
  keyThemes: string[];
  biggestEarnings: string[];
  notableMovers: string[];
  summary: string;
}

export interface GlanceDoc extends GlanceDigest {
  period: Period;
  /** Period key (doc id) — YYYY-MM-DD (weekly) or YYYY-MM (monthly). */
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  /** How many ticker analyses fed this digest. 0 → "no activity" copy. */
  sourceCount: number;
  /** "" when produced without a model (no data). */
  model: string;
}

/** What the endpoint returns — the period history, newest first. */
export interface GlanceResponse {
  /** Kept for shape stability; generation is synchronous so this is always false. */
  generating: boolean;
  items: GlanceDoc[];
}

const EMPTY_DIGEST: GlanceDigest = {
  marketTone: "",
  sentiment: "neutral",
  keyThemes: [],
  biggestEarnings: [],
  notableMovers: [],
  summary: "",
};

// ── Calendar-period math (UTC, deterministic) ───────────────────────────────
function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function weekBounds(instant: Date): Bounds {
  const start = utcMidnight(instant);
  const back = (start.getUTCDay() + 6) % 7; // days since Monday (Mon=0)
  start.setUTCDate(start.getUTCDate() - back);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { key: start.toISOString().slice(0, 10), start: start.toISOString(), end: end.toISOString() };
}
function monthBounds(instant: Date): Bounds {
  const start = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), 1));
  const end = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth() + 1, 1));
  return { key: start.toISOString().slice(0, 7), start: start.toISOString(), end: end.toISOString() };
}
function boundsFor(period: Period, instant: Date): Bounds {
  return period === "weekly" ? weekBounds(instant) : monthBounds(instant);
}
function prevBounds(period: Period, instant: Date): Bounds {
  const cur = boundsFor(period, instant);
  const justBefore = new Date(Date.parse(cur.start) - 1); // 1ms before this period
  return boundsFor(period, justBefore);
}

@Injectable()
export class MarketGlanceService {
  private readonly logger = new Logger(MarketGlanceService.name);
  /** Shared in-flight generations keyed by `${period}:${periodKey}`, so
   *  concurrent viewers of the same stale period trigger ONE model call. */
  private readonly inFlight = new Map<string, Promise<GlanceDoc | null>>();
  /** When a period last failed to generate — gates retries (FAILURE_COOLDOWN_MS). */
  private readonly failedAt = new Map<string, number>();

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly llm: LlmGatewayService,
  ) {}

  getWeekly(): Promise<GlanceResponse> {
    return this.serve("weekly");
  }
  getMonthly(): Promise<GlanceResponse> {
    return this.serve("monthly");
  }

  private col(period: Period) {
    return this.firebase.firestore.collection(COLLECTION[period]);
  }

  /** Serve the period history; synchronously (re)build the current period if it
   *  is stale, else finalise the previous one — at most one generation. */
  private async serve(period: Period): Promise<GlanceResponse> {
    const now = Date.now();
    let items = await this.listRecent(period);

    const cur = boundsFor(period, new Date());
    const curDoc = items.find((d) => d.periodKey === cur.key) ?? null;
    const curFresh =
      !!curDoc &&
      Number.isFinite(Date.parse(curDoc.generatedAt)) &&
      now - Date.parse(curDoc.generatedAt) < TTL_MS[period];

    if (!curFresh && this.canAttempt(period, cur.key, now)) {
      const built = await this.rebuildOnce(period, cur);
      if (built) items = this.mergeItem(period, items, built);
    } else if (curFresh) {
      // Finalise the previous period once if it was last built before it closed.
      const prev = prevBounds(period, new Date());
      const prevDoc = items.find((d) => d.periodKey === prev.key);
      if (
        prevDoc &&
        Date.parse(prevDoc.generatedAt) < Date.parse(prev.end) &&
        this.canAttempt(period, prev.key, now)
      ) {
        const built = await this.rebuildOnce(period, prev);
        if (built) items = this.mergeItem(period, items, built);
      }
    }

    return { generating: false, items };
  }

  private canAttempt(period: Period, key: string, now: number): boolean {
    const f = this.failedAt.get(`${period}:${key}`);
    return !(f !== undefined && now - f < FAILURE_COOLDOWN_MS);
  }

  /** Replace-or-insert a freshly built doc, keeping the list sorted + capped. */
  private mergeItem(period: Period, items: GlanceDoc[], doc: GlanceDoc): GlanceDoc[] {
    return [...items.filter((d) => d.periodKey !== doc.periodKey), doc]
      .sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1))
      .slice(0, HISTORY_LIMIT[period]);
  }

  private async listRecent(period: Period): Promise<GlanceDoc[]> {
    try {
      const snap = await this.col(period)
        .orderBy("periodStart", "desc")
        .limit(HISTORY_LIMIT[period])
        .get();
      return snap.docs.map((d) => d.data() as GlanceDoc);
    } catch (err) {
      this.logger.warn(`${period}: list failed: ${(err as Error).message}`);
      return [];
    }
  }

  /** Coalesce concurrent builds of the same period onto one promise. */
  private rebuildOnce(period: Period, bounds: Bounds): Promise<GlanceDoc | null> {
    const lock = `${period}:${bounds.key}`;
    const existing = this.inFlight.get(lock);
    if (existing) return existing;
    const p = this.rebuild(period, bounds)
      .catch((err) => {
        this.logger.warn(`${lock}: rebuild failed: ${(err as Error).message}`);
        this.failedAt.set(lock, Date.now());
        return null;
      })
      .finally(() => this.inFlight.delete(lock));
    this.inFlight.set(lock, p);
    return p;
  }

  /** Build + persist one period's digest. Returns the stored doc, or null when
   *  nothing was persisted (transient model failure → retried after cooldown). */
  private async rebuild(period: Period, bounds: Bounds): Promise<GlanceDoc | null> {
    const lock = `${period}:${bounds.key}`;
    const analyses = await this.loadPeriodAnalyses(bounds.start, bounds.end);

    let digest = EMPTY_DIGEST;
    let model = "";

    if (analyses.length === 0) {
      // Legitimate empty period — cache it so we don't re-scan every view.
      digest = { ...EMPTY_DIGEST, summary: "No ticker analyses were recorded in this period." };
    } else if (!this.llm.enabled) {
      this.failedAt.set(lock, Date.now());
      return null;
    } else {
      const produced = await this.summarise(period, analyses);
      if (produced) {
        digest = produced;
        model = this.llm.primaryName;
      } else {
        this.failedAt.set(lock, Date.now());
        return null;
      }
    }

    const out: GlanceDoc = {
      ...digest,
      period,
      periodKey: bounds.key,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      generatedAt: new Date().toISOString(),
      sourceCount: analyses.length,
      model,
    };
    await this.col(period).doc(bounds.key).set(out);
    this.failedAt.delete(lock);
    this.logger.log(
      `${period} glance ${bounds.key} rebuilt from ${analyses.length} analyses (model=${model || "none"})`,
    );
    return out;
  }

  /**
   * The period's per-ticker analyses — the digest's raw material. Both
   * `general` and `announcement` rows within [start, end), newest first, capped.
   * Extend HERE when other sources join the summary.
   *
   * Two inequalities on the single field `lastUpdatedAt` need no composite index.
   */
  private async loadPeriodAnalyses(startIso: string, endIso: string): Promise<TickerAiAnalysisDoc[]> {
    try {
      const snap = await this.firebase.firestore
        .collection(TICKER_AI_COLLECTION)
        .where("lastUpdatedAt", ">=", startIso)
        .where("lastUpdatedAt", "<", endIso)
        .orderBy("lastUpdatedAt", "desc")
        .limit(MAX_ANALYSES)
        .get();
      return snap.docs.map((d) => d.data() as TickerAiAnalysisDoc);
    } catch (err) {
      this.logger.warn(`loadPeriodAnalyses failed: ${(err as Error).message}`);
      return [];
    }
  }

  private async summarise(
    period: Period,
    analyses: TickerAiAnalysisDoc[],
  ): Promise<GlanceDigest | null> {
    const lines = analyses.map((a) => this.compactLine(a)).join("\n");
    const label = period === "weekly" ? "week" : "month";
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Here are the per-ticker AI analyses recorded during this ${label} ` +
          `(${analyses.length} rows, newest first). Produce ONE market-wide ` +
          `"at a glance" digest as described.\n\n${lines}`,
      },
    ];
    const reply = await this.llm.chat(messages, { timeoutMs: GEN_TIMEOUT_MS });
    if (!reply?.trim()) return null;
    return this.coerceDigest(extractJson(reply));
  }

  /** One dense line per analysis — enough signal for a market digest, small
   *  enough to fit hundreds in a single prompt. */
  private compactLine(a: TickerAiAnalysisDoc): string {
    const name = a.companyName ? ` (${a.companyName})` : "";
    let tag = a.analysisType as string;
    if (a.analysisType === "announcement" && a.announcement) {
      const s = a.announcement.surprisePct;
      tag = `earnings ${a.announcement.verdict}${s != null ? ` ${s > 0 ? "+" : ""}${s}%` : ""}`;
    }
    const text = (a.summary || a.overallAssessment || "").replace(/\s+/g, " ").trim().slice(0, SUMMARY_CHARS);
    return `${a.ticker}${name} [${tag}; ${a.sentiment}] ${text}`;
  }

  private coerceDigest(raw: unknown): GlanceDigest | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
    const list = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean).slice(0, 8) : [];
    const sentiments: GlanceSentiment[] = ["bullish", "bearish", "neutral", "mixed"];
    const s = str(r.sentiment).toLowerCase() as GlanceSentiment;
    return {
      marketTone: str(r.marketTone),
      sentiment: sentiments.includes(s) ? s : "neutral",
      keyThemes: list(r.keyThemes),
      biggestEarnings: list(r.biggestEarnings),
      notableMovers: list(r.notableMovers),
      summary: str(r.summary),
    };
  }
}

const SYSTEM_PROMPT = `You are a market strategist writing a concise, market-wide "at a glance" digest for a stock-intelligence terminal.

You are given a set of per-ticker AI analyses recorded over a period (one dense line each: TICKER (Name) [type; sentiment] summary). Synthesise them into ONE overview of the whole market for the period. Base EVERYTHING strictly on the supplied analyses — do not invent tickers, numbers, or events, and do not give investment advice.

Return ONLY a JSON object, no prose or code fences, with exactly these keys:
{
  "marketTone": "one sentence capturing the overall tone of the period",
  "sentiment": "one of: bullish, bearish, neutral, mixed",
  "keyThemes": ["3-6 short bullets — the dominant themes/sectors/catalysts across tickers"],
  "biggestEarnings": ["short bullets for the most notable earnings results in the set; empty array if none"],
  "notableMovers": ["short bullets naming tickers with the most notable moves or catalysts"],
  "summary": "a 2-4 sentence narrative tying the period together"
}

Keep each bullet under ~18 words. Reference real tickers from the input where relevant.`;
