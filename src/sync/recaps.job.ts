import { Injectable } from "@nestjs/common";
import { FmpService } from "../vendors/fmp/fmp.service";
import { MarketIndicesJob } from "./market-indices.job";
import { SectorsJob } from "./sectors.job";

/**
 * Recap → the numeric fields the Recap screen renders (indices, top movers,
 * sector leaders/laggards).
 *
 * Live-direct: composed fresh per request from the live fetchers, WITHOUT
 * reading or writing Firestore. Backs GET /market-data/recaps.
 *
 * A recap used to be an EOD snapshot composed from the synced `market_indices`,
 * `market_movers`, `sectors` and `market_breadth` collections plus their
 * histories. Those collections are no longer written, so the recap is now
 * recomposed from the corresponding LIVE sources:
 *   - indices        ← MarketIndicesJob.fetchLive() (Polygon snapshot)
 *   - top gainers/losers ← FMP biggest gainers/losers (same source as /movers)
 *   - sector leaders/laggards ← SectorsJob.fetchLive()
 *
 * DEGRADED: `internals` (per-day market breadth) and the `weekly` aggregates
 * required accumulated per-day history with no single live vendor call, so they
 * are dropped (null) rather than reading a now-empty Firestore collection.
 */

const TOP_N = 6;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class RecapsJob {
  constructor(
    private readonly fmp: FmpService,
    private readonly indices: MarketIndicesJob,
    private readonly sectorsJob: SectorsJob,
  ) {}

  private num(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }

  /**
   * Live-direct: compose today's recap fresh per request as a single-element
   * array (the current session's recap), matching the `{id, ...data}` shape a
   * `recaps` doc read yielded.
   */
  async fetchLive(): Promise<Record<string, unknown>[]> {
    const doc = await this.buildRecap();
    return [{ id: doc.id, ...doc.data }];
  }

  private async buildRecap(): Promise<{
    id: string;
    data: Record<string, unknown>;
  }> {
    const [indexRows, gainers, losers, sectorRows] = await Promise.all([
      this.indices.fetchLive(),
      this.fmp.getGainers().catch(() => []),
      this.fmp.getLosers().catch(() => []),
      this.sectorsJob.fetchLive(),
    ]);

    // Indices (SPX/NDX/DJI/RUT/VIX/US10Y/…) — label, value, % move.
    const indices = indexRows.map((x) => ({
      id: x.id,
      label: x.label ?? x.id,
      value: this.num(x.value),
      pctChange: this.num(x.pctChange),
      change: this.num(x.change),
      isProxy: !!x.isProxy,
      proxyTicker: x.proxyTicker ?? null,
      unit: x.unit ?? null,
    }));

    // Movers → top gainers / losers by % change (live FMP feed).
    const toMover = (m: {
      symbol: string;
      name?: string | null;
      price?: number | null;
      changesPercentage?: number | null;
    }) => ({
      ticker: m.symbol,
      name: m.name ?? m.symbol,
      price: this.num(m.price),
      pctChange: this.num(m.changesPercentage),
      sector: null as string | null,
      cap: null as string | null,
    });
    const topGainers = gainers.slice(0, TOP_N).map(toMover);
    const topLosers = losers.slice(0, TOP_N).map(toMover);

    // Sectors → leaders / laggards by % change (live).
    const sectors = sectorRows
      .map((d) => ({
        sector: (d.sector as string) ?? d.id,
        pctChange: this.num(d.pctChange),
      }))
      .filter((s) => s.pctChange != null)
      .sort((a, b) => (b.pctChange ?? 0) - (a.pctChange ?? 0));
    const sectorLeaders = sectors.slice(0, 3);
    const sectorLaggards = sectors.slice(-3).reverse();

    const date = isoDate(new Date());
    return {
      id: date,
      data: {
        date,
        indices,
        topGainers,
        topLosers,
        sectorLeaders,
        sectorLaggards,
        // DEGRADED: per-day market breadth and weekly aggregates required
        // accumulated history no single live call provides — dropped.
        internals: null,
        weekly: null,
        // Narrative is R36 (Anthropic) — intentionally null.
        narrative: null,
        source: "polygon-derived",
        updatedAt: new Date().toISOString(),
      },
    };
  }
}
