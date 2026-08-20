import { Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  OpenRouterService,
  type ChatMessage,
} from "../vendors/openrouter/openrouter.service";
import { OnDemandService } from "./ondemand.service";

/**
 * AI analysis, on-demand + cached, mirroring the OnDemandService cache-aside
 * design (getTranscript is the closest analog): 5-min in-memory hot cache →
 * Firestore doc with a createdAt TTL → inflight promise dedup → build+write.
 * A "no result"/error doc is cached briefly too so a failed/slow LLM call isn't
 * re-run on every request.
 *
 * The read SYNTHESISES the technical indicators AND the news together — both are
 * passed to the model — rather than summarising news alone. When Polygon+FMP
 * have no news for the ticker, OpenRouter's :online web-search fills the gap.
 *
 * Generic by design: `generate(kind, ...)` is the single entry point that later
 * phases (movers / portfolio / watchlist / dashboard / recap) extend with new
 * kinds, each reusing this same cache-aside skeleton + prompt scaffolding.
 */

const AI_TTL_MS = 30 * 60_000; // regenerate an analysis older than 30 min
// Short, because free models fail transiently (upstream rate limits) far more
// often than permanently — a long error TTL would strand a ticker on
// "unavailable" well after the provider recovered.
const AI_ERR_TTL_MS = 2 * 60_000; // re-try a failed/no-result analysis after 2 min

export type AiKind = "stock_technical";

const SYSTEM_PROMPT = `You are a concise equity technical analyst for a retail markets app.
You are given a ticker's technical-indicator snapshot AND its recent news. COMBINE both to form your read — do not rely on news alone.
Rules:
- Informational only. NEVER give buy/sell/hold advice or price targets.
- Ground every claim in the provided numbers/news. Never invent figures or events.
- If the technicals and the news point in different directions, say so explicitly.
- Keep it tight and factual. No hype.
- Respond with ONLY a valid JSON object (no markdown, no prose), matching EXACTLY this shape:
{
  "headline": "one-line takeaway, <= 12 words",
  "volatility": { "flag": "elevated" | "normal" | "low", "note": "one sentence citing RSI / beta / realized-vol / relative-volume when given" },
  "momentum": { "state": "up" | "down" | "bear-market", "note": "one sentence citing trend / moving-average posture / RS rank" },
  "newsSummary": "1-2 sentences on the news catalysts; say 'No notable recent news.' if there is none",
  "technicalSummary": "2-3 sentences on support/resistance, chart patterns, consolidation, and any accumulation/distribution signals — reconciled with the news"
}`;

/**
 * Every balanced {...} substring in the text, outermost-first, in document
 * order. Brace counting is string- and escape-aware so a `{` inside a quoted
 * value can't throw the depth off.
 */
function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        out.push(text.slice(start, i + 1));
        start = -1;
      } else if (depth < 0) {
        depth = 0; // stray closer — resync
      }
    }
  }
  return out;
}

/**
 * Defensive JSON extraction — free models wrap JSON in prose or code fences,
 * and reasoning models emit a whole thinking trace around it (the trace itself
 * often quotes fragments of the schema, so "first { to last }" grabs garbage).
 * Strategy: try a straight parse, then fenced blocks, then every balanced
 * object — preferring the LAST one that actually carries our schema, since the
 * real answer comes after the thinking. Returns null when nothing parses.
 */
function safeParseJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const attempts: string[] = [trimmed];
  for (const m of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    attempts.push(m[1].trim());
  }
  // Later objects first: the answer trails the reasoning.
  attempts.push(...balancedObjects(trimmed).reverse());

  const parsedAll: Record<string, unknown>[] = [];
  for (const a of attempts) {
    try {
      const parsed = JSON.parse(a);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        // A candidate carrying the schema wins outright.
        if ("headline" in obj || "analysis" in obj) return obj;
        parsedAll.push(obj);
      }
    } catch {
      /* try next */
    }
  }
  return parsedAll[0] ?? null;
}

