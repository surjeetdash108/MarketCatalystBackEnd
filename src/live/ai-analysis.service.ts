import { createHash } from "node:crypto";
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
 * have no news for the ticker we ask OpenRouter's :online web-search to fill the
 * gap, but that plugin is a PAID add-on: on an account without credits it 402s,
 * so the second attempt always retries WITHOUT web and returns a technicals-only
 * read rather than nothing.
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

export type AiKind = "stock_technical" | "portfolio" | "watchlist";

/** Hard cap on members fed to an aggregate read — keeps the prompt (and the
 *  single LLM call) inside the Hosting 60s budget. Mirrors the 25-ticker cap
 *  the portfolio screen already applies to its live-quote poll. */
const AI_AGG_MAX_MEMBERS = 25;

/** Per-attempt LLM budget for an aggregate — see buildAggregate. */
const AI_AGG_TIMEOUT_MS = 12_000;

const SYSTEM_PROMPT = `You are a concise equity technical analyst for a retail markets app.
You are given a ticker's technical-indicator snapshot AND its recent news. COMBINE both to form your read — do not rely on news alone.
Rules:
- Informational only. NEVER give buy/sell/hold advice or price targets.
- Ground every claim in the provided numbers/news. Never invent figures or events.
- If the technicals and the news point in different directions, say so explicitly.
- Keep it tight and factual. No hype.
- Do NOT think out loud, restate the task, or write any preamble, explanation or
  markdown. Your reply must begin with { and end with } and contain nothing else.
- Respond with ONLY a valid JSON object (no markdown, no prose), matching EXACTLY this shape:
{
  "headline": "one-line takeaway, <= 12 words",
  "volatility": { "flag": "elevated" | "normal" | "low", "note": "one sentence citing RSI / beta / realized-vol / relative-volume when given" },
  "momentum": { "state": "up" | "down" | "bear-market", "note": "one sentence citing trend / moving-average posture / RS rank" },
  "newsSummary": "1-2 sentences on the news catalysts; say 'No notable recent news.' if there is none",
  "technicalSummary": "2-3 sentences on support/resistance, chart patterns, consolidation, and any accumulation/distribution signals — reconciled with the news"
}`;


/**
 * Aggregate (portfolio / watchlist) prompt. Deliberately never sees share
 * counts, cost basis or dollar amounts — only RELATIVE weight and gain/loss
 * percentages — so no real financial position leaves the system for a
 * third-party model to log.
 */
const AGGREGATE_SYSTEM_PROMPT = `You are a concise equity analyst summarising a whole basket of stocks for a retail markets app.
You are given one line per holding: its technicals, and — where one already exists — the AI read previously generated for that stock.
Your job is the CUMULATIVE picture, not a per-stock recap. Look across the basket for what the individual reads cannot show: shared direction, crowding into one sector, divergence between the biggest positions and the rest.
Rules:
- Informational only. NEVER give buy/sell/hold advice or price targets.
- Ground every claim in the provided lines. Never invent figures, holdings or events.
- Weights are percentages of the basket. There are no dollar amounts — never state or estimate any.
- Call out concentration when a few names or one sector dominate the weight.
- Say so explicitly when the leaders and laggards disagree, or when the biggest weight is the weakest name.
- Keep it tight and factual. No hype.
- Do NOT think out loud, restate the task, or write any preamble, explanation or
  markdown. Your reply must begin with { and end with } and contain nothing else.
- Respond with ONLY a valid JSON object (no markdown, no prose), matching EXACTLY this shape:
{
  "headline": "one-line takeaway about the basket as a whole, <= 12 words",
  "posture": { "flag": "risk-on" | "balanced" | "defensive", "note": "one sentence on the basket's overall stance, citing how many names are trending up vs down" },
  "concentration": { "flag": "high" | "moderate" | "low", "note": "one sentence on weight or sector clustering; for a watchlist judge sector clustering since all names carry equal weight" },
  "leaders": "1-2 sentences naming the strongest names and what they share",
  "laggards": "1-2 sentences naming the weakest names and what they share",
  "watchItems": "1-2 sentences on what to watch next: upcoming events, divergences, or names at a technical inflection"
}`;


