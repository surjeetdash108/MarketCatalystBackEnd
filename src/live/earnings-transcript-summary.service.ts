import { Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { LlmGatewayService } from "../vendors/llm-gateway.service";
import { FmpService } from "../vendors/fmp/fmp.service";

export interface TranscriptInsight {
  category: string;
  headline: string;
  summary: string;
  speaker: string;
  sentiment: "bullish" | "bearish" | "neutral";
  importance: number;
  evidence: string;
}

export interface TranscriptAiSummaryDoc {
  ticker: string;
  quarter?: number | null;
  year?: number | null;
  period?: string | null;
  date?: string | null;
  insights: TranscriptInsight[];
  model?: string;
  generatedAt: string;
  source: "llm" | "fallback";
}

const COLLECTION_NAME = "earnings_transcript_summaries";
const MEM_CACHE_TTL_MS = 60 * 60_000; // 1 hour in memory
const LLM_TIMEOUT_MS = 35_000;

const SYSTEM_PROMPT = `You are a Senior Equity Research Analyst at a premier investment firm.
Your job is to read the earnings call transcript and synthesize 8 to 12 concise, highly investment-relevant insights.

CRITICAL INSTRUCTIONS:
1. Synthesize information across the transcript rather than simply copying individual sentences.
2. Ground every single claim strictly in the provided transcript. NEVER invent numbers, guidance, sentiment, speakers, or facts.
3. Every insight MUST have supporting direct evidence (an exact quote or key phrase from the transcript).
4. Generate between 8 and 12 distinct, high-signal insights.
5. Use only relevant categories from:
   - "Guidance & Outlook"
   - "Financial Performance"
   - "Revenue/Growth"
   - "Margins"
   - "Demand"
   - "Product/Segment Performance"
   - "Strategy"
   - "Macro/Industry Trends"
   - "Risks"
   - "Opportunities"
   - "Capital Allocation"
6. Rank insights by market importance (importance: 1 is the single highest-impact market mover, followed by 2, 3, etc.).
7. Set sentiment to "bullish", "bearish", or "neutral".

Return ONLY a valid JSON object matching this schema:
{
  "insights": [
    {
      "category": string,
      "headline": string (punchy 4-10 word investment takeaway),
      "summary": string (1-3 sentences synthesizing the operational or financial impact),
      "speaker": string (executive name and title if mentioned, e.g. "Bill Newlands (CEO)"),
      "sentiment": "bullish" | "bearish" | "neutral",
      "importance": number (1 to 12, ordered with 1 being the major impact point),
      "evidence": string (direct supporting quote or phrase from transcript)
    }
  ]
}`;

/**
 * Strips procedural operator boilerplate and repetitive handoffs so the transcript
 * focuses cleanly on executive remarks, strategic commentary, and analyst Q&A.
 */
export function condenseTranscriptForLlm(content: string, maxChars = 18000): string {
  if (!content) return "";
  const paras = content.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const boilerplateRegex =
    /^(welcome to the|my name is|today\x27s call is being recorded|forward-looking statements|safe harbor|at this time|turn the call over|instructions|open the call|replay of this call|press star one|conference operator|thank you for standing by)/i;

  const usefulParas: string[] = [];
  for (const p of paras) {
    if (boilerplateRegex.test(p)) continue;
    if (
      p.length < 50 &&
      /^(thank you|thanks|operator|next question|good afternoon|good morning)/i.test(p)
    )
      continue;
    usefulParas.push(p);
  }

  let result = usefulParas.join("\n\n");
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + "\n\n[Transcript continues...]";
  }
  return result;
}

/**
 * Validates and coerces the LLM's response into a strict array of TranscriptInsight objects.
 */
