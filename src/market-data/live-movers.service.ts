import { Inject, Injectable } from "@nestjs/common";
import {
  MOVERS_ADAPTER,
  MOVER_ENRICHMENT_ADAPTER,
  type MoversAdapter,
  type MoverEnrichmentAdapter,
  type MoverEnrichment,
} from "../adapters/types";
import { LiveCoalescer } from "../common/live-coalescer";

/**
 * Live replacement for the `market-movers` sync job + Firestore cache. Computes
 * the top gainers/losers per request via the movers adapter (whole-market
 * grouped-daily diff), then enriches name/sector/cap.
 *
 * Enrichment change vs. the job: the job looped 40 tickers sequentially with a
 * 150ms sleep between each (~6-8s). Here we fan out with a bounded concurrency
 * (paid Polygon key, page-delay 0), cutting it to ~1-2s. The output doc shape
 * ({ ...moverBase, name, sector, cap, direction, source }) matches the
 * `LiveMoverDoc` the Movers screen / Dashboard widgets read.
 */
// Enrich all ~40 movers at once. On the paid key (page-delay 0) Polygon handles
// the concurrency fine, and the movers board is dominated by the two
// whole-market grouped-daily pulls anyway — no reason to serialise enrichment.
const ENRICH_CONCURRENCY = 40;

@Injectable()
export class LiveMoversService {
  private readonly coalescer = new LiveCoalescer(5_000);

  constructor(
    @Inject(MOVERS_ADAPTER) private readonly movers: MoversAdapter,
    @Inject(MOVER_ENRICHMENT_ADAPTER)
    private readonly enrichment: MoverEnrichmentAdapter,
  ) {}

  async getMovers() {
    return this.coalescer.run("movers", async () => {
      const { gainers, losers } = (await this.movers.fetchTopMovers(20)).data;
      const withDir = [
        ...gainers.map((m) => ({ m, direction: "gainer" as const })),
        ...losers.map((m) => ({ m, direction: "loser" as const })),
      ];

      const enrichMap = new Map<string, MoverEnrichment>();
      for (let i = 0; i < withDir.length; i += ENRICH_CONCURRENCY) {
        const chunk = withDir.slice(i, i + ENRICH_CONCURRENCY);
        await Promise.all(
          chunk.map(async ({ m }) => {
            if (enrichMap.has(m.ticker)) return;
            try {
              const e = await this.enrichment.enrichTicker(m.ticker);
              if (e?.data) enrichMap.set(m.ticker, e.data);
            } catch {
              // Leave unenriched (null name/sector/cap) rather than fail the board.
            }
          }),
        );
      }

      return withDir.map(({ m, direction }) => ({
        ...m,
        name: enrichMap.get(m.ticker)?.name ?? null,
        sector: enrichMap.get(m.ticker)?.sector ?? null,
        cap: enrichMap.get(m.ticker)?.cap ?? null,
        direction,
        source: "polygon",
      }));
    });
  }
}