@Injectable()
export class AiAnalysisService {
  private readonly logger = new Logger(AiAnalysisService.name);
  private readonly mem = new Map<string, { data: Record<string, unknown>; at: number }>();
  private readonly inflight = new Map<string, Promise<Record<string, unknown>>>();

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly ai: OpenRouterService,
    private readonly ondemand: OnDemandService,
  ) {}

  /**
   * Generic entry point. Phase 1 implements only `stock_technical`; later phases
   * add branches that reuse the same cache-aside + prompt scaffolding.
   */
  async generate(
    kind: AiKind,
    subjectTickers: string[],
  ): Promise<Record<string, unknown>> {
    if (kind === "stock_technical") {
      return this.getStockTechnical(subjectTickers[0]);
    }
    throw new Error(`AI kind not implemented: ${kind}`);
  }

  /** On-demand, 30-min-cached AI read for one ticker (technicals + news). */
  async getStockTechnical(ticker: string): Promise<Record<string, unknown>> {
    const sym = ticker.toUpperCase();

    const mem = this.mem.get(sym);
    if (mem && Date.now() - mem.at < 5 * 60_000) return mem.data;

    const ref = this.firebase.firestore
      .collection("ai_technical_analysis")
      .doc(sym);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      const created =
        typeof data.createdAt === "string" ? Date.parse(data.createdAt) : NaN;
      // A failed/no-result doc (ok:false) re-tries sooner than a good one.
      const ttl = data.ok === false ? AI_ERR_TTL_MS : AI_TTL_MS;
      if (Number.isFinite(created) && Date.now() - created < ttl) {
        this.mem.set(sym, { data, at: Date.now() });
        return data;
      }
    }

    const key = `ai_${sym}`;
    const existing = this.inflight.get(key) as
      | Promise<Record<string, unknown>>
      | undefined;
    if (existing) return existing;

    const p = (async () => {
      const doc = await this.buildStockTechnical(sym);
      await ref.set(doc);
      this.mem.set(sym, { data: doc, at: Date.now() });
      return doc;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  private async buildStockTechnical(
    sym: string,
  ): Promise<Record<string, unknown>> {
    const now = new Date().toISOString();

    // Technicals (from the company doc) + first-party news, in parallel. Both
    // are best-effort — a failure degrades to null/[] rather than dropping the
    // whole analysis.
    const [company, news] = await Promise.all([
      this.ondemand.getCompany(sym).catch(() => null),
      this.ondemand.getNews(sym).catch(() => [] as Record<string, unknown>[]),
    ]);
    const useWeb = news.length === 0; // no first-party news → :online web search

    const userMsg = this.buildContext(sym, company, news);
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMsg },
    ];

    const raw = await this.ai.chat(messages, { web: useWeb });
    const parsed = raw ? safeParseJson(raw) : null;

    if (!parsed) {
      // Distinguish "no completion at all" (already logged by the vendor) from
      // "the model replied but not with JSON" — the latter needs a prompt or
      // model change, so keep a short preview of what it actually said.
      if (raw) {
        this.logger.warn(
          `AI read for ${sym}: model replied but no JSON could be parsed (${this.ai.modelName}). First 200 chars: ${raw.slice(0, 200).replace(/\s+/g, " ")}`,
        );
      }
      return {
        ticker: sym,
        ok: false,
        model: this.ai.modelName,
        usedWebSearch: useWeb,
        newsCount: news.length,
        sourcesUsed: [],
        analysis: null,
        error: this.ai.enabled ? "generation-failed" : "ai-disabled",
        createdAt: now,
        updatedAt: now,
      };
    }

    const a = (parsed.analysis ?? parsed) as Record<string, unknown>;
    return {
      ticker: sym,
      ok: true,
      model: this.ai.modelName,
      usedWebSearch: useWeb,
      newsCount: news.length,
      sourcesUsed: useWeb ? ["openrouter-web"] : ["polygon", "fmp"],
      analysis: {
        headline: a.headline ?? null,
        volatility: a.volatility ?? null,
        momentum: a.momentum ?? null,
        newsSummary: a.newsSummary ?? null,
        technicalSummary: a.technicalSummary ?? null,
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Assemble the user message: the full technical snapshot + recent headlines. */
  private buildContext(
    sym: string,
    company: Record<string, unknown> | null,
    news: Record<string, unknown>[],
  ): string {
    const c = company ?? {};
    const pick = (k: string) => (c[k] ?? null) as unknown;
    // The full indicator set the company doc carries (technical-indicators.job /
    // rs-rating.job). Any missing field is null — the model is told to ignore
    // nulls. This is the "technical analysis" half of the synthesis.
    const technicals = {
      price: pick("price"),
      pctChange: pick("pctChange"),
      week52High: pick("week52High") ?? pick("high52"),
      week52Low: pick("week52Low") ?? pick("low52"),
      rsRating: pick("rsRating"),
      techTrend: pick("techTrend"),
      techMomentum: pick("techMomentum"),
      rsi14: pick("rsi14"),
      macd: pick("macd"),
      macdSignal: pick("macdSignal"),
      sma50: pick("sma50"),
      sma200: pick("sma200"),
      aboveSma50: pick("aboveSma50"),
      aboveSma200: pick("aboveSma200"),
      ema50: pick("ema50"),
      stochK: pick("stochK"),
      adx14: pick("adx14"),
      beta: pick("beta"),
      relativeVolume: pick("rvol"),
      realizedVol30: pick("realizedVol30"),
      week5ChangePct: pick("week5ChangePct"),
      keyLevels: pick("keyLevels"),
      sector: pick("sector"),
      industry: pick("industry"),
      nextEarnings: pick("nextEarningsDate") ?? pick("earningsDate"),
    };

    const headlines =
      news.length > 0
        ? news
            .slice(0, 5)
            .map((n) => {
              const date = String(n.publishedAt ?? "").slice(0, 10);
              const sent = n.sentiment ? `, ${String(n.sentiment)}` : "";
              return `- ${String(n.headline ?? "")} (${String(n.source ?? "?")}, ${date}${sent})`;
            })
            .join("\n")
        : "(no first-party news available — use recent web results)";

    return [
      `Ticker: ${sym}`,
      `Technical snapshot (JSON, ignore null fields): ${JSON.stringify(technicals)}`,
      `Recent news:`,
      headlines,
    ].join("\n");
  }
}
