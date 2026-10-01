import { Inject, Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { LlmGatewayService } from "../vendors/llm-gateway.service";
import {
  NEWS_ADAPTER,
  NEWS_BENZINGA_ADAPTER,
  NEWS_FMP_ADAPTER,
  type NewsAdapter,
  type CanonicalNewsArticle,
} from "../adapters/types";

export const MOVER_CATALYSTS_COLLECTION = "mover_catalysts";
export const CATALYST_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface MoverCatalystDoc {
  ticker: string;
  direction?: string | null;
  pctChange?: number | null;
  catalyst: string;
  headline: string | null;
  summary: string | null;
  source: "benzinga_wiim" | "ai_synthesis" | "sec_filing" | "news_headline";
  vendor: "benzinga" | "polygon" | "fmp" | "sec" | "llm";
  newsUrl: string | null;
  publishedAt: string | null;
  updatedAt: string;
}

@Injectable()
export class MoverCatalystService {
  private readonly logger = new Logger(MoverCatalystService.name);
  private readonly memCache = new Map<
    string,
    { data: MoverCatalystDoc; at: number }
  >();
  private readonly inflight = new Map<string, Promise<MoverCatalystDoc | null>>();

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly llm: LlmGatewayService,
    @Inject(NEWS_BENZINGA_ADAPTER)
    private readonly benzingaAdapter: NewsAdapter | null,
    @Inject(NEWS_ADAPTER) private readonly polygonAdapter: NewsAdapter,
    @Inject(NEWS_FMP_ADAPTER)
    private readonly fmpAdapter: NewsAdapter | null,
  ) {}

  private get col() {
    return this.firebase.firestore.collection(MOVER_CATALYSTS_COLLECTION);
  }

  /** Check if document is fresh within 30 mins TTL and matches move direction */
  static isFresh(doc: MoverCatalystDoc | null, direction?: string): boolean {
    if (!doc?.updatedAt) return false;
    const age = Date.now() - Date.parse(doc.updatedAt);
    if (!Number.isFinite(age) || age >= CATALYST_TTL_MS) return false;
    // Invalidate immediately if stock reversed direction (e.g. gainer -> loser)
    if (direction && doc.direction && direction !== doc.direction) return false;
    return true;
  }

  /** Get single catalyst for a ticker, using tier-wise resolution and dual-tier cache */
  async getOrResolveCatalyst(
    ticker: string,
    direction?: string,
    pctChange?: number,
  ): Promise<MoverCatalystDoc | null> {
    const symbol = ticker.toUpperCase().trim();
    if (!symbol) return null;

    // 1. In-memory check (with direction validation)
    const mem = this.memCache.get(symbol);
    if (
      mem &&
      Date.now() - mem.at < CATALYST_TTL_MS &&
      (!direction || !mem.data.direction || direction === mem.data.direction)
    ) {
      return mem.data;
    }

    // 2. Coalescing in-flight request
    const existing = this.inflight.get(symbol);
    if (existing) return existing;

    const p = this.resolve(symbol, direction, pctChange).finally(() => {
      this.inflight.delete(symbol);
    });

    this.inflight.set(symbol, p);
    return p;
  }

  /** Get catalysts for multiple tickers in batch */
  async getBatchCatalysts(
    tickers: string[],
  ): Promise<Record<string, MoverCatalystDoc | null>> {
    const unique = [...new Set(tickers.map((t) => t.toUpperCase().trim()))].filter(
      Boolean,
    );
    const results: Record<string, MoverCatalystDoc | null> = {};

    await Promise.all(
      unique.map(async (t) => {
        results[t] = await this.getOrResolveCatalyst(t);
      }),
    );

    return results;
  }

  private async resolve(
    ticker: string,
    direction?: string,
    pctChange?: number,
  ): Promise<MoverCatalystDoc | null> {
    // Check Firestore doc cache first
    try {
      const snap = await this.col.doc(ticker).get();
      if (snap.exists) {
        const doc = snap.data() as MoverCatalystDoc;
        if (MoverCatalystService.isFresh(doc, direction)) {
          this.memCache.set(ticker, { data: doc, at: Date.now() });
          return doc;
        }
      }
    } catch (err) {
      this.logger.warn(`Firestore read failed for catalyst ${ticker}: ${(err as Error).message}`);
    }

    const now = new Date();
    const fromIso = new Date(now.getTime() - 48 * 3600_000).toISOString();
    const toIso = now.toISOString();

    // ── Tier 1: Benzinga WIIM ───────────────────────────────────────────────
    if (this.benzingaAdapter && (this.benzingaAdapter as any).enabled) {
      try {
        const res = await this.benzingaAdapter.fetchNews(ticker, fromIso, toIso);
        if (res.data && res.data.length > 0) {
          const top = res.data[0];
          const doc: MoverCatalystDoc = {
            ticker,
            direction: direction ?? null,
            pctChange: pctChange ?? null,
            catalyst: top.summary || top.headline,
            headline: top.headline,
            summary: top.summary,
            source: "benzinga_wiim",
            vendor: "benzinga",
            newsUrl: top.url || null,
            publishedAt: top.publishedAt || now.toISOString(),
            updatedAt: now.toISOString(),
          };
          await this.saveDoc(ticker, doc);
          return doc;
        }
      } catch (err) {
        this.logger.warn(`Tier 1 Benzinga fetch failed for ${ticker}: ${(err as Error).message}`);
      }
    }

    // ── Tier 2: Polygon + FMP News + LLM Synthesis ─────────────────────────
    const articles: CanonicalNewsArticle[] = [];
    try {
      const polyRes = await this.polygonAdapter.fetchNews(ticker, fromIso, toIso);
      if (polyRes.data) articles.push(...polyRes.data);
    } catch (err) {
      this.logger.warn(`Polygon news fetch failed for ${ticker}: ${(err as Error).message}`);
    }

    if (this.fmpAdapter) {
      try {
        const fmpRes = await this.fmpAdapter.fetchNews(ticker, fromIso, toIso);
        if (fmpRes.data) articles.push(...fmpRes.data);
      } catch {
        // Ignore optional FMP news errors
      }
    }

    // Sort newest first
    articles.sort(
      (a, b) => Date.parse(b.publishedAt || "") - Date.parse(a.publishedAt || ""),
    );

    if (articles.length > 0) {
      const topNews = articles.slice(0, 3);
      const first = topNews[0];

      // Try LLM Synthesis if LLM gateway is available
      if (this.llm.enabled) {
        try {
          const newsContext = topNews
            .map(
              (n, i) => `${i + 1}. [${n.source}] ${n.headline}${n.summary ? `: ${n.summary.slice(0, 150)}` : ""}`,
            )
            .join("\n");

          const prompt = `Stock: ${ticker} (${direction ? direction : "moved"} ${pctChange != null ? `${pctChange}%` : ""}).
Recent News:
${newsContext}

Task: Explain why the stock moved in 1 to 2 clear, direct, informative sentences based on the news above. Do NOT use filler intros like "Based on the news". State the catalyst directly.`;

          const reply = await this.llm.chat(
            [
              {
                role: "system",
                content:
                  "You are a Wall Street financial analyst providing brief, precise stock movement catalyst summaries.",
              },
              { role: "user", content: prompt },
            ],
            { timeoutMs: 12_000 },
          );

          if (reply && reply.trim().length > 10) {
            const doc: MoverCatalystDoc = {
              ticker,
              direction: direction ?? null,
              pctChange: pctChange ?? null,
              catalyst: reply.trim(),
              headline: first.headline,
              summary: first.summary,
              source: "ai_synthesis",
              vendor: "llm",
              newsUrl: first.url || null,
              publishedAt: first.publishedAt || now.toISOString(),
              updatedAt: now.toISOString(),
            };
            await this.saveDoc(ticker, doc);
            return doc;
          }
        } catch (err) {
          this.logger.warn(`LLM catalyst synthesis failed for ${ticker}: ${(err as Error).message}`);
        }
      }

      // Headline Fallback when LLM is unavailable or unparseable
      const doc: MoverCatalystDoc = {
        ticker,
        direction: direction ?? null,
        pctChange: pctChange ?? null,
        catalyst: first.headline,
        headline: first.headline,
        summary: first.summary,
        source: "news_headline",
        vendor: (first.vendor as any) || "polygon",
        newsUrl: first.url || null,
        publishedAt: first.publishedAt || now.toISOString(),
        updatedAt: now.toISOString(),
      };
      await this.saveDoc(ticker, doc);
      return doc;
    }

    // ── Tier 3: Default Sparse Fallback ────────────────────────────────────
    const defaultDoc: MoverCatalystDoc = {
      ticker,
      direction: direction ?? null,
      pctChange: pctChange ?? null,
      catalyst: `No major news catalyst reported for ${ticker} in the last 48 hours.`,
      headline: null,
      summary: null,
      source: "news_headline",
      vendor: "polygon",
      newsUrl: null,
      publishedAt: null,
      updatedAt: now.toISOString(),
    };

    await this.saveDoc(ticker, defaultDoc);
    return defaultDoc;
  }

  private async saveDoc(ticker: string, doc: MoverCatalystDoc): Promise<void> {
    this.memCache.set(ticker, { data: doc, at: Date.now() });
    try {
      await this.col.doc(ticker).set(doc, { merge: true });
    } catch (err) {
      this.logger.warn(`Failed saving mover catalyst to Firestore for ${ticker}: ${(err as Error).message}`);
    }
  }
}
