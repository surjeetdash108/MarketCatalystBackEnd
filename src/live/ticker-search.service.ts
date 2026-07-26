import { Injectable, Logger } from '@nestjs/common';
import { PolygonService, PolygonTickerRef } from '../vendors/polygon/polygon.service';

/**
 * In-memory ticker search over the full ~10k US-stock universe.
 *
 * Replaces the Firestore `tickers` collection sync (10k docs written daily,
 * read per keystroke by every user). The reference list is loaded ONCE per
 * instance from Polygon `/v3/reference/tickers`, kept in memory (~2 MB), and
 * refreshed every 24 h. Search costs ZERO Firestore reads and zero writes.
 *
 * Substring matching included (Firestore could only do prefix ranges), so
 * "oogle" now finds Alphabet where the old path could not.
 */

export interface SearchHit {
  ticker: string;
  name: string | null;
}

const MAX_RESULTS = 20;
const REFRESH_MS = 24 * 3600_000;

@Injectable()
export class TickerSearchService {
  private readonly logger = new Logger(TickerSearchService.name);
  private universe: Array<{ ticker: string; name: string; nameLower: string }> = [];
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  readonly stats = { universeSize: 0, loads: 0, searches: 0 };

  constructor(private readonly polygon: PolygonService) {}

  private async ensureLoaded(): Promise<void> {
    if (this.universe.length > 0 && Date.now() - this.loadedAt < REFRESH_MS) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const refs: PolygonTickerRef[] = await this.polygon.getAllTickers(true);
        this.universe = refs
          .filter((r) => r.ticker && r.market === 'stocks')
          .map((r) => ({ ticker: r.ticker, name: r.name ?? '', nameLower: (r.name ?? '').toLowerCase() }));
        this.loadedAt = Date.now();
        this.stats.universeSize = this.universe.length;
        this.stats.loads++;
        this.logger.log(`Ticker universe loaded: ${this.universe.length} symbols`);
      } catch (err) {
        this.logger.error(`Ticker universe load failed: ${(err as Error).message}`);
        // Keep whatever we had; next search retries the load.
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** Ranked: exact ticker → ticker prefix → name prefix → substring. */
  async search(rawQuery: string): Promise<SearchHit[]> {
    this.stats.searches++;
    await this.ensureLoaded();
    const q = rawQuery.trim();
    if (!q) return [];
    const upper = q.toUpperCase();
    const lower = q.toLowerCase();

    const exact: SearchHit[] = [];
    const tickerPrefix: SearchHit[] = [];
    const namePrefix: SearchHit[] = [];
    const substring: SearchHit[] = [];

    for (const t of this.universe) {
      if (t.ticker === upper) exact.push({ ticker: t.ticker, name: t.name || null });
      else if (t.ticker.startsWith(upper)) tickerPrefix.push({ ticker: t.ticker, name: t.name || null });
      else if (t.nameLower.startsWith(lower)) namePrefix.push({ ticker: t.ticker, name: t.name || null });
      else if (t.nameLower.includes(lower)) substring.push({ ticker: t.ticker, name: t.name || null });
      if (exact.length + tickerPrefix.length >= MAX_RESULTS * 3) break;
    }
    return [...exact, ...tickerPrefix, ...namePrefix, ...substring].slice(0, MAX_RESULTS);
  }
}
