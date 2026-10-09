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

  private cachedResponse: EtfMarketResponse | null = null;
  private lastFetchedAt = 0;
  private refreshPromise: Promise<EtfMarketResponse> | null = null;

  // In-memory cache for shares outstanding to avoid re-fetching unchanged share counts
  private readonly sharesCache = new Map<string, number>();

  // 7-day cache TTL for in-memory serving; updated weekly by scheduled job
  private readonly CACHE_TTL_MS = 7 * 24 * 60 * 60_000;

  // DB collections for current week and previous week fallback
  private readonly CURRENT_COLLECTION = "etf_market_current";
  private readonly PREVIOUS_COLLECTION = "etf_market_previous";
  private readonly LEGACY_COLLECTION = "etf_corner_cache";
  private readonly LEGACY_DOC = "latest";

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
    // Immediate pre-warm from Firestore on boot (sub-50ms)
    try {
      const cached = await this.readFromFirestore();
      if (cached) {
        this.cachedResponse = cached;
        this.lastFetchedAt = cached.updatedAt || Date.now();
        const totalFunds = cached.categories?.reduce((acc, c) => acc + (c.funds?.length || 0), 0) || 0;
        this.logger.log(
          `ETF market data pre-warmed from Firestore: ${cached.categories?.length} categories, ${totalFunds} total funds visible`,
        );
      }
    } catch (err: any) {
      this.logger.warn(`Initial Firestore ETF cache read failed: ${err.message}`);
    }
  }

  /**
   * Returns categorized, dynamically discovered ETFs across all 10 categories.
   * If limit is specified and > 0, caps each category to that number; otherwise returns ALL discovered ETFs.
   */
  async getCategorizedEtfs(limit?: number): Promise<EtfMarketResponse> {
    const now = Date.now();
    let baseResponse: EtfMarketResponse;

    if (this.cachedResponse && now - this.lastFetchedAt < this.CACHE_TTL_MS) {
      baseResponse = this.cachedResponse;
    } else {
      // Check Firestore DB before triggering an expensive upstream refresh
      const firestoreData = await this.readFromFirestore();
      if (firestoreData && now - (firestoreData.updatedAt || 0) < this.CACHE_TTL_MS) {
        this.cachedResponse = firestoreData;
        this.lastFetchedAt = firestoreData.updatedAt || now;
        baseResponse = firestoreData;
      } else if (firestoreData) {
        // Even if older than 7 days, serve DB immediately while scheduling background refresh
        this.cachedResponse = firestoreData;
        this.lastFetchedAt = firestoreData.updatedAt || now;
        baseResponse = firestoreData;
        this.triggerBackgroundRefresh();
      } else {
        if (!this.refreshPromise) {
          this.refreshPromise = this.refreshCache().finally(() => {
            this.refreshPromise = null;
          });
        }
        baseResponse = await this.refreshPromise;
      }
    }

    if (!limit || limit <= 0) {
      return baseResponse;
    }

    return this.applyLimit(baseResponse, limit);
  }

  private triggerBackgroundRefresh(): void {
    if (this.refreshPromise) return;
    this.refreshPromise = this.refreshCache()
      .catch((err) => {
        this.logger.warn(`Background ETF refresh failed: ${err.message}`);
        return this.cachedResponse!;
      })
      .finally(() => {
        this.refreshPromise = null;
      });
  }

  /**
   * Explicit universe sync and weekly rotation method.
   * Rotates current week -> previous week, fetches fresh data, and persists to current week.
   */
  async syncUniverse(): Promise<EtfMarketResponse> {
    return this.refreshCache();
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
   * classification engine, sorts by AUM descending, rotates DB, and updates memory and DB.
   */
  private async refreshCache(): Promise<EtfMarketResponse> {
    const started = Date.now();
    this.logger.log("Refreshing ETF Discovery & Classification via Massive API (100% complete universe)...");

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

      if (validEtfs.length === 0) {
        this.logger.warn("No valid ETFs discovered with price data — aborting refresh to protect DB data");
        const fallback = await this.readFromFirestore();
        if (fallback) {
          this.cachedResponse = fallback;
          this.lastFetchedAt = Date.now();
          return fallback;
        }
        if (this.cachedResponse) return this.cachedResponse;
        throw new Error("ETF data unavailable from upstream");
      }

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
        // Sort candidate pool by dollar volume to prioritize prominent funds for AUM lookup
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

          // Compact structure to ensure each item is ~90 bytes for DB storage
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
          };
        });

        // Sort by AUM DESC, fallback to volume DESC
        normalizedList.sort((a, b) => {
          if (a.aum != null && b.aum != null) {
            return b.aum - a.aum;
          }
          if (a.aum != null) return -1;
          if (b.aum != null) return 1;
          return (b.volume || 0) - (a.volume || 0);
        });

        // Deduplicate each category by ticker symbol — keep 100% of discovered funds (NO CAPPING!)
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

      // Rotate DB collections and persist full data
      await this.rotateAndPersistToFirestore(response);

      const totalDiscovered = categories.reduce((sum, c) => sum + c.funds.length, 0);
      this.logger.log(
        `ETF Discovery & Classification refreshed in ${
          Date.now() - started
        }ms: 10 dynamic categories across ${totalDiscovered} total funds (100% preserved)`,
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
   * Rotates current week -> previous week, and persists full new data into current week.
   * Uses per-category documents to ensure each document stays well below Firestore's 1 MB limit.
   */
  private async rotateAndPersistToFirestore(data: EtfMarketResponse): Promise<void> {
    if (!this.firebase) return;
    const db = this.firebase.firestore;
    const totalFunds = data.categories?.reduce((acc, c) => acc + (c.funds?.length || 0), 0) || 0;
    if (totalFunds === 0) {
      this.logger.warn("Refusing to persist empty ETF dataset to Firestore");
      return;
    }

    try {
      // 1. Check current collection: if it already has valid documents, rotate them to previous
      const currentSnap = await db.collection(this.CURRENT_COLLECTION).get();
      let currentTotalFunds = 0;
      for (const doc of currentSnap.docs) {
        if (doc.id !== "_metadata" && doc.id !== "meta") {
          const docData = doc.data();
          if (Array.isArray(docData?.funds)) {
            currentTotalFunds += docData.funds.length;
          }
        }
      }

      if (currentTotalFunds > 0) {
        this.logger.log(
          `Rotating current week ETF data (${currentTotalFunds} funds across ${currentSnap.size} docs) to ${this.PREVIOUS_COLLECTION}...`,
        );
        for (const doc of currentSnap.docs) {
          await db
            .collection(this.PREVIOUS_COLLECTION)
            .doc(doc.id)
            .set(doc.data());
        }
        this.logger.log(`Successfully rotated current week ETF data to ${this.PREVIOUS_COLLECTION}`);
      }

      // 2. Persist fresh data into CURRENT_COLLECTION document per category
      this.logger.log(`Writing fresh ETF data (${totalFunds} funds) to ${this.CURRENT_COLLECTION}...`);
      for (const cat of data.categories) {
        const catDoc = {
          id: cat.id,
          label: cat.label,
          count: cat.funds.length,
          updatedAt: data.updatedAt,
          funds: cat.funds,
        };
        await db
          .collection(this.CURRENT_COLLECTION)
          .doc(cat.id)
          .set(catDoc);
      }

      // 3. Write metadata document
      const categoryCounts: Record<string, number> = {};
      for (const cat of data.categories) {
        categoryCounts[cat.id] = cat.funds.length;
      }

      const metaDoc = {
        updatedAt: data.updatedAt,
        source: data.source,
        totalCategories: data.categories.length,
        totalFunds,
        categoryCounts,
      };
      await db
        .collection(this.CURRENT_COLLECTION)
        .doc("_metadata")
        .set(metaDoc);

      this.logger.log(
        `Successfully saved all ${data.categories.length} categories (${totalFunds} total funds) to ${this.CURRENT_COLLECTION}`,
      );
    } catch (err: any) {
      this.logger.error(`Firestore ETF market persist failed: ${err.message}`);
    }
  }

  /**
   * Reads fallback response from Firestore with multi-tier fallback:
   * 1. Try CURRENT_COLLECTION (etf_market_current)
   * 2. If missing/invalid, fallback to PREVIOUS_COLLECTION (etf_market_previous - last week)
   * 3. If missing/invalid, fallback to legacy collection (etf_corner_cache/latest)
   */
  async readFromFirestore(): Promise<EtfMarketResponse | null> {
    if (!this.firebase) return null;

    // Stage 1: Try current week collection
    try {
      const current = await this.readCollectionFromFirestore(this.CURRENT_COLLECTION);
      if (this.isValidEtfResponse(current)) {
        const total = current!.categories.reduce((acc, c) => acc + c.funds.length, 0);
        this.logger.log(`Loaded ETF data from ${this.CURRENT_COLLECTION} (${total} total funds)`);
        return current;
      }
      this.logger.warn(`${this.CURRENT_COLLECTION} empty or invalid; attempting fallback to ${this.PREVIOUS_COLLECTION}...`);
    } catch (err: any) {
      this.logger.warn(`Failed reading ${this.CURRENT_COLLECTION}: ${err.message}; attempting fallback to ${this.PREVIOUS_COLLECTION}...`);
    }

    // Stage 2: Fallback to last week's collection
    try {
      const previous = await this.readCollectionFromFirestore(this.PREVIOUS_COLLECTION);
      if (this.isValidEtfResponse(previous)) {
        const total = previous!.categories.reduce((acc, c) => acc + c.funds.length, 0);
        this.logger.warn(`Fallback SUCCESS: Loaded ETF data from prior week ${this.PREVIOUS_COLLECTION} (${total} total funds)`);
        return previous;
      }
      this.logger.warn(`${this.PREVIOUS_COLLECTION} was also empty or invalid.`);
    } catch (err: any) {
      this.logger.warn(`Failed reading ${this.PREVIOUS_COLLECTION}: ${err.message}`);
    }

    // Stage 3: Fallback to legacy single-doc cache
    try {
      const legacySnap = await this.firebase.firestore
        .collection(this.LEGACY_COLLECTION)
        .doc(this.LEGACY_DOC)
        .get();
      if (legacySnap.exists) {
        const legacy = legacySnap.data() as EtfMarketResponse;
        if (this.isValidEtfResponse(legacy)) {
          this.logger.log(`Loaded ETF data from legacy ${this.LEGACY_COLLECTION}/${this.LEGACY_DOC}`);
          return legacy;
        }
      }
    } catch (err: any) {
      this.logger.debug(`Legacy cache read skipped: ${err.message}`);
    }

    return null;
  }

  /**
   * Helper that assembles a complete EtfMarketResponse from category documents in a given collection.
   */
  private async readCollectionFromFirestore(collectionName: string): Promise<EtfMarketResponse | null> {
    if (!this.firebase) return null;
    const db = this.firebase.firestore;
    const snap = await db.collection(collectionName).get();
    if (snap.empty) return null;

    let updatedAt = 0;
    let source = "massive-polygon";
    const categoryMap = new Map<string, NormalizedETF[]>();

    for (const doc of snap.docs) {
      if (doc.id === "_metadata" || doc.id === "meta") {
        const meta = doc.data();
        if (meta?.updatedAt) updatedAt = meta.updatedAt;
        if (meta?.source) source = meta.source;
        continue;
      }
      const data = doc.data();
      if (data && Array.isArray(data.funds)) {
        if (!updatedAt && data.updatedAt) updatedAt = data.updatedAt;
        categoryMap.set(doc.id, data.funds);
      }
    }

    if (categoryMap.size === 0) return null;

    const categories: EtfCategorySection[] = CATEGORY_DEFINITIONS.map((def) => ({
      id: def.id,
      label: def.label,
      funds: categoryMap.get(def.id) || [],
    }));

    const getFunds = (id: string) => categoryMap.get(id) || [];
    const largest = getFunds("largest");
    const equity = getFunds("equity");
    const bitcoin = getFunds("bitcoin");
    const ethereum = getFunds("ethereum");
    const gold = getFunds("gold");
    const fixedIncome = getFunds("fixedIncome");
    const realEstate = getFunds("realEstate");
    const totalMarket = getFunds("totalMarket");
    const commodities = getFunds("commodities");
    const leveraged = getFunds("leveraged");

    return {
      updatedAt: updatedAt || Date.now(),
      source,
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

  private isValidEtfResponse(res: EtfMarketResponse | null): boolean {
    if (!res || !Array.isArray(res.categories) || res.categories.length === 0) return false;
    const totalFunds = res.categories.reduce((acc, c) => acc + (c.funds?.length || 0), 0);
    return totalFunds > 0;
  }
}
