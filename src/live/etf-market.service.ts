import { Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { fetchJson } from "../common/http.util";
import { ETFClassifier } from "./etf-classifier";
import {
  ETFCategory,
  EtfCategorySection,
  EtfMarketResponse,
  NormalizedETF,
} from "./etf-model";

const CATEGORY_DEFINITIONS: { id: ETFCategory; label: string }[] = [
  { id: "largest", label: "Largest" },
  { id: "equity", label: "Equity" },
  { id: "bitcoin", label: "Bitcoin" },
  { id: "ethereum", label: "Ethereum" },
  { id: "gold", label: "Gold" },
  { id: "fixedIncome", label: "Fixed Income" },
  { id: "realEstate", label: "Real Estate" },
  { id: "totalMarket", label: "Total Market" },
  { id: "commodities", label: "Commodities" },
  { id: "leveraged", label: "Leveraged" },
];

function fmtAumBadge(aum: number | null | undefined): string {
  if (aum == null || aum <= 0) return "";
  if (aum >= 1e12) return `$${(aum / 1e12).toFixed(1)}T`;
  if (aum >= 1e9) return `$${(aum / 1e9).toFixed(0)}B+`;
  if (aum >= 1e6) return `$${(aum / 1e6).toFixed(0)}M+`;
  return `$${aum.toLocaleString()}`;
}

@Injectable()
export class EtfMarketService implements OnModuleInit {
  private readonly logger = new Logger(EtfMarketService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly etfCornerLimit: number;

  private cachedResponse: EtfMarketResponse | null = null;
  private lastFetchedAt = 0;
  private refreshPromise: Promise<EtfMarketResponse> | null = null;

  // In-memory cache for shares outstanding to avoid re-fetching unchanged share counts
  private readonly sharesCache = new Map<string, number>();

  // 7-day cache TTL: ETF directory classification changes rarely
  private readonly CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
  private readonly FIRESTORE_COLLECTION = "etf_corner_cache";
  private readonly FIRESTORE_DOC = "latest";

  constructor(
    private readonly config: ConfigService,
    private readonly classifier: ETFClassifier,
    @Optional() private readonly firebase?: FirebaseAdminService,
  ) {
    this.apiKey = this.config.get<string>("POLYGON_API_KEY", "");
    this.baseUrl = this.config
      .get<string>("POLYGON_API_BASE_URL", "https://api.massive.com")
      .replace(/\/$/, "");
  }

  async onModuleInit(): Promise<void> {
    // Non-blocking pre-warm on application boot
    this.refreshCache().catch((err) => {
      this.logger.warn(`Initial ETF cache pre-warm failed: ${err.message}`);
    });
  }

  /**
   * Returns categorized, dynamically discovered ETFs across all 10 categories.
   * If limit is specified and > 0, caps each category to that number; otherwise returns all discovered ETFs.
   */
  async getCategorizedEtfs(limit?: number): Promise<EtfMarketResponse> {
    const now = Date.now();
    let baseResponse: EtfMarketResponse;

    if (this.cachedResponse && now - this.lastFetchedAt < this.CACHE_TTL_MS) {
      baseResponse = this.cachedResponse;
    } else {
      if (!this.refreshPromise) {
        this.refreshPromise = this.refreshCache().finally(() => {
          this.refreshPromise = null;
        });
      }
      baseResponse = await this.refreshPromise;
    }

    if (!limit || limit <= 0) {
      return baseResponse;
    }

    return this.applyLimit(baseResponse, limit);
  }

  private applyLimit(base: EtfMarketResponse, limit: number): EtfMarketResponse {
    const sliceList = (list: NormalizedETF[]) => list.slice(0, limit);
    const categories: EtfCategorySection[] = base.categories.map((c) => ({
      id: c.id,
      label: c.label,
      funds: sliceList(c.funds),
    }));

    const largest = sliceList(base.largest);
    const equity = sliceList(base.equity);
    const bitcoin = sliceList(base.bitcoin);
    const ethereum = sliceList(base.ethereum);
    const gold = sliceList(base.gold);
    const fixedIncome = sliceList(base.fixedIncome);
    const realEstate = sliceList(base.realEstate);
    const totalMarket = sliceList(base.totalMarket);
    const commodities = sliceList(base.commodities);
    const leveraged = sliceList(base.leveraged);

    return {
      ...base,
      categories,
      largest,
      equity,
      bitcoin,
      ethereum,
      gold,
      fixedIncome,
      "fixed-income": fixedIncome,
      "fixed_income": fixedIncome,
      realEstate,
      "real-estate": realEstate,
      "real_estate": realEstate,
      totalMarket,
      "total-market": totalMarket,
      "total_market": totalMarket,
      commodities,
      leveraged,
    };
  }

  /**
   * Refreshes the ETF universe and snapshot from Polygon/Massive, runs the
   * classification engine, sorts by AUM descending, and updates memory and Firestore cache.
   */
  private async refreshCache(): Promise<EtfMarketResponse> {
    const started = Date.now();
    this.logger.log("Refreshing ETF Discovery & Classification via Massive API...");

    try {
      const [universe, snapshotMap] = await Promise.all([
        this.fetchMassiveUniverse(),
        this.fetchMassiveSnapshot(),
      ]);

      // Filter to active traded instruments with positive pricing
      const validEtfs = universe
        .map((item) => {
          const snap = snapshotMap.get(item.ticker);
          const price = snap?.price ?? null;
          return {
            ticker: item.ticker,
            name: item.name,
            type: item.type,
            sic_description: item.sic_description,
            price,
            change: snap?.change ?? null,
            changePct: snap?.changePct ?? null,
            volume: snap?.volume ?? 0,
            dollarVol: (snap?.volume ?? 0) * (price ?? 0),
          };
        })
        .filter((e) => e.price != null && e.price > 0);

      // Bucket candidate ETFs per category using the deterministic ETFClassifier
      const candidateBuckets = new Map<ETFCategory, typeof validEtfs>();
      for (const def of CATEGORY_DEFINITIONS) {
        candidateBuckets.set(def.id, []);
      }

      for (const etf of validEtfs) {
        const categories = this.classifier.classify({
          symbol: etf.ticker,
          name: etf.name,
          type: etf.type,
          sic_description: etf.sic_description,
          volume: etf.volume,
        });

        for (const cat of categories) {
          candidateBuckets.get(cat)?.push(etf);
        }
      }

      // Identify top candidate tickers in each category to fetch shares outstanding / AUM
      const tickersToFetch = new Set<string>();
      for (const def of CATEGORY_DEFINITIONS) {
        const bucket = candidateBuckets.get(def.id) || [];
        // Sort candidate pool by dollar volume to prioritize prominent funds
        bucket.sort((a, b) => b.dollarVol - a.dollarVol);
        const topSlice = bucket.slice(0, 100);
        for (const t of topSlice) {
          if (!this.sharesCache.has(t.ticker)) {
            tickersToFetch.add(t.ticker);
          }
        }
      }

      if (tickersToFetch.size > 0) {
        await this.fetchMissingSharesOutstanding([...tickersToFetch]);
      }

      // Build normalized ETF representations and sort by AUM descending (fallback to volume DESC)
      const categoryMap = new Map<ETFCategory, NormalizedETF[]>();

      for (const def of CATEGORY_DEFINITIONS) {
        const bucket = candidateBuckets.get(def.id) || [];

        const normalizedList: NormalizedETF[] = bucket.map((item) => {
          const shares = this.sharesCache.get(item.ticker) ?? null;
          const aum =
            shares != null && item.price != null ? shares * item.price : null;

          const assignedCategories = this.classifier.classify({
            symbol: item.ticker,
            name: item.name,
            type: item.type,
            sic_description: item.sic_description,
          });

          return {
            symbol: item.ticker,
            name: item.name,
            price: item.price,
            change: item.change,
            changePercent: item.changePct,
            volume: item.volume,
            aum,
            badge: fmtAumBadge(aum),
            categories: assignedCategories,
            provider: "massive-polygon",
            lastUpdated: new Date().toISOString(),
          };
        });

        // Step 10: Sort by AUM DESC, fallback to volume DESC
        normalizedList.sort((a, b) => {
          if (a.aum != null && b.aum != null) {
            return b.aum - a.aum;
          }
          if (a.aum != null) return -1;
          if (b.aum != null) return 1;
          return (b.volume || 0) - (a.volume || 0);
        });

        // Deduplicate each category (unlimited funds)
        const seenSymbols = new Set<string>();
        const fullList: NormalizedETF[] = [];
        for (const etf of normalizedList) {
          if (!seenSymbols.has(etf.symbol)) {
            seenSymbols.add(etf.symbol);
            fullList.push(etf);
          }
        }

        categoryMap.set(def.id, fullList);
      }

      const categories: EtfCategorySection[] = CATEGORY_DEFINITIONS.map(
        (def) => ({
          id: def.id,
          label: def.label,
          funds: categoryMap.get(def.id) || [],
        }),
      );

      const largest = categoryMap.get("largest") || [];
      const equity = categoryMap.get("equity") || [];
      const bitcoin = categoryMap.get("bitcoin") || [];
      const ethereum = categoryMap.get("ethereum") || [];
      const gold = categoryMap.get("gold") || [];
      const fixedIncome = categoryMap.get("fixedIncome") || [];
      const realEstate = categoryMap.get("realEstate") || [];
      const totalMarket = categoryMap.get("totalMarket") || [];
      const commodities = categoryMap.get("commodities") || [];
      const leveraged = categoryMap.get("leveraged") || [];

      const response: EtfMarketResponse = {
        updatedAt: Date.now(),
        source: "massive-polygon",
        categories,
        largest,
        equity,
        bitcoin,
        ethereum,
        gold,
        fixedIncome,
        "fixed-income": fixedIncome,
        "fixed_income": fixedIncome,
        realEstate,
        "real-estate": realEstate,
        "real_estate": realEstate,
        totalMarket,
        "total-market": totalMarket,
        "total_market": totalMarket,
        commodities,
        leveraged,
      };

      this.cachedResponse = response;
      this.lastFetchedAt = Date.now();

      this.persistToFirestore(response).catch((err) => {
        this.logger.warn(`Firestore ETF cache persist failed: ${err.message}`);
      });

      this.logger.log(
        `ETF Discovery & Classification refreshed in ${
          Date.now() - started
        }ms: 10 dynamic categories across ${universe.length} ETF universe`,
      );

      return response;
    } catch (err: any) {
      this.logger.error(`Failed to refresh ETF cache from Massive: ${err.message}`);

      // Try reading fallback from Firestore if network or upstream error occurs
      const fallback = await this.readFromFirestore();
      if (fallback) {
        this.cachedResponse = fallback;
        this.lastFetchedAt = Date.now();
        return fallback;
      }

      if (this.cachedResponse) {
        return this.cachedResponse;
      }

      throw err;
    }
  }

  /**
   * Fetches all active ETF and ETV tickers from Massive reference endpoint.
   */
  private async fetchMassiveUniverse(): Promise<any[]> {
    const allTickers: any[] = [];
    const seen = new Set<string>();

    for (const type of ["ETF", "ETV"]) {
      let url: string | null = `${this.baseUrl}/v3/reference/tickers?market=stocks&type=${type}&active=true&limit=1000&apiKey=${this.apiKey}`;
      while (url) {
        const res = await fetchJson<any>(url, { timeoutMs: 15_000 });
        for (const item of res?.results || []) {
          if (!item.ticker || seen.has(item.ticker) || !item.active) continue;
          seen.add(item.ticker);
          allTickers.push(item);
        }
        url = res?.next_url ? `${res.next_url}&apiKey=${this.apiKey}` : null;
      }
    }

    return allTickers;
  }

  /**
   * Fetches market snapshot across all US equities in a single call.
   */
  private async fetchMassiveSnapshot(): Promise<
    Map<string, { price: number | null; change: number | null; changePct: number | null; volume: number | null }>
  > {
    const map = new Map<
      string,
      { price: number | null; change: number | null; changePct: number | null; volume: number | null }
    >();

    const url = `${this.baseUrl}/v2/snapshot/locale/us/markets/stocks/tickers?apiKey=${this.apiKey}`;
    const res = await fetchJson<any>(url, { timeoutMs: 25_000 });

    for (const t of res?.tickers || []) {
      const price = t.day?.c ?? t.min?.c ?? t.prevDay?.c ?? null;
      const change = t.todaysChange ?? null;
      const changePct = t.todaysChangePerc ?? null;
      const volume = t.day?.v ?? null;
      map.set(t.ticker, { price, change, changePct, volume });
    }

    return map;
  }

  /**
   * Batches queries to fetch share_class_shares_outstanding for AUM calculation.
   */
  private async fetchMissingSharesOutstanding(tickers: string[]): Promise<void> {
    const BATCH_SIZE = 25;
    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = tickers.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (sym) => {
          try {
            const url = `${this.baseUrl}/v3/reference/tickers/${sym}?apiKey=${this.apiKey}`;
            const res = await fetchJson<any>(url, { timeoutMs: 10_000 });
            const shares = res?.results?.share_class_shares_outstanding;
            if (shares && Number.isFinite(shares) && shares > 0) {
              this.sharesCache.set(sym, shares);
            }
          } catch (err: any) {
            this.logger.debug(`Could not fetch details for ${sym}: ${err.message}`);
          }
        }),
      );
    }
  }

  /**
   * Persists normalized snapshot response to Firestore.
   */
  private async persistToFirestore(data: EtfMarketResponse): Promise<void> {
    if (!this.firebase) return;
    try {
      const ref = this.firebase.firestore
        .collection(this.FIRESTORE_COLLECTION)
        .doc(this.FIRESTORE_DOC);
      await ref.set(data);
    } catch (err: any) {
      this.logger.debug(`Firestore cache set ignored: ${err.message}`);
    }
  }

  /**
   * Reads fallback response from Firestore.
   */
  private async readFromFirestore(): Promise<EtfMarketResponse | null> {
    if (!this.firebase) return null;
    try {
      const ref = this.firebase.firestore
        .collection(this.FIRESTORE_COLLECTION)
        .doc(this.FIRESTORE_DOC);
      const snap = await ref.get();
      if (snap.exists) {
        return snap.data() as EtfMarketResponse;
      }
    } catch (err: any) {
      this.logger.debug(`Firestore cache get ignored: ${err.message}`);
    }
    return null;
  }
}
