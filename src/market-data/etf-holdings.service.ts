import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { fetchJson } from "../common/http.util";

export const POPULAR_16_ETFS = [
  "CIBR",
  "DIA",
  "GLD",
  "HACK",
  "HYG",
  "IBIT",
  "IWM",
  "QQEW",
  "QQQ",
  "SMH",
  "SOXX",
  "SPY",
  "TLT",
  "XLE",
  "XLF",
  "XLK",
] as const;

export type PopularEtfSymbol = (typeof POPULAR_16_ETFS)[number];

export interface EtfHoldingItem {
  asset: string;
  name: string;
  isin?: string | null;
  securityCusip?: string | null;
  sharesNumber?: number | null;
  weightPercentage: number;
  marketValue?: number | null;
}

export interface EtfHoldingsDoc {
  symbol: string;
  name: string;
  etfType: "stock" | "bond" | "commodity" | "crypto";
  asOfDate: string;
  source: "fmp" | "issuer";
  holdingsCount: number;
  top10Concentration: number;
  aum?: number | null;
  expenseRatio?: number | null;
  nav?: number | null;
  weightingNote?: string | null;
  sectors?: Array<{ sector: string; weight: number }>;
  singleAssetStats?: {
    assetName: string;
    unitsHeld?: number | null;
    unitLabel?: string;
    description?: string;
  } | null;
  holdings: EtfHoldingItem[];
  updatedAt: string;
}

interface EtfMetaConfig {
  name: string;
  type: "stock" | "bond" | "commodity" | "crypto";
  weightingNote?: string;
  singleAssetStats?: {
    assetName: string;
    unitLabel?: string;
    description?: string;
  };
}

const ETF_METADATA: Record<string, EtfMetaConfig> = {
  SPY: {
    name: "State Street SPDR S&P 500 ETF Trust",
    type: "stock",
  },
  QQQ: {
    name: "Invesco QQQ Trust (Nasdaq-100)",
    type: "stock",
  },
  QQEW: {
    name: "First Trust NASDAQ-100 Equal Weighted Index Fund",
    type: "stock",
    weightingNote:
      "Equal-weighted index: all constituent companies are given approximately equal portfolio weighting.",
  },
  DIA: {
    name: "State Street SPDR Dow Jones Industrial Average ETF",
    type: "stock",
    weightingNote:
      "Price-weighted index: components are weighted by their share price, not market capitalization.",
  },
  IWM: {
    name: "iShares Russell 2000 ETF",
    type: "stock",
  },
  XLK: {
    name: "State Street Technology Select Sector SPDR Fund",
    type: "stock",
  },
  XLF: {
    name: "State Street Financial Select Sector SPDR Fund",
    type: "stock",
  },
  XLE: {
    name: "State Street Energy Select Sector SPDR Fund",
    type: "stock",
  },
  SMH: {
    name: "VanEck Semiconductor ETF",
    type: "stock",
  },
  SOXX: {
    name: "iShares Semiconductor ETF",
    type: "stock",
  },
  CIBR: {
    name: "First Trust NASDAQ Cybersecurity ETF",
    type: "stock",
  },
  HACK: {
    name: "Amplify Cybersecurity ETF",
    type: "stock",
  },
  TLT: {
    name: "iShares 20+ Year Treasury Bond ETF",
    type: "bond",
  },
  HYG: {
    name: "iShares iBoxx $ High Yield Corporate Bond ETF",
    type: "bond",
  },
  GLD: {
    name: "SPDR Gold Shares Trust",
    type: "commodity",
    singleAssetStats: {
      assetName: "Physical Gold Bullion",
      unitLabel: "Ounces / Metric Tons",
      description:
        "The Trust holds 100% physical gold bullion allocated in custody vaults (London), reflecting spot gold prices less fund expenses.",
    },
  },
  IBIT: {
    name: "iShares Bitcoin Trust ETF",
    type: "crypto",
    singleAssetStats: {
      assetName: "Bitcoin (BTC)",
      unitLabel: "BTC",
      description:
        "The iShares Bitcoin Trust ETF holds 100% physically-backed spot Bitcoin in segregated institutional cold storage with Coinbase Custody.",
    },
  },
};

@Injectable()
export class EtfHoldingsService {
  private readonly logger = new Logger(EtfHoldingsService.name);
  private readonly fmpKey: string;

  constructor(
    private readonly config: ConfigService,
    private readonly firebase: FirebaseAdminService,
  ) {
    this.fmpKey = this.config.get<string>("FMP_API_KEY")?.trim() || "";
  }

  /**
   * Retrieves ETF holdings doc from Firestore, syncing on-demand if missing.
   */
  async getHoldings(symbol: string): Promise<EtfHoldingsDoc | null> {
    const sym = symbol.toUpperCase().trim();
    const db = this.firebase.firestore;
    const docRef = db.collection("etf_holdings").doc(sym);
    const snap = await docRef.get();

    if (snap.exists) {
      return snap.data() as EtfHoldingsDoc;
    }

    // Sync on-demand
    return this.syncEtf(sym);
  }

