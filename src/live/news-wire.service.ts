import { Injectable, Logger } from "@nestjs/common";
import { FmpService } from "../vendors/fmp/fmp.service";
import { fmpEasternToUtcIso } from "../common/date.util";
import { categoriseNews } from "../common/news-category.util";
import { isFillerNews } from "../common/news-filler.util";
import { idFromUrl, normSentiment } from "../adapters/fmp-news.adapter";

/** Stories kept in memory (newest first). */
const KEEP = 1000;
/** Stories a first read (no cursor) returns. */
const BACKLOG = 300;
const DAY = 86_400_000;

/** What a wire row is — the UI badges each kind. */
export type WireKind = "news" | "press" | "analyst" | "filing" | "macro";

export type WireDoc = Record<string, unknown> & {
  id: string;
  ticker: string;
  headline: string;
  url: string;
  publishedAt: string;
  /** Server time this instance first saw the story — the `since` cursor (a
   *  late 8-K or analyst row can carry an OLDER publish time than stories
   *  already shown, so publish time cannot be the cursor). */
  seenAt: number;
  wireKind: WireKind;
};

type Row = Record<string, unknown>;
type Draft = Record<string, unknown> & Pick<WireDoc, "ticker" | "headline" | "url" | "publishedAt" | "wireKind">;

interface Source {
  name: string;
  /** Fewest ms between upstream polls of this source. */
  everyMs: number;
  fetch: (fmp: FmpService) => Promise<Draft[]>;
}

const etDay = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));
const str = (v: unknown) => (v == null ? "" : String(v).trim());
const money = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}` : null;
};

/** FMP `news/*-latest` row → draft (stock news, press releases, macro news share one shape). */
function newsDraft(r: Row, kind: WireKind): Draft | null {
  const url = str(r.url);
  const headline = str(r.title);
  const ticker = kind === "macro" ? "" : str(r.symbol).toUpperCase();
  if (!url || !headline || (kind !== "macro" && !ticker)) return null;
  const summary = r.text ? str(r.text).slice(0, 400) : null;
  const source = str(r.site) || str(r.publisher) || "FMP";
  return {
    ticker,
    headline,
    summary,
    source,
    vendor: "fmp",
    url,
    category: kind === "macro" ? "macro" : null,
    tag: categoriseNews(headline, summary),
    filler: isFillerNews(headline, summary, source),
    sentiment: normSentiment((r.sentiment as string) ?? null),
    sentimentReasoning: null,
    keywords: [],
    imageUrl: (r.image as string) ?? null,
    publishedAt: fmpEasternToUtcIso(str(r.publishedDate) || str(r.date)),
    wireKind: kind,
  };
}

const latestNews = (path: string, kind: WireKind) => async (fmp: FmpService) =>
  ((await fmp.request(path, { timeoutMs: 8_000, retries: 1 })) as Row[])
    .map((r) => newsDraft(r, kind))
    .filter((d): d is Draft => d != null);

/**
 * Analyst calls as they publish: FMP's latest grade changes and price-target
 * posts, joined on the article they came from (one story, one row), e.g.
 * "Exane BNP Paribas: Outperform → Outperform · PT $117 (stock $139 when posted)".
 */
async function analystCalls(fmp: FmpService): Promise<Draft[]> {
  const opts = { timeoutMs: 8_000, retries: 1 };
  const [grades, targets] = await Promise.all([
    fmp.request("grades-latest-news?page=0&limit=100", opts).catch(() => [] as unknown[]),
    fmp.request("price-target-latest-news?page=0&limit=100", opts).catch(() => [] as unknown[]),
  ]);
  const byUrl = new Map<string, { g?: Row; t?: Row }>();
  for (const g of grades as Row[]) {
    const u = str(g.newsURL);
    if (u) byUrl.set(u, { ...byUrl.get(u), g });
  }
  for (const t of targets as Row[]) {
    const u = str(t.newsURL);
    if (u) byUrl.set(u, { ...byUrl.get(u), t });
  }
  const out: Draft[] = [];
  for (const [url, { g, t }] of byUrl) {
    const r = (g ?? t) as Row;
    const ticker = str(r.symbol).toUpperCase();
    const headline = str(r.newsTitle);
    if (!ticker || !headline) continue;
    const parts: string[] = [];
    const firm = str(g?.gradingCompany) || str(t?.analystCompany);
    if (g && str(g.newGrade)) {
      const prev = str(g.previousGrade);
      parts.push(`${firm}: ${prev && prev !== str(g.newGrade) ? `${prev} → ` : ""}${str(g.newGrade)}${str(g.action) ? ` (${str(g.action)})` : ""}`);
    }
    const pt = money(t?.priceTarget);
    if (pt) {
      const who = [str(t?.analystName), g ? "" : firm].filter(Boolean).join(", ");
      const posted = money(t?.priceWhenPosted);
      parts.push(`PT ${pt}${who ? ` (${who})` : ""}${posted ? ` · stock ${posted} when posted` : ""}`);
    }
    out.push({
      ticker,
      headline,
      summary: parts.join(" · ") || null,
      source: str(r.newsPublisher) || firm || "FMP",
      vendor: "fmp",
      url,
      category: null,
      tag: "analyst",
      filler: false,
      sentiment: null,
      sentimentReasoning: null,
      keywords: [],
      imageUrl: null,
      publishedAt: fmpEasternToUtcIso(str(r.publishedDate)),
      wireKind: "analyst",
    });
  }
  return out;
}

