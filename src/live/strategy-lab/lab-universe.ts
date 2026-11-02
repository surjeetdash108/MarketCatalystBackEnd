import { Injectable } from "@nestjs/common";
import { FmpService } from "../../vendors/fmp/fmp.service";
import { fromFmpSymbol } from "../../vendors/market-data/fmp-mapping.util";

/**
 * The Strategy Lab universe — ONE list for the browser scan
 * (GET /live/strategy-lab/universe) and the Strategy Lab jobs / validate
 * (LabStoreService.universe). Separate from activeUniverse() / `companies`,
 * which other features use.
 *
 * Index constituents from FMP, de-duplicated, ranked by market cap (largest
 * first). Only the S&P 500 today; another index is one more entry here.
 */
const INDEXES: Array<{ name: string; path: string }> = [
  { name: "S&P 500", path: "sp500-constituent" },
];

/** Most stocks a scan covers per candle; null = the whole universe. Lower an intraday cap if FMP load is too high. */
export const LAB_UNIVERSE_CAP: Record<string, number | null> = {
  d: null,
  "1w": null,
  "1m": 50,
  "5m": 100,
  "15m": 100,
  "30m": 100,
  "1h": 150,
  "4h": 150,
};

const UNIVERSE_TTL_MS = 12 * 3_600_000;

export interface LabUniverseStock {
  t: string;
  n: string;
  marketCap: number;
}
export interface LabUniverse {
  asOf: string;
  source: string;
  stocks: LabUniverseStock[];
}

/** The first stocks of the ranked list for a candle: its cap, and an explicit size when smaller (0 / missing = no limit). */
export function universeFor<T>(stocks: T[], tf: string, size?: number): T[] {
  const cap = LAB_UNIVERSE_CAP[tf] ?? null;
  const lim = [cap, size && size > 0 ? size : null].filter(
    (x): x is number => x != null,
  );
  return lim.length ? stocks.slice(0, Math.min(...lim)) : stocks;
}

@Injectable()
export class LabUniverseService {
  private mem: { at: number; value: LabUniverse } | null = null;
  private loading: Promise<LabUniverse> | null = null;

  constructor(private readonly fmp: FmpService) {}

  /** Cached 12 hours per instance. Throws when FMP can't supply it — never a fallback list. */
  async get(): Promise<LabUniverse> {
    if (this.mem && Date.now() - this.mem.at < UNIVERSE_TTL_MS)
      return this.mem.value;
    if (this.loading === null)
      this.loading = this.build()
        .then((value) => {
          this.mem = { at: Date.now(), value };
          return value;
        })
        .finally(() => (this.loading = null));
    return this.loading;
  }

  private async build(): Promise<LabUniverse> {
    const names = new Map<string, string>();
    for (const ix of INDEXES) {
      const rows = (await this.fmp.request(ix.path)) as Array<{
        symbol?: string;
        name?: string;
      }>;
      for (const r of rows)
        if (r?.symbol && !names.has(r.symbol))
          names.set(r.symbol, r.name ?? r.symbol);
    }
    const syms = [...names.keys()];
    const label = INDEXES.map((i) => i.name).join(" + ");
    if (!syms.length) throw new Error(`FMP returned no ${label} constituents`);
    const stocks: LabUniverseStock[] = [];
    for (let i = 0; i < syms.length; i += 100) {
      for (const q of await this.fmp.getQuotes(syms.slice(i, i + 100))) {
        const mc = Number(q.marketCap);
        if (Number.isFinite(mc) && mc > 0)
          stocks.push({
            t: fromFmpSymbol(q.symbol),
            n: names.get(q.symbol) ?? q.symbol,
            marketCap: mc,
          });
      }
    }
    // A half-priced list would silently drop stocks from every scan.
    if (stocks.length < syms.length / 2)
      throw new Error(
        `FMP priced only ${stocks.length} of ${syms.length} ${label} constituents`,
      );
    stocks.sort((a, b) => b.marketCap - a.marketCap);
    return {
      asOf: new Date().toISOString(),
      source: `FMP ${label} constituents ranked by market cap`,
      stocks,
    };
  }
}
