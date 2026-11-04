import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { etDate } from "../common/market-calendar.util";
import { getSecUserAgent } from "../common/sec-cik-map.util";
import { BlogsAdminService } from "../blogs/blogs-admin.service";
import { FmpService, type FmpFullQuote } from "../vendors/fmp/fmp.service";
import { LlmGatewayService } from "../vendors/llm-gateway.service";
import type { RelatedCard } from "./earnings-article-html.builder";
import { composeArticle, type ComposedArticle } from "./earnings-article.compose";
import {
  buildFacts,
  pickReaction,
  type ArticleFacts,
  type EstimateRow,
  type ReportRow,
  type StatementRow,
} from "./earnings-article.facts";
import { acceptCopy, buildMessages, releaseExcerpt, type ArticleCopy } from "./earnings-article.writer";

const JOB_NAME = "earnings-article";
// Every minute through both reporting windows; see job-manifest.ts for the
// Cloud Scheduler entries that actually fire it.
const CRON = "* 6-19 * * 1-5";

/** One doc per company and report: the claim that makes posting exactly-once. */
const ARTICLES = "earnings_articles";
/** One doc per report date: which symbols were already handled (cheap to read every minute). */
const DAYS = "earnings_article_days";
const STATE_DOC = "_state";

const MIN_MARKET_CAP = 1e9;
const US_EXCHANGES = new Set(["NYSE", "NASDAQ", "AMEX", "NYSE AMERICAN", "NYSEARCA"]);
/** A claim older than this was left by a run that died; another run may take it over. */
const STALE_CLAIM_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const CONCURRENCY = 3;
/** Stop starting new articles after this long; the next minute's run picks up the rest. */
const RUN_BUDGET_MS = 240_000;
/**
 * Model tokens per minute to stay under. Groq's on-demand tier allows 8,000
 * for gpt-oss-120b and an article prompt is ~4–5k, so roughly one article a
 * minute gets model-written release sections at once; the rest publish with
 * code-written text and get the sections on a later pass (enrichment).
 */
const LLM_TPM = Number(process.env.EARNINGS_ARTICLE_LLM_TPM ?? 7_500);
const MAX_ENRICH_ATTEMPTS = 3;

export type Mode = "publish" | "draft" | "dry" | "off";

interface Built {
  facts: ArticleFacts;
  copy: ArticleCopy;
  article: ComposedArticle;
  has8k: boolean;
  related: RelatedCard[];
  /** Published with code-written text although a release exists: add its sections later. */
  wantsEnrich: boolean;
}

/** A calendar row with both actuals, i.e. a company that has reported. */
export interface Reported extends ReportRow {
  symbol: string;
}

interface Profile {
  symbol: string;
  companyName: string;
  sector?: string | null;
  industry?: string | null;
  exchange?: string | null;
  cik?: string | null;
  isEtf?: boolean;
  isFund?: boolean;
  isActivelyTrading?: boolean;
}

export interface Candidate {
  row: Reported;
  quote: FmpFullQuote;
  profile: Profile;
}

interface RecentPost {
  title: string;
  slug: string;
  type: string;
  status: string;
  read: string;
  createdMs: number;
  content: string;
}

export interface RunResult {
  mode: Mode;
  checked: number;
  newlyReported: number;
  posted: Array<{ symbol: string; url: string; title: string }>;
  skipped: Array<{ symbol: string; reason: string }>;
  failed: Array<{ symbol: string; error: string }>;
  previews?: Array<{ symbol: string; title: string; documentHtml: string; fromModel: string[] }>;
  seeded?: number;
  enriched?: string[];
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: unknown): number | null => (finite(v) ? v : null);

/** Ordinary listed symbols only: "CVS", "BRK-B" — not "002775.SZ". */
export function isUsSymbol(symbol: string): boolean {
  return /^[A-Z][A-Z0-9]{0,5}(-[A-Z])?$/.test(symbol);
}

