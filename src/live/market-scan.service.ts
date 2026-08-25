import { Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";

/**
 * "SCANX" market scans — Biggest % gainers/losers and Most active stocks,
 * categorised by sector (spec: the Live Feed's Most Active / Biggest % tabs).
 *
 * Generated ON DEMAND from the `companies` universe (which already carries
 * price / pctChange / volume / rvol / sector, kept current by company-quotes.job)
 * and cached in ONE doc per collection (`latest`). A request reads the stored
 * doc and serves it while it's inside the cutoff; past the cutoff it recomputes,
 * overwrites `latest`, and serves the fresh copy. So the first viewer after the
 * cutoff pays the (cheap) recompute and everyone else reads it.
 *
 * Cutoffs: Biggest % = 2h, Most Active = 1h.
 */

const BIGGEST_PCT_COLLECTION = "scan_biggest_pct";
const MOST_ACTIVE_COLLECTION = "scan_most_active";
const BIGGEST_PCT_TTL_MS = 2 * 60 * 60 * 1000;
const MOST_ACTIVE_TTL_MS = 1 * 60 * 60 * 1000;
const TOP_N = 20;

interface CompanyRow {
  ticker: string;
  name?: string | null;
  sector?: string | null;
  price?: number | null;
  pctChange?: number | null;
  volume?: number | null;
  rvol?: number | null;
}

export interface ScanItem {
  ticker: string;
  name: string | null;
  pctChange: number | null;
  price?: number | null;
  volume?: number | null;
  rvol?: number | null;
}
export interface SectorGroup {
  sector: string;
  items: ScanItem[];
}
export interface BiggestPctScan {
  generatedAt: string;
  gainers: SectorGroup[];
  losers: SectorGroup[];
}
export interface MostActiveScan {
  generatedAt: string;
  byVolume: SectorGroup[];
  byRelVolume: SectorGroup[];
}

@Injectable()
export class MarketScanService {
  private readonly logger = new Logger(MarketScanService.name);
  constructor(private readonly firebase: FirebaseAdminService) {}

  async getBiggestPct(): Promise<BiggestPctScan> {
    return this.getOrGenerate(
      BIGGEST_PCT_COLLECTION,
      BIGGEST_PCT_TTL_MS,
      () => this.computeBiggestPct(),
    );
  }

  async getMostActive(): Promise<MostActiveScan> {
    return this.getOrGenerate(
      MOST_ACTIVE_COLLECTION,
      MOST_ACTIVE_TTL_MS,
      () => this.computeMostActive(),
    );
  }

  /** Serve the stored `latest` doc while fresh; otherwise recompute + store. */
  private async getOrGenerate<T extends { generatedAt: string }>(
    collection: string,
    ttlMs: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    const ref = this.firebase.firestore.collection(collection).doc("latest");
    try {
      const snap = await ref.get();
      if (snap.exists) {
        const doc = snap.data() as T;
        const age = Date.now() - Date.parse(doc.generatedAt);
        if (Number.isFinite(age) && age >= 0 && age < ttlMs) return doc;
      }
    } catch (err) {
      this.logger.warn(`${collection}: read failed — regenerating: ${(err as Error).message}`);
    }
    const fresh = await compute();
    await ref.set(fresh).catch((err) =>
      this.logger.warn(`${collection}: write failed: ${(err as Error).message}`),
    );
    return fresh;
  }

  private async loadCompanies(): Promise<CompanyRow[]> {
    const snap = await this.firebase.firestore.collection("companies").get();
    return snap.docs.map((d) => d.data() as CompanyRow);
  }

  /** Group already-ranked rows by sector, preserving both the sector's first
   *  appearance and each row's rank within it — mirrors the SCANX layout. */
  private groupBySector(
    rows: CompanyRow[],
    toItem: (r: CompanyRow) => ScanItem,
  ): SectorGroup[] {
    const order: string[] = [];
    const bySector = new Map<string, ScanItem[]>();
    for (const r of rows) {
      const sector = r.sector as string;
      if (!bySector.has(sector)) {
        bySector.set(sector, []);
        order.push(sector);
      }
      bySector.get(sector)!.push(toItem(r));
    }
    return order.map((sector) => ({ sector, items: bySector.get(sector)! }));
  }

  private async computeBiggestPct(): Promise<BiggestPctScan> {
    const rows = (await this.loadCompanies()).filter(
      (c) => c.pctChange != null && Number.isFinite(c.pctChange) && !!c.sector,
    );
    const gainers = [...rows]
      .sort((a, b) => (b.pctChange as number) - (a.pctChange as number))
      .slice(0, TOP_N);
    const losers = [...rows]
      .sort((a, b) => (a.pctChange as number) - (b.pctChange as number))
      .slice(0, TOP_N);
    const toItem = (r: CompanyRow): ScanItem => ({
      ticker: r.ticker,
      name: r.name ?? null,
      price: r.price ?? null,
      pctChange: r.pctChange ?? null,
    });
    return {
      generatedAt: new Date().toISOString(),
      gainers: this.groupBySector(gainers, toItem),
      losers: this.groupBySector(losers, toItem),
    };
  }

  private async computeMostActive(): Promise<MostActiveScan> {
    const all = await this.loadCompanies();
    const byVolume = all
      .filter((c) => c.volume != null && Number.isFinite(c.volume) && !!c.sector)
      .sort((a, b) => (b.volume as number) - (a.volume as number))
      .slice(0, TOP_N);
    const byRelVolume = all
      .filter((c) => c.rvol != null && Number.isFinite(c.rvol) && !!c.sector)
      .sort((a, b) => (b.rvol as number) - (a.rvol as number))
      .slice(0, TOP_N);
    return {
      generatedAt: new Date().toISOString(),
      byVolume: this.groupBySector(byVolume, (r) => ({
        ticker: r.ticker,
        name: r.name ?? null,
        volume: r.volume ?? null,
        pctChange: r.pctChange ?? null,
      })),
      byRelVolume: this.groupBySector(byRelVolume, (r) => ({
        ticker: r.ticker,
        name: r.name ?? null,
        rvol: r.rvol ?? null,
        pctChange: r.pctChange ?? null,
      })),
    };
  }
}
