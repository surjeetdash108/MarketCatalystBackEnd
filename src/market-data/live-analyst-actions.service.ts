import { Injectable } from "@nestjs/common";
import { FmpService } from "../vendors/fmp/fmp.service";
import { LiveCoalescer } from "../common/live-coalescer";

/**
 * Live replacement for the (no-op) `analyst-actions` sync job + Firestore cache.
 * Polygon has no analyst endpoint on any tier, so the source is FMP's
 * `grades-consensus` — a current Buy/Hold/Sell vote-count snapshot per ticker
 * (NOT a per-firm upgrade/downgrade event feed; that needs a Benzinga-class
 * source the plan doesn't include — the Analyst screen already renders those
 * sections as NotAvailable).
 *
 * `grades-consensus` is per-symbol, so — matching the plan's "scope a global
 * feed to a ticker set" recipe — we fetch a curated large-cap universe in
 * parallel and coalesce. This universe covers the tickers the Analyst screen
 * ranks (top-8 by buy count), the Dashboard consensus widget, and the common
 * names opened on the Stock screen (`liveConsensus.find(ticker===sym)`); a
 * ticker outside the set simply shows the panel as not-available, same as before.
 */

// ~45 liquid large caps across sectors. Deliberately static: a whole-market
// per-request pull would be thousands of FMP calls; this set is what the
// consuming screens actually surface.
const UNIVERSE = [
  // Mega-cap tech / comms
  "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AVGO", "ORCL",
  "AMD", "NFLX", "CRM", "ADBE", "INTC", "CSCO", "QCOM", "TXN", "IBM",
  // Financials
  "JPM", "BAC", "WFC", "GS", "MS", "V", "MA", "AXP",
  // Healthcare
  "UNH", "JNJ", "LLY", "PFE", "MRK", "ABBV", "TMO",
  // Consumer
  "WMT", "COST", "HD", "MCD", "NKE", "SBUX", "KO", "PEP", "PG", "DIS",
  // Energy / industrial
  "XOM", "CVX", "BA", "CAT",
];

// Gentle pacing: FMP rate-limits a 45-call burst (drops ~1/3 with "Limit
// Reach"). Small batches + a short inter-batch pause keep the whole board under
// the per-second cap while still finishing in a couple of seconds.
const ENRICH_CONCURRENCY = 4;
const BATCH_PAUSE_MS = 120;

// Reuse window. Analyst consensus is DAILY-cadence data (firms don't re-rate
// intraday), so unlike the price-driven live endpoints (2–5s) this reuses for a
// few minutes: fresh-enough for a once-a-day figure, and it keeps ~45 FMP calls
// from re-firing on every dashboard/stock/analyst view (which trips FMP's rate
// limit). Still an in-memory reuse window, not a persistent cache/cron.
const REUSE_MS = 120_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class LiveAnalystActionsService {
  private readonly coalescer = new LiveCoalescer(REUSE_MS);

  constructor(private readonly fmp: FmpService) {}

  async getAnalystActions() {
    return this.coalescer.run("analyst-actions", async () => {
      const out: {
        id: string;
        ticker: string;
        strongBuy: number;
        buy: number;
        hold: number;
        sell: number;
        strongSell: number;
        consensus: string;
      }[] = [];

      // Bounded-concurrency parallel fetch (one grades-consensus call/ticker).
      for (let i = 0; i < UNIVERSE.length; i += ENRICH_CONCURRENCY) {
        const batch = UNIVERSE.slice(i, i + ENRICH_CONCURRENCY);
        const rows = await Promise.all(
          batch.map(async (ticker) => {
            try {
              const res = await this.fmp.getGradesConsensus(ticker);
              const c = Array.isArray(res) ? res[0] : null;
              if (!c) return null;
              return {
                id: ticker,
                ticker,
                strongBuy: c.strongBuy ?? 0,
                buy: c.buy ?? 0,
                hold: c.hold ?? 0,
                sell: c.sell ?? 0,
                strongSell: c.strongSell ?? 0,
                consensus: c.consensus ?? "",
              };
            } catch {
              // A single ticker with no FMP coverage must not sink the board.
              return null;
            }
          }),
        );
        for (const r of rows) if (r) out.push(r);
        if (i + ENRICH_CONCURRENCY < UNIVERSE.length) await sleep(BATCH_PAUSE_MS);
      }

      return out;
    });
  }
}