/** Calendar rows that have both actuals and an ordinary US symbol. */
export function reportedRows(rows: unknown[]): Reported[] {
  const out: Reported[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    const symbol = typeof r.symbol === "string" ? r.symbol : "";
    if (!isUsSymbol(symbol) || typeof r.date !== "string") continue;
    const epsActual = num(r.epsActual);
    const revenueActual = num(r.revenueActual);
    if (epsActual == null || revenueActual == null) continue;
    out.push({
      symbol,
      date: r.date.slice(0, 10),
      epsActual,
      revenueActual,
      epsEstimated: num(r.epsEstimated),
      revenueEstimated: num(r.revenueEstimated),
    });
  }
  return out;
}

/**
 * Why a company is not written up, or null when it is. Generic rules only:
 * US listing, operating company, $1B+ market cap.
 */
export function universeReason(quote: FmpFullQuote | undefined, profile: Profile | null): string | null {
  if (!quote || !finite(quote.marketCap)) return "no-quote";
  if (quote.marketCap < MIN_MARKET_CAP) return "under-1b";
  if (!profile) return "no-profile";
  if (profile.isEtf || profile.isFund) return "fund";
  if (profile.isActivelyTrading === false) return "inactive";
  if (!US_EXCHANGES.has(String(profile.exchange ?? "").toUpperCase())) return "non-us-listing";
  return null;
}

/**
 * One article per company: share classes and preferreds of the same issuer
 * (same SEC CIK) report the same results. Keeps the most-traded symbol.
 */
export function onePerCompany(cands: Candidate[]): { keep: Candidate[]; dropped: Candidate[] } {
  const byKey = new Map<string, Candidate[]>();
  for (const c of cands) {
    const key = `${c.profile.cik || c.row.symbol}|${c.row.date}`;
    byKey.set(key, [...(byKey.get(key) ?? []), c]);
  }
  const keep: Candidate[] = [];
  const dropped: Candidate[] = [];
  for (const group of byKey.values()) {
    const sorted = [...group].sort(
      (a, b) =>
        Number(a.row.symbol.includes("-")) - Number(b.row.symbol.includes("-")) ||
        (b.quote.volume ?? 0) - (a.quote.volume ?? 0) ||
        a.row.symbol.length - b.row.symbol.length,
    );
    keep.push(sorted[0]);
    dropped.push(...sorted.slice(1));
  }
  return { keep, dropped };
}

/** True when a recent post already covers this ticker (for example one written by hand). */
export function coveredBy(posts: RecentPost[], symbol: string, nowMs: number): RecentPost | null {
  const tick = new RegExp(`"tickerSymbol"\\s*:\\s*"${symbol}"|\\(${symbol.replace("-", "\\-")}\\)`);
  return (
    posts.find(
      (p) => p.type === "earnings" && nowMs - p.createdMs <= 3 * 86_400_000 && (tick.test(p.content) || tick.test(p.title)),
    ) ?? null
  );
}

const PILL: Record<string, RelatedCard["pill"]> = { earnings: "Earnings", recap: "Recap", news: "News", research: "Research" };

/** "Snap Swings to Q3 Profit…" → "Snap". */
function linkTextOf(title: string): string {
  const m = /^(.+?)\s+(Beats|Tops|Misses|Falls|Raises|Cuts|Lifts|Trims|Reaffirms|Swings|Guides|Matches|Reports|Posts|Q[1-4]|Fiscal|Revenue|Adjusted|EPS)\b/.exec(title);
  const t = m && m[1].length >= 2 && m[1].length <= 40 ? m[1] : title;
  return t.length > 70 ? `${t.slice(0, 67).replace(/\s+\S*$/, "")}…` : t;
}

/**
 * Four live posts for "Readers also read" (skill §8 priority): earlier
 * coverage of the same ticker, then recent earnings coverage, then anything
 * recent. Only published posts, so every URL is live.
 */