export function coerceTranscriptInsights(raw: unknown): TranscriptInsight[] {
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  const list = Array.isArray(o.insights) ? o.insights : Array.isArray(raw) ? raw : [];
  const VALID_SENTIMENTS = new Set(["bullish", "bearish", "neutral"]);
  const results: TranscriptInsight[] = [];

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const headline = typeof it.headline === "string" ? it.headline.trim() : "";
    const summary = typeof it.summary === "string" ? it.summary.trim() : "";
    if (!headline && !summary) continue;

    const category =
      typeof it.category === "string" && it.category.trim()
        ? it.category.trim()
        : "Financial Performance";
    const speaker = typeof it.speaker === "string" ? it.speaker.trim() : "";
    const rawSent =
      typeof it.sentiment === "string" ? it.sentiment.toLowerCase().trim() : "neutral";
    const sentiment: "bullish" | "bearish" | "neutral" = VALID_SENTIMENTS.has(rawSent)
      ? (rawSent as "bullish" | "bearish" | "neutral")
      : rawSent.includes("pos") || rawSent.includes("bull")
      ? "bullish"
      : rawSent.includes("neg") || rawSent.includes("bear")
      ? "bearish"
      : "neutral";

    let importance = Number(it.importance);
    if (!Number.isFinite(importance) || importance <= 0) importance = i + 1;
    const evidence = typeof it.evidence === "string" ? it.evidence.trim() : "";

    results.push({
      category,
      headline: headline || summary.slice(0, 60),
      summary,
      speaker,
      sentiment,
      importance,
      evidence,
    });
  }

  results.sort((a, b) => a.importance - b.importance);
  return results.slice(0, 12);
}

