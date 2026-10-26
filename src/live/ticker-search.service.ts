import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import {
  PolygonService,
  PolygonTickerRef,
} from "../vendors/polygon/polygon.service";

/**
 * In-memory ticker search over the full ~10k US-stock universe.
 *
 * Replaces the Firestore `tickers` collection sync (10k docs written daily,
 * read per keystroke by every user). The reference list is pre-seeded from a
 * bundled disk cache on boot (<5ms), kept in memory (~2 MB), and refreshed every
 * 24 h from Polygon in the background. Search costs ZERO Firestore reads.
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
const DISK_SEED_PATH = path.join(__dirname, "fixtures/ticker-universe-seed.json");
const TMP_CACHE_PATH = "/tmp/ticker-universe-cache.json";

interface UniverseItem {
  ticker: string;
  name: string;
  nameLower: string;
}

@Injectable()
export class TickerSearchService implements OnModuleInit {
  private readonly logger = new Logger(TickerSearchService.name);
  private universe: UniverseItem[] = [];
  private tickerMap = new Map<string, UniverseItem>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  readonly stats = { universeSize: 0, loads: 0, searches: 0 };

  constructor(private readonly polygon: PolygonService) {
    // Instantly seed from disk cache so the universe is populated on boot (0ms cold start)
    this.loadFromDisk();
  }

  async onModuleInit(): Promise<void> {
    // If empty or older than 24h, refresh in the background without blocking user requests
    if (this.universe.length === 0 || Date.now() - this.loadedAt >= REFRESH_MS) {
      void this.ensureLoaded().catch((err) =>
        this.logger.error(`Background ticker universe refresh failed: ${(err as Error).message}`),
      );
    }
  }

  private loadFromDisk(): boolean {
    try {
      const targetPath = fs.existsSync(TMP_CACHE_PATH)
        ? TMP_CACHE_PATH
        : fs.existsSync(DISK_SEED_PATH)
        ? DISK_SEED_PATH
        : null;

      if (!targetPath) return false;

      const raw = fs.readFileSync(targetPath, "utf-8");
      const list: Array<{ ticker: string; name?: string }> = JSON.parse(raw);
      if (Array.isArray(list) && list.length > 0) {
        this.universe = list.map((r) => ({
          ticker: r.ticker,
          name: r.name ?? "",
          nameLower: (r.name ?? "").toLowerCase(),
        }));
        this.tickerMap.clear();
        for (const u of this.universe) {
          if (!this.tickerMap.has(u.ticker)) {
            this.tickerMap.set(u.ticker, u);
          }
        }
        const stat = fs.statSync(targetPath);
        this.loadedAt = stat.mtimeMs || Date.now();
        this.stats.universeSize = this.universe.length;
        this.logger.log(
          `Ticker universe pre-seeded from disk (${path.basename(targetPath)}): ${this.universe.length} symbols`,
        );
        return true;
      }
    } catch (err) {
      this.logger.warn(`Failed to read ticker disk cache: ${(err as Error).message}`);
    }
    return false;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.universe.length > 0 && Date.now() - this.loadedAt < REFRESH_MS)
      return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const refs: PolygonTickerRef[] = await this.polygon.getAllTickers(true);
        this.universe = refs
          .filter((r) => r.ticker && r.market === "stocks")
          .map((r) => ({
            ticker: r.ticker,
            name: r.name ?? "",
            nameLower: (r.name ?? "").toLowerCase(),
          }));
        this.tickerMap.clear();
        for (const u of this.universe) {
          if (!this.tickerMap.has(u.ticker)) {
            this.tickerMap.set(u.ticker, u);
          }
        }
        this.loadedAt = Date.now();
        this.stats.universeSize = this.universe.length;
        this.stats.loads++;

        // Persist fresh universe to /tmp for rapid reuse across restarts
        try {
          fs.writeFileSync(
            TMP_CACHE_PATH,
            JSON.stringify(this.universe.map((u) => ({ ticker: u.ticker, name: u.name }))),
          );
        } catch {}

        this.logger.log(
          `Ticker universe refreshed: ${this.universe.length} symbols`,
        );
      } catch (err) {
        this.logger.error(
          `Ticker universe load failed: ${(err as Error).message}`,
        );
        // Keep whatever we had (e.g. disk seed); next search retries the load.
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /**
   * Whether `ticker` is an active listing.
   */
  async isListed(ticker: string): Promise<boolean | null> {
    if (this.universe.length === 0) {
      await this.ensureLoaded();
    }
    if (this.universe.length === 0) return null;
    return this.tickerMap.has(ticker.toUpperCase());
  }

  /** Ranked: exact ticker → ticker prefix → name prefix → substring. */
  async search(rawQuery: string): Promise<SearchHit[]> {
    this.stats.searches++;
    if (this.universe.length === 0) {
      await this.ensureLoaded();
    }
    const q = rawQuery.trim();
    if (!q) return [];
    const upper = q.toUpperCase();
    const lower = q.toLowerCase();

    // Exact ticker is looked up first O(1) via tickerMap
    const exactHit = this.tickerMap.get(upper);
    const exact: SearchHit[] = exactHit
      ? [{ ticker: exactHit.ticker, name: exactHit.name || null }]
      : [];

    const tickerPrefix: SearchHit[] = [];
    const namePrefix: SearchHit[] = [];
    const substring: SearchHit[] = [];

    for (const t of this.universe) {
      if (t.ticker === upper) continue;
      else if (t.ticker.startsWith(upper))
        tickerPrefix.push({ ticker: t.ticker, name: t.name || null });
      else if (t.nameLower.startsWith(lower))
        namePrefix.push({ ticker: t.ticker, name: t.name || null });
      else if (t.nameLower.includes(lower))
        substring.push({ ticker: t.ticker, name: t.name || null });
      if (exact.length + tickerPrefix.length >= MAX_RESULTS * 3) break;
    }
    return [...exact, ...tickerPrefix, ...namePrefix, ...substring].slice(
      0,
      MAX_RESULTS,
    );
  }
}