export function pickRelated(posts: RecentPost[], symbol: string): RelatedCard[] {
  const live = posts.filter((p) => p.status === "published" && p.slug && p.title);
  const tick = new RegExp(`\\(${symbol.replace("-", "\\-")}\\)|"tickerSymbol"\\s*:\\s*"${symbol}"`);
  const ordered = [
    ...live.filter((p) => tick.test(p.content)),
    ...live.filter((p) => p.type === "earnings"),
    ...live,
  ];
  const seen = new Set<string>();
  const out: RelatedCard[] = [];
  for (const p of ordered) {
    if (seen.has(p.slug)) continue;
    seen.add(p.slug);
    const mins = /(\d+)\s*min/.exec(p.read)?.[1] ?? "3";
    out.push({
      pill: PILL[p.type] ?? "Research",
      title: p.title,
      url: `https://marketcatalyst.ai/posts/${p.slug}`,
      readTime: `${mins} min`,
      linkText: linkTextOf(p.title),
    });
    if (out.length === 4) break;
  }
  return out;
}

/** Does the release state FMP's revenue (in any common scale)? Confirms it is this report's release. */
export function releaseStatesRevenue(text: string, revenue: number): boolean {
  const t = text.replace(/\s+/g, " ");
  const forms = new Set<string>();
  const m = revenue / 1e6;
  const b = revenue / 1e9;
  const k = Math.round(revenue / 1e3);
  forms.add(m.toFixed(1));
  forms.add(m.toFixed(0));
  if (b >= 1) {
    forms.add(b.toFixed(1));
    forms.add(b.toFixed(2));
    forms.add(b.toFixed(3));
  }
  forms.add(k.toLocaleString("en-US"));
  forms.add(Math.round(m).toLocaleString("en-US"));
  forms.add(m.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
  for (const f of forms) {
    if (new RegExp(`(?<![\\d.,])${f.replace(/[.,]/g, (c) => `\\${c}`)}(?![\\d])`).test(t)) return true;
  }
  return false;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

@Injectable()
export class EarningsArticleJob implements OnModuleInit {
  private readonly logger = new Logger(EarningsArticleJob.name);
  /** Symbols this process already handled, keyed "date|symbol" — saves the day-doc lookup. */
  private readonly handled = new Set<string>();
  /** Model tokens spent in the last minute, for the LLM_TPM budget. */
  private llmSpend: Array<{ at: number; tokens: number }> = [];
  private llmChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly blogs: BlogsAdminService,
    private readonly fmp: FmpService,
    private readonly llm: LlmGatewayService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, (params?: Record<string, string>) => this.run(params), {
      collections: ["posts", "earnings_articles", "earnings_article_days"],
      cronExpression: CRON,
      timeZone: "America/New_York",
    });
  }

  private get db(): Firestore {
    return this.firebase.firestore;
  }

  private mode(params?: Record<string, string>): Mode {
    const m = String(params?.mode ?? process.env.EARNINGS_ARTICLE_MODE ?? "publish").toLowerCase();
    return (["publish", "draft", "dry", "off"].includes(m) ? m : "publish") as Mode;
  }

  /**
   * One pass: find companies whose actuals appeared since the last pass, and
   * write one article each. Run every minute; a pass with nothing new costs
   * two FMP calls and two Firestore reads.
   *
   * params: mode (publish|draft|dry|off), dates (comma list, default
   * yesterday+today ET), tickers (comma list, restricts — for testing),
   * seed=true (mark everything already reported as handled, post nothing).
   */
  async run(params?: Record<string, string>): Promise<RunResult> {
    const mode = this.mode(params);
    const started = Date.now();
    const result: RunResult = { mode, checked: 0, newlyReported: 0, posted: [], skipped: [], failed: [] };
    if (mode === "off") {
      await this.meta.record(JOB_NAME, { ok: true, count: 0 });
      return result;
    }
    const today = etDate();
    const dates = params?.dates
      ? params.dates.split(",").map((d) => d.trim()).filter(Boolean)
      : [etDate(new Date(Date.now() - 86_400_000)), today];

    try {
      const reported: Reported[] = [];
      for (const d of dates) reported.push(...reportedRows(await this.fmp.request(`earnings-calendar?from=${d}&to=${d}`)));
      result.checked = reported.length;
      const restrict = params?.tickers ? new Set(params.tickers.split(",").map((t) => t.trim().toUpperCase())) : null;

      // First run ever (or seed=true): everything already reported is the
      // baseline — "from now on" means only what reports after this point.
      if (mode !== "dry") {
        const state = await this.db.collection(DAYS).doc(STATE_DOC).get();
        if (!state.exists || params?.seed === "true") {
          result.seeded = await this.seed(reported);
          await this.db.collection(DAYS).doc(STATE_DOC).set({ startedAt: FieldValue.serverTimestamp(), seededCount: result.seeded }, { merge: true });
          this.logger.log(`earnings-article: seeded ${result.seeded} already-reported rows; posting starts with the next report`);
          await this.meta.record(JOB_NAME, { ok: true, count: 0 });
          return result;
        }
      }

      const seen = mode === "dry" ? new Map<string, Record<string, string>>() : await this.seenByDate(dates);
      const fresh = reported.filter(
        (r) =>
          (!restrict || restrict.has(r.symbol)) &&
          !this.handled.has(`${r.date}|${r.symbol}`) &&
          !seen.get(r.date)?.[r.symbol],
      );
      result.newlyReported = fresh.length;
      if (!fresh.length) {
        if (mode !== "dry") await this.enrich(reported, null, started, result);
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return result;
      }

      const marks: Array<{ date: string; symbol: string; value: string }> = [];
      const skip = (r: Reported, reason: string) => {
        result.skipped.push({ symbol: r.symbol, reason });
        marks.push({ date: r.date, symbol: r.symbol, value: `skipped:${reason}` });
      };

      // Universe: one batch quote for market cap, then a profile for the $1B+ names.
      const quotes = new Map((await this.fmp.getQuotes([...new Set(fresh.map((r) => r.symbol))])).map((q) => [q.symbol, q]));
      const cands: Candidate[] = [];
      for (const r of fresh) {
        const q = quotes.get(r.symbol);
        if (!q || !finite(q.marketCap) || q.marketCap < MIN_MARKET_CAP) {
          skip(r, universeReason(q, null) ?? "under-1b");
          continue;
        }
        const profile = await this.profile(r.symbol);
        const why = universeReason(q, profile);
        if (why) skip(r, why);
        else cands.push({ row: r, quote: q, profile: profile! });
      }
      const { keep, dropped } = onePerCompany(cands);
      for (const d of dropped) skip(d.row, "share-class");

      const recent = keep.length ? await this.recentPosts() : [];
      const todo: Candidate[] = [];
      for (const c of keep) {
        const existing = coveredBy(recent, c.row.symbol, Date.now());
        if (existing && mode !== "dry") skip(c.row, `existing-post:${existing.slug}`);
        else todo.push(c);
      }
      if (mode !== "dry") await this.mark(marks);

      // Articles, a few at a time, inside the run budget.
      const queue = [...todo];
      const worker = async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          if (Date.now() - started > RUN_BUDGET_MS) return;
          await this.one(c, mode, recent, result);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
      if (mode !== "dry") await this.enrich(reported, recent, started, result);

      await this.meta.record(JOB_NAME, { ok: result.failed.length === 0, count: result.posted.length });
      this.logger.log(
        `earnings-article: ${result.newlyReported} new, ${result.posted.length} posted, ${result.skipped.length} skipped, ${result.failed.length} failed (${Date.now() - started}ms)`,
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`earnings-article failed: ${msg}`);
      await this.meta.record(JOB_NAME, { ok: false, error: msg });
      throw err;
    }
  }

  /**
   * Adds the release's sections to articles that went out with code-written
   * text only. Same post, same title and URL; dateModified moves (skill §7).
   * Never throws — a failure is retried on later passes, up to a limit.
   */
  private async enrich(reported: Reported[], recent: RecentPost[] | null, started: number, result: RunResult): Promise<void> {
    if (!this.llm.enabled) return;
    const snap = await this.db.collection(ARTICLES).where("enrichPending", "==", true).limit(3).get();
    if (snap.empty) return;
    const posts = recent ?? (await this.recentPosts());
    for (const doc of snap.docs) {
      // No room for a model call this minute: try again next pass, without spending an attempt.
      if (Date.now() - started > RUN_BUDGET_MS || !this.llmRoom(5_500)) return;
      const d = doc.data();
      const attempts = Number(d.enrichAttempts ?? 0);
      const done = (extra: Record<string, unknown>) =>
        doc.ref.set({ ...extra, enrichAttempts: attempts + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      try {
        const row = reported.find((r) => r.symbol === d.symbol && r.date === d.reportDate);
        const quote = (await this.fmp.getQuotes([String(d.symbol)]))[0];
        const profile = await this.profile(String(d.symbol));
        if (!row || !quote || !profile) {
          await done({ enrichPending: false, enrichNote: "report no longer in range" });
          continue;
        }
        const built = await this.build({ row, quote, profile }, posts.filter((p) => p.slug !== d.slug));
        if ("skip" in built || !built.copy.fromModel.includes("sections")) {
          await done({ enrichPending: attempts + 1 < MAX_ENRICH_ATTEMPTS });
          continue;
        }
        // The title — and so the URL — stays as first published.
        const copy = { ...built.copy, title: String(d.title) };
        const article = composeArticle(built.facts, copy, {
          createdMs: Number(d.createdMs),
          modifiedMs: Date.now(),
          related: built.related,
          has8k: built.has8k,
          slug: String(d.slug),
        });
        await this.blogs.update(String(d.postId), {
          zone: "earnings",
          title: article.title,
          dek: article.dek,
          kick: "Earnings",
          author: "",
          read: article.read,
          format: "html",
          html: article.documentHtml,
        });
        await done({ enrichPending: false, enrichedAt: FieldValue.serverTimestamp(), fromModel: copy.fromModel });
        this.logger.log(`earnings-article: enriched ${d.symbol} (${d.url}) with ${copy.fromModel.join(",")}`);
        (result.enriched ??= []).push(String(d.symbol));
      } catch (err) {
        await done({ enrichPending: attempts + 1 < MAX_ENRICH_ATTEMPTS, enrichError: (err as Error).message?.slice(0, 300) ?? String(err) }).catch(() => undefined);
      }
    }
  }

  /** Builds and (unless dry) posts one company's article. Never throws. */
  private async one(c: Candidate, mode: Mode, recent: RecentPost[], result: RunResult): Promise<void> {
    const { row } = c;
    const docId = `${(c.profile.cik || row.symbol).replace(/\//g, "_")}_${row.date}`;
    try {
      if (mode !== "dry") {
        const claim = await this.claim(docId, row);
        if (claim !== "claimed") {
          // Already posted or settled under another symbol or run: remember it.
          if (claim !== "busy") await this.mark([{ date: row.date, symbol: row.symbol, value: claim }]);
          return;
        }
      }
      const built = await this.build(c, recent);
      if ("skip" in built) {
        result.skipped.push({ symbol: row.symbol, reason: built.skip });
        if (mode !== "dry") {
          await this.db.collection(ARTICLES).doc(docId).set({ status: "skipped", reason: built.skip, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
          await this.mark([{ date: row.date, symbol: row.symbol, value: `skipped:${built.skip}` }]);
        }
        return;
      }
      if (mode === "dry") {
        (result.previews ??= []).push({ symbol: row.symbol, title: built.article.title, documentHtml: built.article.documentHtml, fromModel: built.copy.fromModel });
        return;
      }
      const posted = await this.publish(built, mode, recent, c);
      await this.db.collection(ARTICLES).doc(docId).set(
        {
          status: "posted",
          postId: posted.id,
          slug: posted.slug,
          url: posted.url,
          title: built.article.title,
          quarter: built.facts.quarter,
          mode,
          fromModel: built.copy.fromModel,
          has8k: built.has8k,
          postedAt: FieldValue.serverTimestamp(),
          createdMs: posted.createdMs,
          cik: c.profile.cik ?? null,
          enrichPending: built.wantsEnrich,
          enrichAttempts: 0,
        },
        { merge: true },
      );
      await this.mark([{ date: row.date, symbol: row.symbol, value: "posted" }]);
      this.handled.add(`${row.date}|${row.symbol}`);
      result.posted.push({ symbol: row.symbol, url: posted.url, title: built.article.title });
      this.logger.log(`earnings-article: ${mode} ${row.symbol} → ${posted.url} (model: ${built.copy.fromModel.join(",") || "none"})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failed.push({ symbol: row.symbol, error: msg });
      this.logger.error(`earnings-article: ${row.symbol} failed: ${msg}`);
      if (mode !== "dry") {
        const ref = this.db.collection(ARTICLES).doc(docId);
        const snap = await ref.get().catch(() => null);
        const attempts = Number(snap?.data()?.attempts ?? 1);
        await ref.set({ status: "failed", error: msg.slice(0, 500), updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => undefined);
        if (attempts >= MAX_ATTEMPTS) await this.mark([{ date: row.date, symbol: row.symbol, value: "skipped:failed" }]).catch(() => undefined);
      }
    }
  }

  private async build(
    c: Candidate,
    recent: RecentPost[],
  ): Promise<{ skip: string } | Built> {
    const s = c.row.symbol;
    const [history, statements, estimates, extended] = await Promise.all([
      this.fmp.request(`earnings?symbol=${s}&limit=12`),
      this.fmp.request(`income-statement?symbol=${s}&period=quarter&limit=6`),
      this.fmp.request(`analyst-estimates?symbol=${s}&period=quarter&limit=40`),
      this.fmp.getExtendedTrades([s]),
    ]);
    const facts = buildFacts({
      company: { symbol: s, name: c.profile.companyName || s, sector: c.profile.sector, industry: c.profile.industry, marketCap: c.quote.marketCap },
      report: c.row,
      history: (history as Array<Record<string, unknown>>).map((r) => ({
        date: String(r.date ?? "").slice(0, 10),
        epsActual: num(r.epsActual),
        epsEstimated: num(r.epsEstimated),
        revenueActual: num(r.revenueActual),
        revenueEstimated: num(r.revenueEstimated),
      })),
      statements: statements as StatementRow[],
      estimates: estimates as EstimateRow[],
      reaction: pickReaction(c.quote, extended[0] ?? null, Date.now()),
    });
    if ("skip" in facts) return facts;

    const releaseText = await this.release(s, c.row.date, facts.revenue.actual).catch((err) => {
      this.logger.warn(`earnings-article: ${s} release fetch failed: ${(err as Error).message}`);
      return null;
    });
    const excerpt = releaseText ? releaseExcerpt(releaseText) : null;

    const raw = await this.write(facts, excerpt);
    const copy = acceptCopy(raw, facts, excerpt);
    const related = pickRelated(recent, s);
    if (related.length < 4) return { skip: "no-related-posts" };
    const article = composeArticle(facts, copy, { createdMs: Date.now(), related, has8k: !!excerpt });
    return { facts, copy, article, has8k: !!excerpt, related, wantsEnrich: !!excerpt && !copy.fromModel.includes("sections") };
  }

  /** True when a call of about this many tokens fits in the last minute's budget. */
  private llmRoom(tokens: number): boolean {
    const now = Date.now();
    this.llmSpend = this.llmSpend.filter((e) => now - e.at < 60_000);
    return this.llmSpend.reduce((a, e) => a + e.tokens, 0) + tokens <= LLM_TPM;
  }

  /**
   * One model call, serialised and inside the per-minute token budget. Null
   * (no call) when the budget is spent — the article then publishes with
   * code-written text and is enriched on a later pass.
   */
  private async write(facts: ArticleFacts, excerpt: string | null): Promise<string | null> {
    if (!this.llm.enabled) return null;
    const messages = buildMessages(facts, excerpt);
    const tokens = Math.ceil(JSON.stringify(messages).length / 3.5) + 1_500;
    const run = this.llmChain.then(async () => {
      if (!this.llmRoom(tokens)) return null;
      this.llmSpend.push({ at: Date.now(), tokens });
      return this.llm.chat(messages, { jsonMode: true, maxTokens: 4000, timeoutMs: 25_000, reasoningEffort: "low" }).catch(() => null);
    });
    this.llmChain = run.catch(() => null);
    return run;
  }

  private async publish(
    built: Built,
    mode: Mode,
    recent: RecentPost[],
    c: Candidate,
  ): Promise<{ id: string; slug: string; url: string; createdMs: number }> {
    const createdMs = Date.now();
    let article = composeArticle(built.facts, built.copy, { createdMs, related: built.related, has8k: built.has8k });
    const body = {
      zone: "earnings",
      title: article.title,
      dek: article.dek,
      kick: "Earnings",
      author: "",
      read: article.read,
      format: "html",
      html: article.documentHtml,
      status: mode === "draft" ? "draft" : "published",
      pdfName: `earnings_${c.row.symbol}_${c.row.date}`,
    };
    const { id } = await this.blogs.create(body);
    const snap = await this.db.collection("posts").doc(id).get();
    const slug = String(snap.data()?.slug ?? article.slug);
    if (slug !== article.slug) {
      // The blog added a duplicate suffix; reprint the page's own URL to match.
      article = composeArticle(built.facts, built.copy, { createdMs, related: built.related, has8k: built.has8k, slug });
      await this.blogs.update(id, { ...body, status: undefined, html: article.documentHtml });
    }
    recent.unshift({ title: article.title, slug, type: "earnings", status: body.status, read: article.read, createdMs, content: article.documentHtml });
    return { id, slug, url: `https://marketcatalyst.ai/posts/${slug}`, createdMs };
  }

  /**
   * The company's results release from its Form 8-K (Exhibit 99.1), found
   * through FMP's SEC filings feed. Used only when it states FMP's revenue,
   * which confirms it is this report's release. Null when there is none.
   */
  private async release(symbol: string, reportDate: string, revenue: number): Promise<string | null> {
    const ua = getSecUserAgent();
    if (!ua) return null;
    const from = new Date(Date.parse(`${reportDate}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
    const filings = (await this.fmp.request(`sec-filings-search/symbol?symbol=${symbol}&from=${from}&to=${etDate()}`)) as Array<Record<string, unknown>>;
    const eightKs = filings
      .filter((f) => String(f.formType ?? "").toUpperCase().startsWith("8-K") && typeof f.finalLink === "string")
      .sort((a, b) => String(b.acceptedDate ?? "").localeCompare(String(a.acceptedDate ?? "")));
    const get = async (url: string) => {
      const res = await fetch(url, { headers: { "User-Agent": ua }, signal: AbortSignal.timeout(12_000) });
      if (!res.ok) throw new Error(`SEC ${res.status}`);
      return res.text();
    };
    for (const f of eightKs.slice(0, 3)) {
      const link = String(f.finalLink);
      const urls = [link];
      // The link may be the 8-K cover rather than the exhibit: also try the
      // filing's EX-99 documents.
      const dir = link.slice(0, link.lastIndexOf("/"));
      try {
        const idx = JSON.parse(await get(`${dir}/index.json`)) as { directory?: { item?: Array<{ name?: string }> } };
        for (const it of idx.directory?.item ?? []) {
          const n = String(it.name ?? "");
          if (/\.htm/i.test(n) && /99|press|release|earn|result/i.test(n) && `${dir}/${n}` !== link) urls.push(`${dir}/${n}`);
        }
      } catch {
        /* index is optional */
      }
      for (const u of urls.slice(0, 4)) {
        const text = htmlToText(await get(u));
        if (/quarter/i.test(text) && /revenue|sales/i.test(text) && releaseStatesRevenue(text, revenue)) return text;
      }
    }
    return null;
  }

  private async profile(symbol: string): Promise<Profile | null> {
    const rows = (await this.fmp.request(`profile?symbol=${symbol}`)) as Array<Record<string, unknown>>;
    const p = rows[0];
    if (!p) return null;
    return {
      symbol,
      companyName: String(p.companyName ?? symbol),
      sector: (p.sector as string) ?? null,
      industry: (p.industry as string) ?? null,
      exchange: (p.exchange as string) ?? null,
      cik: (p.cik as string) ?? null,
      isEtf: p.isEtf === true,
      isFund: p.isFund === true,
      isActivelyTrading: p.isActivelyTrading !== false,
    };
  }

  /** The 60 newest posts, without their stored document (only what matching and cards need). */
  private async recentPosts(): Promise<RecentPost[]> {
    const snap = await this.db
      .collection("posts")
      .orderBy("createdAt", "desc")
      .limit(60)
      .select("title", "slug", "type", "status", "read", "createdAt", "content")
      .get();
    return snap.docs.map((d) => {
      const x = d.data();
      return {
        title: String(x.title ?? ""),
        slug: String(x.slug ?? ""),
        type: String(x.type ?? ""),
        status: String(x.status ?? ""),
        read: String(x.read ?? ""),
        createdMs: x.createdAt?.toMillis?.() ?? 0,
        content: String(x.content ?? ""),
      };
    });
  }

  private async seenByDate(dates: string[]): Promise<Map<string, Record<string, string>>> {
    const out = new Map<string, Record<string, string>>();
    const snaps = await this.db.getAll(...dates.map((d) => this.db.collection(DAYS).doc(d)));
    snaps.forEach((s, i) => out.set(dates[i], ((s.data()?.seen as Record<string, string>) ?? {})));
    return out;
  }

  private async mark(marks: Array<{ date: string; symbol: string; value: string }>): Promise<void> {
    if (!marks.length) return;
    const byDate = new Map<string, Record<string, string>>();
    for (const m of marks) {
      byDate.set(m.date, { ...(byDate.get(m.date) ?? {}), [m.symbol]: m.value });
      this.handled.add(`${m.date}|${m.symbol}`);
    }
    const batch = this.db.batch();
    for (const [date, seen] of byDate) batch.set(this.db.collection(DAYS).doc(date), { seen, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await batch.commit();
  }

  /** Marks every currently reported row as handled without posting. */
  private async seed(reported: Reported[]): Promise<number> {
    await this.mark(reported.map((r) => ({ date: r.date, symbol: r.symbol, value: "baseline" })));
    return reported.length;
  }

  /**
   * Exactly-once claim on a company's report. A claim left by a run that
   * died is taken over after STALE_CLAIM_MS; a failure is retried up to
   * MAX_ATTEMPTS times.
   */
  private async claim(docId: string, row: Reported): Promise<"claimed" | "busy" | string> {
    const ref = this.db.collection(ARTICLES).doc(docId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      if (!snap.exists) {
        tx.create(ref, { symbol: row.symbol, reportDate: row.date, status: "claimed", claimedAtMs: now, attempts: 1, createdAt: FieldValue.serverTimestamp() });
        return "claimed";
      }
      const d = snap.data() ?? {};
      const attempts = Number(d.attempts ?? 1);
      if (d.status === "posted") return "posted";
      if (d.status === "skipped") return `skipped:${String(d.reason ?? "earlier")}`;
      if (d.status === "failed" && attempts >= MAX_ATTEMPTS) return "skipped:failed";
      const takeOver =
        (d.status === "claimed" && now - Number(d.claimedAtMs ?? 0) > STALE_CLAIM_MS) || d.status === "failed";
      if (!takeOver) return "busy";
      tx.update(ref, { status: "claimed", claimedAtMs: now, attempts: attempts + 1 });
      return "claimed";
    });
  }
}

