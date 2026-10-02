import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import { CachedCollectionsService } from "../live/cached-collections.service";
import { MarketDataService } from "./market-data.service";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";

/**
 * GET /market-data/companies — the bulk `companies` collection (per-ticker
 * price/pctChange/marketCap/rvol), shared by Movers (rvol enrichment),
 * Heatmap (tile price/marketCap) and, later, Dashboard. Triggers the
 * `companies` sync job on demand when stale/empty per decision #3a.
 */
@Controller("market-data")
// Market data is the product. These read surfaces answered anonymous
// callers, returning full datasets — the policy lived only in a Firestore
// rules file that nothing enforces, because no client talks to Firestore.
@UseGuards(FirebaseAuthGuard)
export class CompaniesController {
  constructor(
    private readonly marketData: MarketDataService,
    private readonly cached: CachedCollectionsService,
  ) {}

  @Get("companies")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  )
  async companies() {
    await this.marketData.ensureFresh("companies");
    const { companies, market_movers } = await this.cached.get([
      "companies",
      "market_movers",
    ]);

    // Build lookup of fresh canonical mover enrichments (enriched with SEC EDGAR priority)
    const moverClassificationByTicker = new Map<
      string,
      { sector: string; industry?: string; name?: string; marketCap?: number | null }
    >();

    if (Array.isArray(market_movers)) {
      for (const m of market_movers as Array<{
        ticker?: string;
        sector?: string;
        industry?: string;
        name?: string;
        marketCap?: number | null;
      }>) {
        const sym = m.ticker?.trim().toUpperCase();
        if (sym && m.sector && m.sector !== "—" && !moverClassificationByTicker.has(sym)) {
          moverClassificationByTicker.set(sym, {
            sector: m.sector,
            industry: m.industry,
            name: m.name,
            marketCap: m.marketCap,
          });
        }
      }
    }

    // Drop tickers the vendor no longer knows (acquired / taken private /
    // renamed — CYBR, WBA, ZI, BOBJ…). companies.job flags these only after
    // they've been missing for days, and clears the flag if they come back.
    // Without this they linger in every list, screener and heatmap showing a
    // frozen last price as though it were live.
    // Reconcile any stale company classifications with fresh mover enrichment.
    return (companies as Array<Record<string, unknown>>)
      .filter((c) => c.delisted !== true)
      .map((c) => {
        const sym = String(c.ticker ?? "").trim().toUpperCase();
        const mover = moverClassificationByTicker.get(sym);
        if ((!c.sector || c.sector === "—") && mover?.sector && mover.sector !== "—") {
          return {
            ...c,
            sector: mover.sector,
            ...(mover.industry ? { industry: mover.industry } : {}),
            ...(mover.name && !c.name ? { name: mover.name } : {}),
            ...(typeof mover.marketCap === "number" && mover.marketCap > 0 && !c.marketCap
              ? { marketCap: mover.marketCap }
              : {}),
          };
        }
        return c;
      });
  }
}
