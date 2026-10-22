import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  fmpInsiderRows,
  form4InsiderRows,
  type InsiderRow,
} from "../common/insider-rows.util";
import { getTickerToCik } from "../common/sec-cik-map.util";
import { canonicalFirm, headlinePreviousTarget, headlineTarget, type AnalystRatingsAdapter } from "../adapters/analyst-ratings.adapter";
import { ANALYST_RATINGS_ADAPTER } from "../adapters/types";
import { FmpService, filedThirteenFQuarters } from "../vendors/fmp/fmp.service";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { SecEdgarService } from "../vendors/sec-edgar/sec-edgar.service";
import { fromFmpSymbol, isUsSymbol, toFmpSymbol } from "../vendors/market-data/fmp-mapping.util";

/**
 * How far back a stock's insider history reaches, and the most rows kept. The
 * row cap keeps the per-ticker cache doc well under Firestore's 1 MB limit
 * (~400 B a row).
 */
export const INSIDER_LOOKBACK_YEARS = 10;
export const INSIDER_MAX_ROWS = 1_500;
const INSIDER_PAGE_SIZE = 100;
/** FMP pages fetched at once while walking back through a ticker's history. */
const INSIDER_PAGE_CONCURRENCY = 4;
/** SEC fallback reads one filing per request (rate-limited), so it stays shallow. */
const SEC_FALLBACK_FILINGS = 40;
/** Market-wide feed windows: purchases are the signal and rare; sales are ~10× as frequent. */
const MARKET_BUY_DAYS = 90;
const MARKET_SELL_DAYS = 30;
/** Page cap per transaction type (100 rows a page; ~40 pages ≈ 90 days of purchases). */
const MARKET_INSIDER_MAX_PAGES = 48;
const MARKET_INSIDER_TTL_MS = 30 * 60_000;
/** Pages of FMP's market-wide latest rating changes (100 each) merged into the feed. */
const MARKET_GRADES_PAGES = 3;
/** Most untracked stocks given a real FMP consensus per refresh (each cached 12h). */
const MARKET_UNTRACKED_MAX = 60;
/** Fewest analysts behind an untracked stock's consensus — one rating is not a consensus. */
const MIN_CONSENSUS_ANALYSTS = 2;
/** Foreign OTC lines (ADRs "…Y", foreign ordinaries "…F") — not covered elsewhere in the app. */
const FOREIGN_OTC = /^[A-Z]{4}[FY]$/;
const INSIDER_TTL_MS = 12 * 3600_000;
const ANALYST_TTL_MS = 12 * 3600_000;
/** Same firm key as the analyst-firm-stats job ("J.P. Morgan" → "jpmorgan"). */
const firmCallKey = (name: unknown) =>
  String(name ?? "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const OWNERSHIP_TTL_MS = 24 * 3600_000;
const MEM_TTL_MS = 5 * 60_000;
const TOP_HOLDERS = 25;

type Doc = Record<string, unknown>;

const isFresh = (doc: Doc | undefined, ttlMs: number) => {
  const at = typeof doc?.updatedAt === "string" ? Date.parse(doc.updatedAt) : NaN;
  return Number.isFinite(at) && Date.now() - at < ttlMs;
};

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Per-ticker data for the stock page that used to exist only for the tickers a
 * nightly job happened to sweep (insider trades: a fixed 241-name list).
 * Every method is FMP-first with a fallback, cache-aside on Firestore, and
 * coalesces concurrent requests for the same ticker into one vendor fetch.
 */
@Injectable()
export class StockDetailsService {
  private readonly logger = new Logger(StockDetailsService.name);
  private readonly mem = new Map<string, { data: Doc; at: number }>();
  private readonly inflight = new Map<string, Promise<Doc | null>>();

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly fmp: FmpService,
    private readonly polygon: PolygonService,
    private readonly secEdgar: SecEdgarService,
    @Optional()
    @Inject(ANALYST_RATINGS_ADAPTER)
    private readonly ratings: AnalystRatingsAdapter | null,
  ) {}

  /**
   * Cache-aside wrapper: memory (5 min) → Firestore doc while fresh → `build`.
   * A failed build serves the stored doc at any age rather than nothing.
   */
  private async cached(
    collection: string,
    ticker: string,
    ttlMs: number,
    build: (stored: Doc | undefined) => Promise<Doc | null>,
  ): Promise<Doc | null> {
    const key = `${collection}/${ticker}`;
    const mem = this.mem.get(key);
    if (mem && Date.now() - mem.at < MEM_TTL_MS) return mem.data;

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const p = (async () => {
      const ref = this.firebase.firestore.collection(collection).doc(ticker);
      const stored = (await ref.get().catch(() => null))?.data() as Doc | undefined;
      if (stored && isFresh(stored, ttlMs)) {
        this.mem.set(key, { data: stored, at: Date.now() });
        return stored;
      }
      let built: Doc | null = null;
      try {
        built = await build(stored);
      } catch (err) {
        this.logger.warn(`${key}: refresh failed (${errMessage(err)}) — serving stored copy`);
      }
      if (!built) return stored ?? null;
      await ref.set(built, { merge: true }).catch((err) =>
        this.logger.warn(`${key}: cache write failed: ${errMessage(err)}`),
      );
      this.mem.set(key, { data: built, at: Date.now() });
      return built;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  // ── Insider transactions ────────────────────────────────────────────────

  /**
   * Every insider transaction for a ticker over INSIDER_LOOKBACK_YEARS, newest
   * first: FMP's insider-trading feed, SEC EDGAR Form 4s when FMP errors or has
   * none. Cached per ticker in `insider_by_ticker/{ticker}`.
   */
  async getInsiderTransactions(ticker: string): Promise<InsiderRow[]> {
    const doc = await this.cached("insider_by_ticker", ticker, INSIDER_TTL_MS, async () => {
      let rows: InsiderRow[] = [];
      let source = "fmp";
      try {
        rows = await this.fmpInsiderHistory(ticker);
      } catch (err) {
        this.logger.warn(`insider ${ticker}: FMP failed (${errMessage(err)}) — SEC Form 4 fallback`);
      }
      if (rows.length === 0) {
        rows = await this.secInsiderHistory(ticker);
        source = "sec";
      }
      return { ticker, source, rows, updatedAt: new Date().toISOString() };
    });
    return ((doc?.rows as InsiderRow[] | undefined) ?? []).map((r) => ({ ...r }));
  }

  private marketInsider: { at: number; rows: InsiderRow[] } | null = null;
  private marketInsiderLoading: Promise<InsiderRow[]> | null = null;

  /**
   * Recent open-market insider trades across every US listing, newest first:
   * FMP purchases (code P) over MARKET_BUY_DAYS and sales (code S) over
   * MARKET_SELL_DAYS. Sales are ~10× as frequent, so their window is shorter
   * to keep the feed small; awards, tax withholding and gifts are left out —
   * the Insider screen and dashboard rank open-market buying and selling.
   *
   * Cached per instance for MARKET_INSIDER_TTL_MS; a stale copy is served while
   * a refresh runs, so only a cold start waits on FMP. Empty when FMP is off
   * or fails cold — the caller then falls back to the SEC Form 4 collection.
   */
  async getMarketWideInsiderTransactions(): Promise<InsiderRow[]> {
    const cached = this.marketInsider;
    if (cached && Date.now() - cached.at < MARKET_INSIDER_TTL_MS) return cached.rows;
    if (!this.fmp.enabled) return cached?.rows ?? [];
    this.marketInsiderLoading ??= this.loadMarketInsiderTrades()
      .then((rows) => {
        // Never replace a good feed with an empty one from a vendor hiccup.
        if (rows.length > 0 || !this.marketInsider) this.marketInsider = { at: Date.now(), rows };
        return rows;
      })
      .finally(() => {
        this.marketInsiderLoading = null;
      });
    if (cached) {
      this.marketInsiderLoading.catch((err) =>
        this.logger.warn(`market insider refresh failed: ${errMessage(err)}`),
      );
      return cached.rows;
    }
    try {
      return await this.marketInsiderLoading;
    } catch (err) {
      this.logger.warn(`market-wide insider feed: FMP failed (${errMessage(err)}) — SEC fallback`);
      return [];
    }
  }

  private async loadMarketInsiderTrades(): Promise<InsiderRow[]> {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const walk = async (type: string, days: number): Promise<Record<string, unknown>[]> => {
      const cutoff = daysAgo(days);
      const out: Record<string, unknown>[] = [];
      for (let start = 0; start < MARKET_INSIDER_MAX_PAGES; start += INSIDER_PAGE_CONCURRENCY) {
        const pages = await Promise.all(
          Array.from({ length: INSIDER_PAGE_CONCURRENCY }, (_, i) =>
            this.fmp.getMarketInsiderTrades(type, start + i, INSIDER_PAGE_SIZE),
          ),
        );
        let done = false;
        for (const page of pages) {
          out.push(...page);
          const oldest = String(page[page.length - 1]?.filingDate ?? "");
          if (page.length < INSIDER_PAGE_SIZE || (oldest && oldest < cutoff)) done = true;
        }
        if (done) break;
      }
      // Late or amended filings can carry years-old trades; keep the window by
      // trade date as well as filing date.
      return out.filter(
        (r) => String(r.filingDate ?? "") >= cutoff && String(r.transactionDate ?? "") >= cutoff,
      );
    };
    const [buys, sells] = await Promise.all([
      walk("P-Purchase", MARKET_BUY_DAYS),
      walk("S-Sale", MARKET_SELL_DAYS),
    ]);
    const rows: InsiderRow[] = [];
    for (const r of [...buys, ...sells]) {
      const symbol = String(r.symbol ?? "").toUpperCase();
      if (!isUsSymbol(symbol)) continue;
      const [row] = fmpInsiderRows(fromFmpSymbol(symbol), [r]);
      // Ranked by dollars, so only priced trades. Short id and no filing link
      // keep ~9k rows light for the browser; per-stock feeds carry the links.
      if (row && row.pricePerShare != null) {
        const { url: _url, ...lean } = row;
        rows.push({ ...lean, id: `m${rows.length}` });
      }
    }
    return rows.sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));
  }

  private async fmpInsiderHistory(ticker: string): Promise<InsiderRow[]> {
    if (!this.fmp.enabled) return [];
    const symbol = toFmpSymbol(ticker);
    const cutoff = new Date();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - INSIDER_LOOKBACK_YEARS);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    const maxPages = Math.ceil(INSIDER_MAX_ROWS / INSIDER_PAGE_SIZE);

    const raw: Record<string, unknown>[] = [];
    for (let start = 0; start < maxPages; start += INSIDER_PAGE_CONCURRENCY) {
      const pages = await Promise.all(
        Array.from({ length: Math.min(INSIDER_PAGE_CONCURRENCY, maxPages - start) }, (_, i) =>
          this.fmp.getInsiderTrades(symbol, start + i, INSIDER_PAGE_SIZE),
        ),
      );
      let done = false;
      for (const page of pages) {
        raw.push(...page);
        const oldest = String(page[page.length - 1]?.transactionDate ?? "");
        // A short page is the last one; a page reaching past the cutoff ends the walk.
        if (page.length < INSIDER_PAGE_SIZE || (oldest && oldest < cutoffDate)) done = true;
      }
      if (done) break;
    }
    return fmpInsiderRows(ticker, raw)
      .filter((r) => r.transactionDate >= cutoffDate)
      .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate))
      .slice(0, INSIDER_MAX_ROWS);
  }

  private async secInsiderHistory(ticker: string): Promise<InsiderRow[]> {
    const cik = (
      await getTickerToCik(this.firebase.firestore, "Market Catalyst Backend hello@inc108.com")
    ).get(ticker);
    if (!cik) return [];
    const { recentFilings } = await this.secEdgar.getSubmissions(cik);
    const rows: InsiderRow[] = [];
    for (const f of recentFilings.filter((x) => x.form === "4").slice(0, SEC_FALLBACK_FILINGS)) {
      try {
        const parsed = await this.secEdgar.getForm4Transactions(cik, f.accessionNumber);
        rows.push(...form4InsiderRows(ticker, f.accessionNumber, f.filingDate, parsed));
      } catch (err) {
        this.logger.debug(`insider ${ticker}: Form 4 ${f.accessionNumber} unreadable: ${errMessage(err)}`);
      }
    }
    return rows
      .filter((r) => r.shares > 0 && r.transactionDate)
      .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));
  }

  // ── Analyst consensus ───────────────────────────────────────────────────

  /**
   * Consensus, price targets and recent grades for one ticker, in the
   * `analyst_actions` doc shape the nightly sweep writes (same collection, so
   * either path fills it). FMP on demand when the doc is missing or stale; the
   * stored doc otherwise — Polygon's analyst ratings are not on this plan.
   */
  async getAnalystConsensus(ticker: string): Promise<Doc | null> {
    return this.cached("analyst_actions", ticker, ANALYST_TTL_MS, async () => {
      if (!this.ratings) return null;
      const c = await this.ratings.getConsensus(toFmpSymbol(ticker));
      if (!c) return null;
      const history = await this.getAnalystHistory(ticker).catch(() => []);
      return {
        ticker,
        consensus: c.consensus,
        strongBuy: c.strongBuy,
        buy: c.buy,
        hold: c.hold,
        sell: c.sell,
        strongSell: c.strongSell,
        priceTargetConsensus: c.priceTargetConsensus,
        priceTargetHigh: c.priceTargetHigh,
        priceTargetLow: c.priceTargetLow,
        priceTargetMedian: c.priceTargetMedian,
        ptAvgLastMonth: c.ptAvgLastMonth,
        ptAvgLastQuarter: c.ptAvgLastQuarter,
        ptAvgLastYear: c.ptAvgLastYear,
        recentGrades: history.length > 0 ? history : c.recentGrades,
        source: this.ratings.sourceName,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  private readonly gradeHistoryCache = new Map<string, { expires: number; data: Doc[] }>();

  /**
   * Every rating change FMP has on record for one ticker (its `grades` feed
   * returns the full history in one call), newest first, each with the firm's
   * own standing price target. Cached in memory for an hour per ticker.
   */
  async getAnalystHistory(ticker: string): Promise<Doc[]> {
    const hit = this.gradeHistoryCache.get(ticker);
    if (hit && hit.expires > Date.now()) return hit.data;
    if (!this.ratings?.getGradeHistory) return [];
    const rows = (await this.ratings.getGradeHistory(toFmpSymbol(ticker))) as unknown as Doc[];
    this.gradeHistoryCache.set(ticker, { expires: Date.now() + 3600_000, data: rows });
    return rows;
  }

  private firmCallIndex: { expires: number; byFirm: Map<string, Doc[]> } | null = null;

  /**
   * Every stored call by one analyst firm across all measured tickers
   * (`analyst_calls`, written by the analyst-firm-stats job): its rating
   * changes over the last 3 years and its resolved 12-month price targets.
   * Newest first. The index is rebuilt at most every 30 minutes.
   */
  async getFirmCalls(firm: string): Promise<Doc[]> {
    const key = firmCallKey(firm);
    if (!key) return [];
    if (!this.firmCallIndex || this.firmCallIndex.expires <= Date.now()) {
      const snap = await this.firebase.firestore.collection("analyst_calls").get();
      const byFirm = new Map<string, Doc[]>();
      const push = (name: unknown, row: Doc) => {
        const k = firmCallKey(name);
        if (!k) return;
        const list = byFirm.get(k) ?? [];
        list.push(row);
        byFirm.set(k, list);
      };
      for (const d of snap.docs) {
        const x = d.data() as {
          ticker?: string;
          ratingCalls?: Array<{ firm: string; date: string; dir: number; move: number; bullish: boolean }>;
          targetCalls?: Array<{ firm: string; date: string; hit: boolean; ticker?: string; target: number; posted: number }>;
        };
        const ticker = x.ticker ?? d.id;
        for (const c of x.ratingCalls ?? [])
          push(c.firm, { kind: "rating", ticker, date: c.date, dir: c.dir, move: c.move, bullish: c.bullish });
        for (const t of x.targetCalls ?? [])
          push(t.firm, { kind: "target", ticker: t.ticker ?? ticker, date: t.date, dir: t.target >= t.posted ? 1 : -1, target: t.target, priceWhenPosted: t.posted, hit: t.hit });
      }
      for (const list of byFirm.values())
        list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      this.firmCallIndex = { expires: Date.now() + 30 * 60_000, byFirm };
    }
    return this.firmCallIndex.byFirm.get(key) ?? [];
  }

  private marketWideAnalystCache: { expires: number; data: Doc[] } | null = null;

  /**
   * The Analyst Actions feed: the swept `analyst_actions` docs plus FMP's
   * market-wide latest rating changes (`grades-latest-news`), so a call on a
   * stock outside the sweep still appears.
   *
   * Accuracy rules: each change keeps FMP's own publish date; a price target is
   * attached only from the SAME firm's target post on the same day; and a
   * stock not already tracked gets its REAL consensus from FMP (cached 12h in
   * `analyst_actions`) — never one firm's rating presented as a consensus. A
   * stock FMP has no consensus for is left out. US listings only.
   */
  async getMarketWideAnalystActions(baseDocs: Doc[]): Promise<Doc[]> {
    const now = Date.now();
    if (this.marketWideAnalystCache && this.marketWideAnalystCache.expires > now) {
      return this.marketWideAnalystCache.data;
    }
    if (!this.fmp?.enabled) return baseDocs;
    try {
      const pages = await Promise.all(
        Array.from({ length: MARKET_GRADES_PAGES }, (_, i) => this.fmp.getLatestGrades(i, 100).catch(() => [])),
      );
      const ptPages = await Promise.all(
        Array.from({ length: MARKET_GRADES_PAGES }, (_, i) => this.fmp.getLatestPriceTargets(i, 100).catch(() => [])),
      );
      const day = (v: unknown) => String(v ?? "").slice(0, 10);
      // Canonical firm key, so "JP Morgan" (grades) joins "JPMorgan Chase" (targets).
      const firmKey = (v: unknown) => canonicalFirm(v == null ? null : String(v));
      const shiftDay = (iso: string, d: number) =>
        new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
      // Same-firm price targets by day, with the "from" figure its headline states.
      type LatestPt = { raw: string; target: number; previous: number | null; firm: string; date: string };
      const ptByKey = new Map<string, LatestPt>();
      for (const pt of ptPages.flat()) {
        const sym = String(pt.symbol ?? "").toUpperCase();
        const target = Number(pt.priceTarget);
        if (!isUsSymbol(sym) || !Number.isFinite(target) || target <= 0 || !pt.analystCompany) continue;
        const date = day(pt.publishedDate);
        const key = `${sym}|${firmKey(pt.analystCompany)}|${date}`;
        if (ptByKey.has(key)) continue;
        const title = String(pt.newsTitle ?? "");
        const stated = title && headlineTarget(title) === target ? headlinePreviousTarget(title) : null;
        const previous = stated ?? (Number(pt.priceTargetPrevious) > 0 ? Number(pt.priceTargetPrevious) : null);
        ptByKey.set(key, { raw: sym, target, previous, firm: String(pt.analystCompany), date });
      }
      /** A target post for this grade: same day, or a day either side (news lag). */
      const ptFor = (raw: string, firm: unknown, date: string) =>
        ptByKey.get(`${raw}|${firmKey(firm)}|${date}`) ??
        ptByKey.get(`${raw}|${firmKey(firm)}|${shiftDay(date, 1)}`) ??
        ptByKey.get(`${raw}|${firmKey(firm)}|${shiftDay(date, -1)}`) ??
        null;
      const usedPt = new Set<LatestPt>();

      const docMap = new Map<string, Doc>();
      for (const d of baseDocs) {
        if (d.ticker) docMap.set(String(d.ticker).toUpperCase().trim(), { ...d });
      }

      const changesBySym = new Map<string, Array<Record<string, unknown>>>();
      for (const g of pages.flat()) {
        const raw = String(g.symbol ?? "").toUpperCase().trim();
        const date = day(g.publishedDate);
        if (!isUsSymbol(raw) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !g.gradingCompany) continue;
        const sym = fromFmpSymbol(raw);
        const pt = ptFor(raw, g.gradingCompany, date);
        if (pt) usedPt.add(pt);
        const item: Record<string, unknown> = {
          date,
          firm: String(g.gradingCompany),
          previousGrade: g.previousGrade ?? null,
          newGrade: g.newGrade ?? null,
          action: g.action ?? null,
          priceTarget: pt?.target ?? null,
          priceTargetDate: pt ? pt.date : null,
          previousPriceTarget: pt?.previous ?? null,
        };
        const list = changesBySym.get(sym) ?? [];
        list.push(item);
        changesBySym.set(sym, list);
      }

      // Target posts with no grade row (a pure PT raise/cut): their own rows,
      // labelled with the firm's standing rating where the doc knows it.
      for (const pt of ptByKey.values()) {
        if (usedPt.has(pt)) continue;
        const sym = fromFmpSymbol(pt.raw);
        const list = changesBySym.get(sym) ?? [];
        list.push({
          date: pt.date, firm: pt.firm, previousGrade: null, newGrade: null, action: null,
          priceTarget: pt.target, priceTargetDate: pt.date, previousPriceTarget: pt.previous,
        });
        changesBySym.set(sym, list);
      }

      const sameFirm = (a: unknown, b: unknown) => firmKey(a) === firmKey(b);
      const mergeInto = (doc: Doc, items: Array<Record<string, unknown>>) => {
        const grades = Array.isArray(doc.recentGrades) ? (doc.recentGrades as Array<Record<string, unknown>>).map((g) => ({ ...g })) : [];
        for (const it of items) {
          const near = (rg: Record<string, unknown>) =>
            sameFirm(rg.firm, it.firm) &&
            Math.abs(Date.parse(String(rg.date)) - Date.parse(String(it.date))) <= 86_400_000;
          const existing = grades.find(near);
          // The firm's latest standing rating labels a pure target change.
          const standing = grades.find((rg) => sameFirm(rg.firm, it.firm) && rg.newGrade);
          if (!existing) {
            grades.push(it.newGrade == null && standing
              ? { ...it, newGrade: standing.newGrade, previousGrade: standing.newGrade, action: "maintain" }
              : it);
            continue;
          }
          // The market-wide feed's publish timestamp is the call's real date
          // (NVDA Needham: Oct 22 05:50 ET, dated Oct 21 in the per-ticker feed).
          if (it.action != null && String(it.date) > String(existing.date)) existing.date = it.date;
          // A fresh same-day target replaces a target carried forward from an
          // older post (ISRG Evercore 10-21: $430 standing → $385 posted that day).
          if (it.priceTarget != null && existing.priceTarget !== it.priceTarget) {
            const carried = existing.priceTarget as number | null;
            existing.previousPriceTarget = it.previousPriceTarget ?? carried ?? null;
            existing.priceTarget = it.priceTarget;
            existing.priceTargetDate = it.priceTargetDate;
          }
        }
        grades.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
        doc.recentGrades = grades.slice(0, 20);
      };

      const untracked: string[] = [];
      for (const [sym, items] of changesBySym) {
        const existing = docMap.get(sym);
        if (existing) mergeInto(existing, items);
        else if (!FOREIGN_OTC.test(sym)) untracked.push(sym);
      }
      // Real FMP consensus for stocks outside the sweep (bounded per refresh;
      // each is cached 12h, so later refreshes are cheap).
      const toFetch = untracked.slice(0, MARKET_UNTRACKED_MAX);
      for (let i = 0; i < toFetch.length; i += 4) {
        const docs = await Promise.all(
          toFetch.slice(i, i + 4).map((sym) => this.getAnalystConsensus(sym).catch(() => null)),
        );
        docs.forEach((doc, j) => {
          const sym = toFetch[i + j];
          if (!doc || !doc.consensus) return;
          const analysts = ["strongBuy", "buy", "hold", "sell", "strongSell"].reduce((n, k) => n + (Number(doc[k]) || 0), 0);
          if (analysts < MIN_CONSENSUS_ANALYSTS) return;
          const copy: Doc = { id: sym, ...doc, ticker: sym };
          mergeInto(copy, changesBySym.get(sym) ?? []);
          docMap.set(sym, copy);
        });
      }

      const merged = Array.from(docMap.values());
      this.marketWideAnalystCache = { expires: now + 5 * 60_000, data: merged };
      return merged;
    } catch (err) {
      this.logger.warn(`marketWideAnalystActions failed: ${errMessage(err)}`);
      return baseDocs;
    }
  }

  // ── Ownership: institutional (FMP) + short interest (Polygon) ───────────

  /**
   * Institutional summary and top holders from FMP's 13F data for the newest
   * quarter whose filing deadline has passed, plus FINRA short interest from
   * Polygon (FMP has no short-interest feed). Each part is independent: one
   * vendor failing leaves its fields null, not the whole card.
   */
  async getOwnership(ticker: string): Promise<Doc | null> {
    return this.cached("stock_ownership", ticker, OWNERSHIP_TTL_MS, async (stored) => {
      const symbol = toFmpSymbol(ticker);
      const [inst, short] = await Promise.all([
        this.institutional(symbol).catch((err) => {
          this.logger.warn(`ownership ${ticker}: FMP 13F failed: ${errMessage(err)}`);
          return null;
        }),
        this.polygon.getShortInterest(ticker).catch((err) => {
          this.logger.warn(`ownership ${ticker}: Polygon short interest failed: ${errMessage(err)}`);
          return null;
        }),
      ]);
      // Both vendors down: keep what we had rather than caching an empty card.
      if (!inst && !short) return null;
      return {
        ticker,
        institutional: inst?.summary ?? stored?.institutional ?? null,
        topHolders: inst?.holders ?? stored?.topHolders ?? [],
        shortInterest: short ?? stored?.shortInterest ?? null,
        sources: { institutional: inst ? "fmp" : null, shortInterest: short ? "polygon" : null },
        updatedAt: new Date().toISOString(),
      };
    });
  }

  private async institutional(symbol: string) {
    if (!this.fmp.enabled) return null;
    for (const { year, quarter } of filedThirteenFQuarters(3)) {
      const summary = await this.fmp.getInstitutionalOwnership(symbol, year, quarter).catch(() => null);
      if (!summary) continue;
      const holders = (await this.fmp.get13FExtractAnalytics(symbol, year, quarter, 100))
        .map((h: Record<string, unknown>) => ({
          name: String(h.investorName ?? ""),
          cik: h.cik ? String(h.cik) : null,
          shares: Number(h.sharesNumber) || 0,
          sharesChange: Number.isFinite(Number(h.changeInSharesNumber)) ? Number(h.changeInSharesNumber) : null,
          ownershipPct: Number.isFinite(Number(h.ownership)) ? Number(h.ownership) : null,
          marketValue: Number.isFinite(Number(h.marketValue)) ? Number(h.marketValue) : null,
          isNew: h.isNew === true,
          filingDate: h.filingDate ? String(h.filingDate) : null,
        }))
        .filter((h) => h.name && h.shares > 0)
        .sort((a, b) => b.shares - a.shares)
        .slice(0, TOP_HOLDERS);
      return {
        summary: {
          year,
          quarter,
          asOf: `${year} Q${quarter}`,
          ownershipPct: summary.ownershipPercent,
          holders: summary.investorsHolding,
          holdersChange: summary.investorsHoldingChange,
          shares: summary.numberOf13Fshares,
          sharesChangePct:
            summary.numberOf13Fshares != null && summary.lastNumberOf13Fshares
              ? Math.round(((summary.numberOf13Fshares - summary.lastNumberOf13Fshares) / summary.lastNumberOf13Fshares) * 1000) / 10
              : null,
          newPositions: summary.newPositions,
          increasedPositions: summary.increasedPositions,
          reducedPositions: summary.reducedPositions,
          closedPositions: summary.closedPositions,
        },
        holders,
      };
    }
    return null;
  }
}