/** Extracts the first balanced JSON object from model reply text. */
export function extractJsonFromReply(text: string): unknown {
  const fenced = text.replace(/```(?:json)?/gi, " ");
  const start = fenced.indexOf("{");
  if (start === -1) return null;
  let depth = 0,
    inStr = false,
    esc = false;
  for (let i = start; i < fenced.length; i++) {
    const ch = fenced[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(fenced.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Deterministic rule-based fallback if the LLM is unconfigured, rate-limited,
 * or returns invalid output. Ensures the system always returns structured insights.
 */
export function fallbackTranscriptInsights(content: string, _sym: string): TranscriptInsight[] {
  if (!content || !content.trim()) return [];

  // Protect decimals and abbreviations
  let safe = content.replace(/(\d+)\.(\d+)/g, "$1__DOT__$2");
  safe = safe.replace(/\b(Mr|Mrs|Ms|Dr|Inc|Corp|Ltd|Co|vs|approx|e\.g|i\.e)\./gi, "$1__PERIOD__");
  safe = safe.replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\./gi, "$1__PERIOD__");

  const rawParas = safe.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const cleanSentences: { text: string; speaker: string }[] = [];
  const boilerplateRegex =
    /^(good (afternoon|morning|evening)|thank you|welcome to|my name is|today\x27s call is being recorded|please note that|forward-looking statements|safe harbor|operator|at this time|turn the call over|instructions|open the call|replay of this call|press star one|conference operator)/i;

  for (const para of rawParas) {
    let speaker = "";
    let body = para;
    const colonIdx = para.indexOf(":");
    if (colonIdx > 0 && colonIdx < 50) {
      speaker = para.slice(0, colonIdx).trim();
      body = para.slice(colonIdx + 1).trim();
    }

    const sents = (body.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [body]).map((s) =>
      s.replace(/__DOT__/g, ".").replace(/__PERIOD__/g, ".").replace(/\s+/g, " ").trim(),
    );

    for (const s of sents) {
      if (s.length < 35 || s.length > 360) continue;
      if (boilerplateRegex.test(s)) continue;
      if (/\?$|can you give|could you talk|could you provide color|wondering if you could|my first question/i.test(s))
        continue;
      cleanSentences.push({ text: s, speaker });
    }
  }

  const categoryConfigs = [
    {
      category: "Guidance & Outlook",
      regex: /\b(guidance|outlook|expect|anticipate|project|forecast|target(ed|ing)?)\b.*(\$|\%|\b(quarter|fiscal|year|range|growth)\b)/i,
      priority: 1,
    },
    {
      category: "Financial Performance",
      regex: /\b(revenue|eps|earnings per share|net income)\b.*(\$|\%|\b(billion|million|record|grew|growth|all-time)\b)/i,
      priority: 2,
    },
    {
      category: "Revenue/Growth",
      regex: /\b(segment|data center|cloud|services|beer|wine|spirits|automotive|software|hardware|subscription|sales)\b.*(\$|\%|\b(grew|growth|record|up|accelerat|billion|million)\b)/i,
      priority: 3,
    },
    {
      category: "Margins",
      regex: /\b(gross margin|operating margin|profit margin|operating income|ebitda|basis points|operating leverage)\b/i,
      priority: 4,
    },
    {
      category: "Strategy",
      regex: /\b(strategy|strategic|playbook|initiatives|long-term opportunity|investing in|brand building|commercial capabilities)\b/i,
      priority: 5,
    },
    {
      category: "Product/Segment Performance",
      regex: /\b(modelo|corona|pacifico|data center|cloud|azure|iphone|mac|energy|shipments|depletions)\b/i,
      priority: 6,
    },
    {
      category: "Capital Allocation",
      regex: /\b(capital allocation|operating cash flow|free cash flow|share repurchase|buyback|dividend|marketing spend)\b/i,
      priority: 7,
    },
    {
      category: "Demand",
      regex: /\b(customer demand|traffic|consumer behavior|consumption|adoption|order|market share)\b/i,
      priority: 8,
    },
    {
      category: "Opportunities",
      regex: /\b(opportunity|white-space|expansion|new products|innovation|non-alcohol|accelerat)\b/i,
      priority: 9,
    },
    {
      category: "Macro/Industry Trends",
      regex: /\b(macroeconomic|gas prices|inflation|interest rates|foreign exchange|fx|industry trends)\b/i,
      priority: 10,
    },
    {
      category: "Risks",
      regex: /\b(headwind|risk|challenge|slowdown|volatility|gap|cautious|decline)\b/i,
      priority: 11,
    },
  ];

  const results: TranscriptInsight[] = [];
  const usedTexts = new Set<string>();

  for (const cfg of categoryConfigs) {
    if (results.length >= 10) break;
    const match = cleanSentences.find(
      (s) => cfg.regex.test(s.text) && !usedTexts.has(s.text),
    );
    if (match) {
      usedTexts.add(match.text);
      const isBearish = /headwind|decline|loss|cautious|drop|risk|challenge|slowdown|down/i.test(match.text);
      const isBullish = /record|beat|strong|growth|exceed|up|opportunity|momentum|benefit/i.test(match.text);

      results.push({
        category: cfg.category,
        headline: match.text.slice(0, 60),
        summary: match.text,
        speaker: match.speaker || "Executive Leadership",
        sentiment: isBearish ? "bearish" : isBullish ? "bullish" : "neutral",
        importance: cfg.priority,
        evidence: match.text,
      });
    }
  }

  return results;
}

@Injectable()
export class EarningsTranscriptSummaryService {
  private readonly logger = new Logger(EarningsTranscriptSummaryService.name);
  private readonly memCache = new Map<
    string,
    { doc: TranscriptAiSummaryDoc; at: number }
  >();
  private readonly inflight = new Map<string, Promise<TranscriptAiSummaryDoc | null>>();

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly llm: LlmGatewayService,
    private readonly fmp: FmpService,
  ) {}

  private get col() {
    return this.firebase.firestore.collection(COLLECTION_NAME);
  }

  /**
   * Retrieves or generates an LLM-powered earnings transcript summary for a given ticker.
   * Caches results in Firestore and memory by ticker + year/quarter.
   */
  async getSummary(ticker: string): Promise<TranscriptAiSummaryDoc | null> {
    const sym = ticker.toUpperCase().trim();
    const memKey = `summary_${sym}`;

    // 1. In-memory cache check
    const mem = this.memCache.get(memKey);
    if (mem && Date.now() - mem.at < MEM_CACHE_TTL_MS) {
      return mem.doc;
    }

    // 2. Fetch transcript doc from Firestore or FMP to identify period
    const txSnap = await this.firebase.firestore
      .collection("earnings_transcripts")
      .doc(sym)
      .get();
    let txData = txSnap.exists ? (txSnap.data() as Record<string, unknown>) : null;

    if (!txData || !txData.content) {
      const fmpTx = await this.fmp.getLatestEarningsTranscript(sym).catch(() => null);
      if (fmpTx && fmpTx.content) {
        txData = {
          ticker: sym,
          quarter: fmpTx.quarter,
          year: fmpTx.year,
          date: fmpTx.date,
          content: fmpTx.content,
          hasTranscript: true,
          createdAt: new Date().toISOString(),
        };
      }
    }

    if (!txData || !txData.content) {
      return null;
    }

    const quarter = Number(txData.quarter) || null;
    const year = Number(txData.year) || null;
    const period = quarter ? `Q${quarter} ${year ?? ""}`.trim() : year ? `${year}` : null;
    const date = typeof txData.date === "string" ? txData.date : null;
    const cacheDocId = `${sym}_${year ?? "unknown"}_Q${quarter ?? "unknown"}`;

    // 3. Firestore cache check
    const existingDoc = await this.col.doc(cacheDocId).get();
    if (existingDoc.exists) {
      const doc = existingDoc.data() as TranscriptAiSummaryDoc;
      if (doc && Array.isArray(doc.insights) && doc.insights.length > 0) {
        this.memCache.set(memKey, { doc, at: Date.now() });
        return doc;
      }
    }

    // 4. Inflight coalescing
    const existingTask = this.inflight.get(cacheDocId);
    if (existingTask) return existingTask;

    const task = (async (): Promise<TranscriptAiSummaryDoc | null> => {
      const rawContent = String(txData.content ?? "");
      const condensed = condenseTranscriptForLlm(rawContent);

      let insights: TranscriptInsight[] = [];
      let source: "llm" | "fallback" = "llm";
      let modelUsed = this.llm.primaryName;

      if (this.llm.enabled && condensed.length > 200) {
        try {
          const userPrompt = `Earnings Call Transcript for ${sym}${period ? ` (${period})` : ""}:\n\n${condensed}`;
          const reply = await this.llm.chat(
            [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userPrompt },
            ],
            { timeoutMs: LLM_TIMEOUT_MS },
          );

          if (reply) {
            const parsedJson = extractJsonFromReply(reply);
            insights = coerceTranscriptInsights(parsedJson);
          }
        } catch (err) {
          this.logger.warn(`LLM transcript summary failed for ${sym}: ${(err as Error)?.message ?? err}`);
        }
      }

      // If LLM returned fewer than 4 valid insights, use deterministic fallback
      if (insights.length < 4) {
        this.logger.log(`Using fallback summary extractor for ${sym} (insights: ${insights.length})`);
        insights = fallbackTranscriptInsights(rawContent, sym);
        source = "fallback";
        modelUsed = "deterministic-fallback";
      }

      const summaryDoc: TranscriptAiSummaryDoc = {
        ticker: sym,
        quarter,
        year,
        period,
        date,
        insights,
        model: modelUsed,
        generatedAt: new Date().toISOString(),
        source,
      };

      // Cache in Firestore and memory (only cache valid outputs)
      if (insights.length > 0) {
        await this.col.doc(cacheDocId).set(summaryDoc).catch((err) => {
          this.logger.warn(`Failed to cache transcript summary in Firestore for ${sym}: ${err.message}`);
        });
        this.memCache.set(memKey, { doc: summaryDoc, at: Date.now() });
      }

      return summaryDoc;
    })().finally(() => this.inflight.delete(cacheDocId));

    this.inflight.set(cacheDocId, task);
    return task;
  }
}
