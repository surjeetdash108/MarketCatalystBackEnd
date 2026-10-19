import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  fmpInsiderRows,
  form4InsiderRows,
  type InsiderRow,
} from "../common/insider-rows.util";
import { getTickerToCik } from "../common/sec-cik-map.util";
import type { AnalystRatingsAdapter } from "../adapters/analyst-ratings.adapter";
import { ANALYST_RATINGS_ADAPTER } from "../adapters/types";
import { FmpService, filedThirteenFQuarters } from "../vendors/fmp/fmp.service";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { SecEdgarService } from "../vendors/sec-edgar/sec-edgar.service";
import { toFmpSymbol } from "../vendors/market-data/fmp-mapping.util";

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
const INSIDER_TTL_MS = 12 * 3600_000;
const ANALYST_TTL_MS = 12 * 3600_000;
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

  /**
   * Market-wide latest insider transactions from FMP's insider-trading/latest feed,
   * cached for 10 minutes.
   */
  async getMarketWideInsiderTransactions(): Promise<InsiderRow[]> {
    const doc = await this.cached("market_wide_insider", "latest", 10 * 60_000, async () => {
      let rows: InsiderRow[] = [];
      try {
        const raw = await this.fmp.getLatestInsiderTrading(0, 100);
        if (Array.isArray(raw) && raw.length > 0) {
          rows = fmpInsiderRows("", raw);
        }
      } catch (err) {
        this.logger.warn(`market-wide insider FMP failed (${errMessage(err)})`);
      }
      return { rows, updatedAt: new Date().toISOString() };
    });
    return ((doc?.rows as InsiderRow[] | undefined) ?? []).map((r) => ({ ...r }));
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
        recentGrades: c.recentGrades,
        source: this.ratings.sourceName,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  private marketWideAnalystCache: { expires: number; data: Doc[] } | null = null;

  async getMarketWideAnalystActions(baseDocs: Doc[]): Promise<Doc[]> {
    const now = Date.now();
    if (this.marketWideAnalystCache && this.marketWideAnalystCache.expires > now) {
      return this.marketWideAnalystCache.data;
    }
    if (!this.fmp?.enabled) return baseDocs;
    try {
      const [latestGrades, latestPts] = await Promise.all([
        this.fmp.getLatestGrades(0, 50).catch(() => []),
        this.fmp.getLatestPriceTargets(0, 50).catch(() => []),
      ]);

      const docMap = new Map<string, Doc>();
      for (const d of baseDocs) {
        if (d.ticker) docMap.set(String(d.ticker).toUpperCase().trim(), { ...d });
      }

      const ptBySym = new Map<string, number>();
      for (const pt of latestPts) {
        if (pt.symbol && pt.priceTarget != null && !ptBySym.has(pt.symbol.toUpperCase())) {
          ptBySym.set(pt.symbol.toUpperCase(), pt.priceTarget);
        }
      }

      for (const g of latestGrades) {
        if (!g.symbol) continue;
        const sym = g.symbol.toUpperCase().trim();
        const actionItem = {
          date: g.date ?? new Date().toISOString().slice(0, 10),
          firm: g.gradingCompany ?? null,
          previousGrade: g.previousGrade ?? null,
          newGrade: g.newGrade ?? null,
          action: g.action ?? null,
          priceTarget: g.priceTarget ?? ptBySym.get(sym) ?? null,
        };

        const existing = docMap.get(sym);
        if (existing) {
          const grades = Array.isArray(existing.recentGrades) ? [...existing.recentGrades] : [];
          const dup = grades.some(
            (rg: any) => rg.firm === actionItem.firm && rg.date === actionItem.date,
          );
          if (!dup) {
            grades.unshift(actionItem);
            existing.recentGrades = grades.slice(0, 20);
          }
        } else {
          docMap.set(sym, {
            id: sym,
            ticker: sym,
            consensus: g.newGrade ?? "Hold",
            strongBuy: 0,
            buy: /buy|overweight|outperform/i.test(g.newGrade ?? "") ? 1 : 0,
            hold: /hold|neutral|equal-weight/i.test(g.newGrade ?? "") ? 1 : 0,
            sell: /sell|underweight|underperform/i.test(g.newGrade ?? "") ? 1 : 0,
            strongSell: 0,
            priceTargetConsensus: ptBySym.get(sym) ?? g.priceTarget ?? null,
            recentGrades: [actionItem],
            source: "fmp",
            updatedAt: new Date().toISOString(),
          });
        }
      }

      const merged = Array.from(docMap.values());
      this.marketWideAnalystCache = { expires: now + 300_000, data: merged };
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
        },
        holders,
      };
    }
    return null;
  }
}