/** One basket member as stored. `shares`/`costBasis` are portfolio-only and are
 *  used ONLY to derive percentages — they never reach the model themselves. */
interface AggMember {
  ticker: string;
  shares: number;
  costBasis: number | null;
  conviction: string | null;
}

/** Firestore id for a watchlist's cached summary. */
function watchlistDocId(uid: string, listId: string): string {
  return `${uid}__${listId}`;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/**
 * The user message for an aggregate read: one compact line per member.
 *
 * PRIVACY: for a portfolio this emits RELATIVE weight and gain/loss as
 * percentages only. Share counts, cost basis and dollar values are used to
 * compute those percentages and are then discarded — they are never written
 * into the prompt, so no actual position size leaves the system for a
 * third-party model to log or train on.
 *
 * Each line carries the member's technicals AND, when we already have a fresh
 * one, that stock's own AI read — so the aggregate is a synthesis of the
 * individual analyses rather than a from-scratch re-derivation.
 */
function buildAggregateContext(
  kind: "portfolio" | "watchlist",
  members: AggMember[],
  companies: Map<string, Record<string, unknown>>,
  reads: Map<string, Record<string, unknown>>,
): string {
  // Weights come from market value, but only the RATIO survives into the text.
  const values = members.map((m) => {
    const price = num(companies.get(m.ticker)?.price) ?? 0;
    return kind === "portfolio" ? price * m.shares : 0;
  });
  const total = values.reduce((a, b) => a + b, 0);

  const lines = members.map((m, i) => {
    const c = companies.get(m.ticker) ?? {};
    const bits: string[] = [m.ticker];

    if (kind === "portfolio") {
      if (total > 0 && values[i] > 0) {
        bits.push(`weight ${((values[i] / total) * 100).toFixed(1)}%`);
      }
      const price = num(c.price);
      if (m.costBasis && m.costBasis > 0 && price) {
        bits.push(`position ${pct(((price - m.costBasis) / m.costBasis) * 100)}`);
      }
      if (m.conviction) bits.push(`conviction ${m.conviction}`);
    }

    const chg = num(c.pctChange);
    if (chg !== null) bits.push(`today ${pct(chg)}`);
    const rs = num(c.rsRating);
    if (rs !== null) bits.push(`RS ${rs}/99`);
    if (c.sector) bits.push(`sector ${String(c.sector)}`);
    if (c.techTrend) bits.push(`trend ${String(c.techTrend)}`);
    const rsi = num(c.rsi14);
    if (rsi !== null) bits.push(`RSI ${rsi.toFixed(0)}`);
    if (typeof c.aboveSma200 === "boolean") {
      bits.push(c.aboveSma200 ? "above 200d" : "below 200d");
    }

    // The stock's own AI read, when we already have a fresh one.
    const r = reads.get(m.ticker);
    if (r) {
      const head = r.headline ? String(r.headline) : null;
      const mom = (r.momentum as Record<string, unknown> | null)?.state;
      if (head) bits.push(`AI read: "${head}"`);
      if (mom) bits.push(`AI momentum ${String(mom)}`);
    }

    return `- ${bits.join(" · ")}`;
  });

  const header =
    kind === "portfolio"
      ? `Portfolio of ${members.length} holdings (weights are % of the basket; there are no dollar amounts):`
      : `Watchlist of ${members.length} tickers (equally weighted — judge clustering by sector, not size):`;

  return [header, ...lines].join("\n");
}

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
    subjects: string[],
  ): Promise<Record<string, unknown>> {
    if (kind === "stock_technical") return this.getStockTechnical(subjects[0]);
    // Aggregates are user-scoped: subjects[0] is the verified uid, never a
    // client-supplied one (the controller passes @CurrentUser).
    if (kind === "portfolio") return this.getPortfolioSummary(subjects[0]);
    if (kind === "watchlist")
      return this.getWatchlistSummary(subjects[0], subjects[1]);
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

    const { parsed, raw, usedModel, usedWeb } = await this.callWithFallback(
      sym,
      messages,
      useWeb,
    );

    if (!parsed) {
      // Distinguish "no completion at all" (already logged by the vendor) from
      // "the model replied but not with JSON" — the latter needs a prompt or
      // model change, so keep a short preview of what it actually said.
      if (raw) {
        this.logger.warn(
          `AI read for ${sym}: model replied but no JSON could be parsed (tried ${usedModel} + ${this.ai.fallbackModelName}). First 200 chars: ${raw.slice(0, 200).replace(/\s+/g, " ")}`,
        );
      }
      return {
        ticker: sym,
        ok: false,
        model: usedModel,
        usedWebSearch: usedWeb,
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
      model: usedModel,
      usedWebSearch: usedWeb,
      newsCount: news.length,
      sourcesUsed: usedWeb
        ? ["openrouter-web"]
        : news.length > 0
          ? ["polygon", "fmp"]
          : [],
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

  /**
   * One LLM read with a second chance. At most TWO attempts, to stay inside
   * Hosting's 60s ceiling:
   *   1. primary model — with :online web search only when the caller asks
   *   2. fallback model — NEVER web search
   *
   * Two independent reasons for the second attempt:
   *   * free models are individually unreliable (one may emit only a reasoning
   *     trace and never produce the object; another may be rate-limited),
   *   * :online is a PAID OpenRouter add-on and returns 402 on an account with
   *     no credits — so a web-search attempt can NEVER succeed until credits
   *     are bought. Retrying without it beats returning nothing.
   */
  private async callWithFallback(
    label: string,
    messages: ChatMessage[],
    wantWeb: boolean,
    timeoutMs?: number,
  ): Promise<{
    parsed: Record<string, unknown> | null;
    raw: string | null;
    usedModel: string;
    usedWeb: boolean;
  }> {
    const attempts: Array<{ model: string; web: boolean }> = [
      { model: this.ai.modelName, web: wantWeb },
    ];
    const fb = this.ai.fallbackModelName;
    if (fb && fb !== this.ai.modelName) attempts.push({ model: fb, web: false });
    else if (wantWeb) attempts.push({ model: this.ai.modelName, web: false });

    let usedModel = this.ai.modelName;
    let usedWeb = wantWeb;
    let raw: string | null = null;

    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      if (i > 0) {
        this.logger.warn(
          `AI read for ${label}: attempt ${i} produced no JSON — retrying on ${a.model}${a.web ? " (web)" : " (no web)"}`,
        );
      }
      const r = await this.ai.chat(messages, { web: a.web, model: a.model, timeoutMs });
      if (r) raw = r;
      const pj = r ? safeParseJson(r) : null;
      if (pj) return { parsed: pj, raw, usedModel: a.model, usedWeb: a.web };
      if (!this.ai.enabled) break; // no key — retrying can't help
    }
    return { parsed: null, raw, usedModel, usedWeb };
  }

  /**
   * Fingerprint of what the basket CONTAINS. Stored on the doc so changing the
   * basket invalidates the cached read immediately, rather than leaving a
   * summary that describes holdings the user just removed until the 30-min TTL
   * happens to lapse.
   */
  private compositionHash(parts: string[]): string {
    return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
  }

  /** Batch-read the companies docs for a basket in ONE round trip. */
  private async companiesFor(
    tickers: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    if (tickers.length === 0) return out;
    const refs = tickers.map((t) =>
      this.firebase.firestore.collection("companies").doc(t),
    );
    const snaps = await this.firebase.firestore.getAll(...refs);
    for (const snap of snaps) {
      if (snap.exists) out.set(snap.id, snap.data() as Record<string, unknown>);
    }
    return out;
  }

  /**
   * The per-stock AI reads we ALREADY have, for the baskets's members. Only
   * fresh, successful ones are reused — a stale or failed read would put an
   * out-of-date claim into the aggregate. Missing ones are simply absent; the
   * digest still carries that member's technicals.
   */
  private async cachedStockReads(
    tickers: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    if (tickers.length === 0) return out;
    const refs = tickers.map((t) =>
      this.firebase.firestore.collection("ai_technical_analysis").doc(t),
    );
    const snaps = await this.firebase.firestore.getAll(...refs);
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const d = snap.data() as Record<string, unknown>;
      const created =
        typeof d.createdAt === "string" ? Date.parse(d.createdAt) : NaN;
      if (d.ok !== true || !d.analysis) continue;
      if (!Number.isFinite(created) || Date.now() - created >= AI_TTL_MS) continue;
      out.set(snap.id, d.analysis as Record<string, unknown>);
    }
    return out;
  }

  /**
   * Cumulative AI read for the user's portfolio. Per-user doc, keyed by uid.
   * The basket's composition hash rides on the doc so adding/removing a holding
   * invalidates immediately; otherwise the usual 30-min TTL applies.
   */
  async getPortfolioSummary(uid: string): Promise<Record<string, unknown>> {
    const snap = await this.firebase.firestore
      .collection(`users/${uid}/portfolios/default/holdings`)
      .get();

    const rows = snap.docs
      .map((d) => {
        const h = d.data() as Record<string, unknown>;
        return {
          ticker: String(h.ticker ?? d.id).toUpperCase(),
          shares: Number(h.shares) || 0,
          costBasis:
            typeof h.costBasis === "number" && Number.isFinite(h.costBasis)
              ? h.costBasis
              : null,
          conviction: (h.conviction as string | undefined) ?? null,
        };
      })
      .filter((h) => h.ticker);

    return this.aggregate({
      kind: "portfolio",
      collection: "ai_portfolio_analysis",
      docId: uid,
      label: `portfolio:${uid.slice(0, 6)}`,
      members: rows,
    });
  }

  /**
   * Cumulative AI read for ONE watchlist (the list the user is looking at).
   * Doc id embeds the list id so each list caches separately — and so
   * `deleteWatchlistSummary` can drop exactly the right doc when a list goes.
   */
  async getWatchlistSummary(
    uid: string,
    listId: string,
  ): Promise<Record<string, unknown>> {
    const doc = await this.firebase.firestore
      .doc(`users/${uid}/watchlists/${listId}`)
      .get();
    const tickers = Array.isArray(doc.data()?.tickers)
      ? (doc.data()!.tickers as unknown[])
          .map((t) => String(t).toUpperCase().trim())
          .filter(Boolean)
      : [];

    return this.aggregate({
      kind: "watchlist",
      collection: "ai_watchlist_analysis",
      docId: watchlistDocId(uid, listId),
      label: `watchlist:${listId}`,
      members: tickers.map((ticker) => ({
        ticker,
        shares: 0,
        costBasis: null,
        conviction: null,
      })),
    });
  }

  /**
   * Drop a watchlist's cached summary. Called when the list itself is deleted —
   * without this the doc would linger in `ai_watchlist_analysis` forever, since
   * nothing else ever revisits that id.
   */
  async deleteWatchlistSummary(uid: string, listId: string): Promise<void> {
    const id = watchlistDocId(uid, listId);
    this.mem.delete(`agg_${id}`);
    await this.firebase.firestore
      .collection("ai_watchlist_analysis")
      .doc(id)
      .delete()
      .catch(() => {
        /* best-effort cleanup — never fail the user's delete on this */
      });
  }

  /** Shared cache-aside + build for both aggregate kinds. */
  private async aggregate(opts: {
    kind: "portfolio" | "watchlist";
    collection: string;
    docId: string;
    label: string;
    members: AggMember[];
  }): Promise<Record<string, unknown>> {
    const { kind, collection, docId, label } = opts;

    // Largest positions first, then cap — a 60-name portfolio should be
    // summarised by what actually moves it, not by the first 25 alphabetically.
    const members = [...opts.members]
      .sort((a, b) => b.shares - a.shares)
      .slice(0, AI_AGG_MAX_MEMBERS);

    const hash = this.compositionHash(
      members
        .map((m) => `${m.ticker}:${m.shares}:${m.costBasis ?? ""}`)
        .sort(),
    );

    const memKey = `agg_${docId}`;
    const mem = this.mem.get(memKey);
    if (mem && Date.now() - mem.at < 5 * 60_000 && mem.data.composition === hash) {
      return mem.data;
    }

    const ref = this.firebase.firestore.collection(collection).doc(docId);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      const created =
        typeof data.createdAt === "string" ? Date.parse(data.createdAt) : NaN;
      const ttl = data.ok === false ? AI_ERR_TTL_MS : AI_TTL_MS;
      // Composition mismatch beats freshness: the basket changed, so the cached
      // summary describes something the user is no longer holding/watching.
      if (
        data.composition === hash &&
        Number.isFinite(created) &&
        Date.now() - created < ttl
      ) {
        this.mem.set(memKey, { data, at: Date.now() });
        return data;
      }
    }

    const key = `agg_${collection}_${docId}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const p = (async () => {
      const doc = await this.buildAggregate(kind, label, members, hash);
      await ref.set(doc);
      this.mem.set(memKey, { data: doc, at: Date.now() });
      return doc;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  private async buildAggregate(
    kind: "portfolio" | "watchlist",
    label: string,
    members: AggMember[],
    composition: string,
  ): Promise<Record<string, unknown>> {
    const now = new Date().toISOString();
    const base = {
      kind,
      composition,
      memberCount: members.length,
      truncated: false,
      createdAt: now,
      updatedAt: now,
    };

    if (members.length === 0) {
      return { ...base, ok: false, model: this.ai.modelName, analysis: null, error: "empty-basket" };
    }

    const tickers = members.map((m) => m.ticker);
    const [companies, reads] = await Promise.all([
      this.companiesFor(tickers).catch(() => new Map()),
      this.cachedStockReads(tickers).catch(() => new Map()),
    ]);

    const userMsg = buildAggregateContext(kind, members, companies, reads);
    const messages: ChatMessage[] = [
      { role: "system", content: AGGREGATE_SYSTEM_PROMPT },
      { role: "user", content: userMsg },
    ];

    // Never web-search an aggregate: the members' own news already reached the
    // model through their cached per-stock reads, and :online is paid.
    // Tighter than the single-stock read: an aggregate also does two Firestore
    // batch reads first, and the whole thing must clear Hosting's 60s cutoff
    // INCLUDING a COLD START — this service scales to zero, and booting Nest
    // costs 10-20s that counts against the same budget. 2 x 12s keeps the worst
    // case near 24s so even a cold container answers in time.
    const { parsed, raw, usedModel } = await this.callWithFallback(
      label,
      messages,
      false,
      AI_AGG_TIMEOUT_MS,
    );

    if (!parsed) {
      if (raw) {
        this.logger.warn(
          `AI aggregate for ${label}: model replied but no JSON could be parsed (${usedModel}). First 200 chars: ${raw.slice(0, 200).replace(/\s+/g, " ")}`,
        );
      }
      return {
        ...base,
        ok: false,
        model: usedModel,
        analysis: null,
        error: this.ai.enabled ? "generation-failed" : "ai-disabled",
      };
    }

    const a = (parsed.analysis ?? parsed) as Record<string, unknown>;
    return {
      ...base,
      ok: true,
      model: usedModel,
      reusedStockReads: reads.size,
      analysis: {
        headline: a.headline ?? null,
        posture: a.posture ?? null,
        concentration: a.concentration ?? null,
        leaders: a.leaders ?? null,
        laggards: a.laggards ?? null,
        watchItems: a.watchItems ?? null,
      },
    };
  }
}
