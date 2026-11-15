import { Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { LlmGatewayService } from "../vendors/llm-gateway.service";
import { OnDemandService } from "./ondemand.service";
import {
  SYSTEM_PROMPT,
  articleKey,
  buildUserPrompt,
  coerceMoveCard,
  parseJsonObject,
  selectMoveArticles,
  type MoveArticle,
} from "./move-explainer.util";

const COLLECTION = "move_explanations";
const DAY_MS = 86_400_000;
/** A move this recent can still gain articles; older ones are settled and kept for good. */
const RECENT_DAYS = 4;
/** A recent card is only rewritten when new articles arrived, and not more often than this. */
const REFRESH_AFTER_MS = 30 * 60_000;
const MEM_TTL_MS = 10 * 60_000;
const LLM_TIMEOUT_MS = 25_000;
/** Cost guard: model calls per minute across the whole process. Groq's free tier allows 8,000 tokens a minute for the whole account, and one card costs about 1,500. */
const MAX_GENERATIONS_PER_MIN = 6;

export interface MoveExplanationInput {
  ticker: string;
  /** Trading day of the move, YYYY-MM-DD (US Eastern date). */
  date: string;
  /** Previous trading day, so a Monday move sees the weekend's news. */
  prevDate?: string | null;
  /** Company name, only used to recognise the company in headlines. */
  name?: string | null;
  /** The day's % move, shown to the model and allowed as a quoted figure. */
  movePct?: number | null;
}

export interface MoveExplanation {
  available: boolean;
  /** Why there is no card: "no-articles", "no-explanation" (the articles do not explain the move), "busy", "llm-unavailable", "llm-failed". */
  reason?: string;
  ticker: string;
  date: string;
  heading?: string;
  summary?: string;
  /** Outlets the card relied on. */
  sources?: Array<{ name: string; url: string }>;
  articleCount?: number;
  model?: string;
  generatedAt?: string;
}

type StoredDoc = MoveExplanation & { articleKey?: string };

/**
 * One heading + short explanation for a big price move, written by the LLM from
 * the articles around that day only, then checked (see move-explainer.util).
 *
 * Generated once per ticker and day and stored; a settled day is never
 * regenerated, a recent day only when new articles arrive. Nothing here runs on
 * a schedule: the first request for a day pays for it, later ones read storage.
 */
@Injectable()
export class MoveExplainerService {
  private readonly logger = new Logger(MoveExplainerService.name);
  private readonly mem = new Map<
    string,
    { doc: MoveExplanation; at: number }
  >();
  private readonly inflight = new Map<string, Promise<MoveExplanation>>();
  private generationTimes: number[] = [];

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly llm: LlmGatewayService,
    private readonly ondemand: OnDemandService,
  ) {}

  private get col() {
    return this.firebase.firestore.collection(COLLECTION);
  }

  private overBudget(): boolean {
    const now = Date.now();
    this.generationTimes = this.generationTimes.filter((t) => now - t < 60_000);
    if (this.generationTimes.length >= MAX_GENERATIONS_PER_MIN) return true;
    this.generationTimes.push(now);
    return false;
  }

  private isRecent(date: string): boolean {
    return Date.now() - Date.parse(`${date}T00:00:00Z`) < RECENT_DAYS * DAY_MS;
  }

  async getExplanation(input: MoveExplanationInput): Promise<MoveExplanation> {
    const ticker = input.ticker.toUpperCase();
    const id = `${ticker}_${input.date}`;

    const mem = this.mem.get(id);
    if (mem && Date.now() - mem.at < MEM_TTL_MS) return mem.doc;

    const existing = this.inflight.get(id);
    if (existing) return existing;

    const task = this.resolve(id, { ...input, ticker }).finally(() =>
      this.inflight.delete(id),
    );
    this.inflight.set(id, task);
    return task;
  }

  private async resolve(
    id: string,
    input: MoveExplanationInput,
  ): Promise<MoveExplanation> {
    const snap = await this.col
      .doc(id)
      .get()
      .catch(() => null);
    const stored = snap?.exists ? (snap.data() as StoredDoc) : null;
    const recent = this.isRecent(input.date);

    // A settled day with a stored answer (a card, or "the articles do not explain it") is final.
    if (stored && !recent) return this.remember(id, stored);

    const articles = await this.articlesFor(input);
    const key = articleKey(articles);
    if (stored) {
      const age = Date.now() - Date.parse(stored.generatedAt ?? "");
      if (stored.articleKey === key || age < REFRESH_AFTER_MS)
        return this.remember(id, stored);
    }

    if (!articles.length) {
      return this.save(
        id,
        {
          available: false,
          reason: "no-articles",
          ticker: input.ticker,
          date: input.date,
          articleCount: 0,
        },
        key,
      );
    }
    if (!this.llm.enabled) {
      return {
        available: false,
        reason: "llm-unavailable",
        ticker: input.ticker,
        date: input.date,
        articleCount: articles.length,
      };
    }
    if (this.overBudget()) {
      return (
        stored ?? {
          available: false,
          reason: "busy",
          ticker: input.ticker,
          date: input.date,
          articleCount: articles.length,
        }
      );
    }

    let verdict: ReturnType<typeof coerceMoveCard> = null;
    try {
      const reply = await this.llm.chat(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(input, articles) },
        ],
        { timeoutMs: LLM_TIMEOUT_MS, maxTokens: 450, reasoningEffort: "low" },
      );
      verdict = reply
        ? coerceMoveCard(parseJsonObject(reply), articles, input.movePct)
        : null;
    } catch (err) {
      this.logger.warn(
        `move explanation ${id}: ${(err as Error)?.message ?? err}`,
      );
    }

    // An unusable answer is not stored: the next request tries again.
    if (verdict === null) {
      this.logger.warn(
        `move explanation ${id}: model answer unusable (${articles.length} articles)`,
      );
      return (
        stored ?? {
          available: false,
          reason: "llm-failed",
          ticker: input.ticker,
          date: input.date,
          articleCount: articles.length,
        }
      );
    }
    if (verdict === "none") {
      return this.save(
        id,
        {
          available: false,
          reason: "no-explanation",
          ticker: input.ticker,
          date: input.date,
          articleCount: articles.length,
        },
        key,
      );
    }
    return this.save(
      id,
      {
        available: true,
        ticker: input.ticker,
        date: input.date,
        heading: verdict.heading,
        summary: verdict.summary,
        sources: this.sourcesOf(articles, verdict.used),
        articleCount: articles.length,
        model: this.llm.primaryName,
        generatedAt: new Date().toISOString(),
      },
      key,
    );
  }

  private async articlesFor(
    input: MoveExplanationInput,
  ): Promise<MoveArticle[]> {
    const news = await this.ondemand
      .getNews(input.ticker)
      .catch(() => [] as Record<string, unknown>[]);
    return selectMoveArticles(news, {
      date: input.date,
      prevDate: input.prevDate,
      ticker: input.ticker,
      name: input.name,
      movePct: input.movePct,
    });
  }

  private sourcesOf(
    articles: readonly MoveArticle[],
    used: readonly number[],
  ): Array<{ name: string; url: string }> {
    const chosen = (
      used.length
        ? articles.filter((a) => used.includes(a.n))
        : articles.slice(0, 3)
    )
      .slice()
      .sort(
        (a, b) =>
          Number(/youtube\.com/i.test(a.source)) -
          Number(/youtube\.com/i.test(b.source)),
      );
    const seen = new Set<string>();
    const out: Array<{ name: string; url: string }> = [];
    for (const a of chosen) {
      const name = a.source || "News";
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({ name, url: a.url });
      if (out.length >= 4) break;
    }
    return out;
  }

  private async save(
    id: string,
    doc: MoveExplanation,
    key: string,
  ): Promise<MoveExplanation> {
    const full: StoredDoc = {
      ...doc,
      generatedAt: doc.generatedAt ?? new Date().toISOString(),
      articleKey: key,
    };
    await this.col
      .doc(id)
      .set(full)
      .catch((err) =>
        this.logger.warn(
          `move explanation ${id}: could not store (${err?.message ?? err})`,
        ),
      );
    return this.remember(id, full);
  }

  private remember(id: string, doc: StoredDoc): MoveExplanation {
    const { articleKey: _key, ...pub } = doc;
    this.mem.set(id, { doc: pub, at: Date.now() });
    return pub;
  }
}