/** 8-Ks as EDGAR accepts them (today + yesterday ET, newest first). */
async function eightKs(fmp: FmpService): Promise<Draft[]> {
  const now = Date.now();
  const rows = (await fmp.request(
    `sec-filings-8k?from=${etDay(now - DAY)}&to=${etDay(now)}&page=0&limit=100`,
    { timeoutMs: 8_000, retries: 1 },
  )) as Row[];
  // One filing is listed once per share class (OASP, OASPW warrants …) —
  // keep it under the shortest symbol, i.e. the common stock.
  const byLink = new Map<string, Row>();
  for (const r of rows) {
    const link = str(r.finalLink) || str(r.link);
    const cur = byLink.get(link);
    if (!cur || str(r.symbol).length < str(cur.symbol).length) byLink.set(link, r);
  }
  const out: Draft[] = [];
  for (const r of byLink.values()) {
    const ticker = str(r.symbol).toUpperCase();
    const url = str(r.finalLink) || str(r.link);
    const accepted = str(r.acceptedDate) || str(r.filingDate);
    if (!ticker || !url || !accepted) continue;
    const fin = r.hasFinancials === true;
    const form = str(r.formType) || "8-K";
    out.push({
      ticker,
      headline: fin
        ? `Files ${form} with financial statements (results / financial update)`
        : `Files ${form} — material event report`,
      summary: "Filed with the SEC on EDGAR. Open the filing for the reported items.",
      source: "SEC EDGAR",
      vendor: "fmp",
      url,
      category: null,
      tag: fin ? "earnings" : "other",
      filler: false,
      sentiment: null,
      sentimentReasoning: null,
      keywords: [],
      imageUrl: null,
      publishedAt: fmpEasternToUtcIso(accepted),
      wireKind: "filing",
    });
  }
  return out;
}

const SOURCES: Source[] = [
  { name: "stock news", everyMs: 15_000, fetch: latestNews("news/stock-latest?page=0&limit=250", "news") },
  { name: "press releases", everyMs: 15_000, fetch: latestNews("news/press-releases-latest?page=0&limit=250", "press") },
  { name: "analyst calls", everyMs: 30_000, fetch: analystCalls },
  { name: "8-K filings", everyMs: 30_000, fetch: eightKs },
  { name: "macro news", everyMs: 30_000, fetch: latestNews("news/general-latest?page=0&limit=100", "macro") },
];

/**
 * Live news wire for the Intraday commentary tape (Briefing "In Play" style):
 * stock news, press releases, analyst calls, 8-K filings and macro news, each
 * from FMP's "latest" feed.
 *
 * Each source is polled at most every `everyMs`, lazily on reads (no timer — an
 * idle instance makes no calls), and concurrent readers share one in-flight
 * request per source, so FMP traffic does not grow with viewers. News rows are
 * shaped like the `news` collection's docs (same id scheme as news.job +
 * FmpNewsAdapter, same tag/filler rules) so the UI merges them with the synced
 * feed without duplicates. The same story from two feeds (a press release also
 * carried as stock news) is kept once — whichever feed delivered it first.
 */
@Injectable()
export class NewsWireService {
  private readonly logger = new Logger(NewsWireService.name);
  private readonly byUrl = new Map<string, WireDoc>();
  /** ticker|headline — catches one release served under two URLs. */
  private readonly byTitle = new Set<string>();
  private readonly lastPoll = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly fmp: FmpService) {}

  /**
   * Stories newest first. With `since` (the `now` of a previous answer), only
   * stories this instance first saw at or after it — including late-published
   * ones the caller has never been sent. `>=` may resend a story seen in the
   * same millisecond as that answer (callers dedupe by URL); `>` could drop one.
   */
  async latest(since?: string): Promise<{ now: number; polledAt: string | null; items: WireDoc[] }> {
    await this.refresh();
    const now = Date.now();
    const cursor = Number(since);
    const all = [...this.byUrl.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    const items = Number.isFinite(cursor) && cursor > 0
      ? all.filter((d) => d.seenAt >= cursor)
      : all.slice(0, BACKLOG);
    const last = Math.max(0, ...this.lastPoll.values());
    return { now, polledAt: last ? new Date(last).toISOString() : null, items };
  }

  private async refresh(): Promise<void> {
    if (!this.fmp.enabled) return;
    const now = Date.now();
    await Promise.all(
      SOURCES.filter((s) => now - (this.lastPoll.get(s.name) ?? 0) >= s.everyMs).map((s) => {
        let p = this.inflight.get(s.name);
        if (!p) {
          p = this.poll(s).finally(() => this.inflight.delete(s.name));
          this.inflight.set(s.name, p);
        }
        return p;
      }),
    );
  }

  private async poll(source: Source): Promise<void> {
    try {
      const drafts = await source.fetch(this.fmp);
      const seenAt = Date.now();
      const updatedAt = new Date(seenAt).toISOString();
      for (const d of drafts) {
        const titleKey = `${d.ticker}|${d.headline.toLowerCase()}`;
        if (this.byUrl.has(d.url) || this.byTitle.has(titleKey)) continue;
        const id = d.ticker ? `${d.ticker}_${idFromUrl(d.url)}` : `wire_${idFromUrl(d.url)}`;
        this.byUrl.set(d.url, { ...d, id, seenAt, updatedAt });
        this.byTitle.add(titleKey);
      }
      if (this.byUrl.size > KEEP) this.trim();
    } catch (err) {
      // Keep serving what we have; the next read after everyMs retries.
      this.logger.warn(`news wire ${source.name} poll failed: ${(err as Error)?.message ?? err}`);
    } finally {
      this.lastPoll.set(source.name, Date.now());
    }
  }

  private trim() {
    const keep = [...this.byUrl.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, KEEP);
    this.byUrl.clear();
    this.byTitle.clear();
    for (const d of keep) {
      this.byUrl.set(d.url, d);
      this.byTitle.add(`${d.ticker}|${d.headline.toLowerCase()}`);
    }
  }
}