  /**
   * Syncs holdings and info for a single ETF symbol from FMP and saves to Firestore.
   */
  async syncEtf(symbol: string): Promise<EtfHoldingsDoc | null> {
    const sym = symbol.toUpperCase().trim();
    if (!this.fmpKey) {
      this.logger.warn(`FMP_API_KEY not configured — skipping ETF sync for ${sym}`);
      return null;
    }

    try {
      this.logger.log(`Fetching ETF holdings and info for ${sym} from FMP stable API...`);
      const [holdingsRes, infoRes] = await Promise.all([
        fetchJson<any[]>(
          `https://financialmodelingprep.com/stable/etf/holdings?symbol=${encodeURIComponent(sym)}&apikey=${this.fmpKey}`,
          { timeoutMs: 15_000, retries: 2 },
        ).catch((err) => {
          this.logger.warn(`Holdings fetch failed for ${sym}: ${(err as Error).message}`);
          return [];
        }),
        fetchJson<any[]>(
          `https://financialmodelingprep.com/stable/etf/info?symbol=${encodeURIComponent(sym)}&apikey=${this.fmpKey}`,
          { timeoutMs: 10_000, retries: 1 },
        ).catch(() => []),
      ]);

      const rawHoldings = Array.isArray(holdingsRes) ? holdingsRes : [];
      if (rawHoldings.length === 0) {
        this.logger.warn(`No holdings returned from FMP for ${sym}`);
        return null;
      }

      const info = Array.isArray(infoRes) && infoRes.length > 0 ? infoRes[0] : null;
      const meta: EtfMetaConfig = ETF_METADATA[sym] ?? {
        name: info?.name ?? `${sym} ETF`,
        type: "stock",
      };

      // Sort holdings descending by weightPercentage
      const sortedHoldings = [...rawHoldings].sort(
        (a, b) => (Number(b.weightPercentage) || 0) - (Number(a.weightPercentage) || 0),
      );

      // Clean holdings rows
      const holdings: EtfHoldingItem[] = sortedHoldings.map((h) => {
        const weight = Number(h.weightPercentage) || 0;
        return {
          asset: String(h.asset ?? "").trim().toUpperCase(),
          name: String(h.name ?? h.asset ?? "").trim(),
          isin: h.isin ? String(h.isin) : null,
          securityCusip: h.securityCusip ? String(h.securityCusip) : null,
          sharesNumber: typeof h.sharesNumber === "number" ? h.sharesNumber : null,
          weightPercentage: Number(weight.toFixed(2)),
          marketValue: typeof h.marketValue === "number" ? h.marketValue : null,
        };
      });

      // Top 10 concentration
      const top10Concentration = Number(
        holdings
          .slice(0, 10)
          .reduce((sum, h) => sum + (h.weightPercentage || 0), 0)
          .toFixed(2),
      );

      // Extract asOfDate
      const firstRowUpdated = sortedHoldings[0]?.updatedAt;
      let asOfDate = new Date().toISOString().slice(0, 10);
      if (firstRowUpdated) {
        try {
          const parsed = new Date(firstRowUpdated);
          if (!isNaN(parsed.getTime())) {
            asOfDate = parsed.toISOString().slice(0, 10);
          }
        } catch {
          // fallback to today
        }
      }

      // Sector list from info if available
      let sectors: Array<{ sector: string; weight: number }> | undefined;
      if (Array.isArray(info?.sectorsList) && info.sectorsList.length > 0) {
        sectors = info.sectorsList
          .map((s: any) => ({
            sector: String(s.industry ?? s.sector ?? "").trim(),
            weight: Number((Number(s.exposure ?? s.weightPercentage) || 0).toFixed(2)),
          }))
          .filter((s: any) => s.sector && s.weight > 0)
          .sort((a: any, b: any) => b.weight - a.weight);
      }

      // Single-asset handling (GLD, IBIT)
      let singleAssetStats: EtfHoldingsDoc["singleAssetStats"] = null;
      if (meta.singleAssetStats) {
        const primaryHolding = holdings[0];
        singleAssetStats = {
          assetName: meta.singleAssetStats.assetName,
          unitLabel: meta.singleAssetStats.unitLabel,
          description: meta.singleAssetStats.description,
          unitsHeld: primaryHolding?.sharesNumber ?? null,
        };
      }

      const doc: EtfHoldingsDoc = {
        symbol: sym,
        name: meta.name || info?.name || `${sym} ETF`,
        etfType: meta.type,
        asOfDate,
        source: "fmp",
        holdingsCount: holdings.length,
        top10Concentration,
        aum: typeof info?.assetsUnderManagement === "number" ? info.assetsUnderManagement : null,
        expenseRatio: typeof info?.expenseRatio === "number" ? info.expenseRatio : null,
        nav: typeof info?.nav === "number" ? info.nav : null,
        weightingNote: meta.weightingNote ?? null,
        sectors: sectors && sectors.length > 0 ? sectors : undefined,
        singleAssetStats,
        holdings,
        updatedAt: new Date().toISOString(),
      };

      // Strip any accidental undefined fields before Firestore write
      const sanitizedDoc = JSON.parse(JSON.stringify(doc));

      // Save to Firestore
      const db = this.firebase.firestore;
      await db.collection("etf_holdings").doc(sym).set(sanitizedDoc, { merge: true });
      this.logger.log(`✔ Synced ${holdings.length} holdings for ${sym} (top 10: ${top10Concentration}%)`);
      return doc;
    } catch (err) {
      this.logger.error(`Failed syncing ETF holdings for ${sym}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Syncs all 16 Popular ETFs.
   */
  async syncAllPopular(): Promise<{ successCount: number; errors: string[] }> {
    let successCount = 0;
    const errors: string[] = [];

    for (const sym of POPULAR_16_ETFS) {
      try {
        const result = await this.syncEtf(sym);
        if (result) successCount++;
        else errors.push(`${sym}: no data`);
      } catch (err) {
        errors.push(`${sym}: ${(err as Error).message}`);
      }
    }

    return { successCount, errors };
  }
}
