import { Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "./firebase-admin.provider";

/** Delistings change at most weekly; a short TTL only bounds the lag after one. */
const TTL_MS = 10 * 60_000;

/**
 * The set of delisted symbols — `tickers` docs the ticker-universe job marked
 * `active: false` after the vendor confirmed the delisting.
 *
 * Delisted symbols are hidden everywhere: list endpoints drop their rows, the
 * per-ticker endpoints answer 404, and the sync jobs stop refreshing them.
 * Before this, nothing ever retired a symbol: AACB (delisted 2026-08-20) kept
 * its 19 Aug close of $10.59 re-stamped with each day's date, as if it still
 * traded, alongside AVB, EQR, WBD and 11 others.
 *
 * A failed load keeps the previous set rather than emptying it, so a transient
 * Firestore error never briefly un-hides everything.
 */
@Injectable()
export class DelistedTickersService {
  private readonly logger = new Logger(DelistedTickersService.name);
  private set = new Set<string>();
  private loadedAt = 0;
  private loading: Promise<Set<string>> | null = null;

  constructor(private readonly firebase: FirebaseAdminService) {}

  async get(): Promise<Set<string>> {
    if (Date.now() - this.loadedAt < TTL_MS) return this.set;
    if (this.loading !== null) return this.loading;
    this.loading = (async () => {
      try {
        const snap = await this.firebase.firestore
          .collection("tickers")
          .where("active", "==", false)
          .select()
          .get();
        this.set = new Set(snap.docs.map((d) => d.id.toUpperCase()));
        this.loadedAt = Date.now();
      } catch (err) {
        this.logger.warn(
          `delisted set load failed, keeping previous (${this.set.size}): ${(err as Error).message}`,
        );
      }
      return this.set;
    })().finally(() => (this.loading = null));
    return this.loading;
  }

  async isDelisted(ticker: string | null | undefined): Promise<boolean> {
    if (!ticker) return false;
    return (await this.get()).has(ticker.toUpperCase());
  }

  /**
   * Drops rows whose `ticker` (or `symbol`) is delisted. Rows carrying neither
   * field — market-wide docs like sectors or macro events — pass through.
   */
  async filterRows<T>(rows: T[]): Promise<T[]> {
    const set = await this.get();
    if (set.size === 0) return rows;
    return rows.filter((r) => {
      const o = r as { ticker?: unknown; symbol?: unknown };
      const t =
        typeof o.ticker === "string"
          ? o.ticker
          : typeof o.symbol === "string"
            ? o.symbol
            : null;
      return !t || !set.has(t.toUpperCase());
    });
  }

  /** Called after the universe job marks new delistings, so this instance sees them at once. */
  invalidate(): void {
    this.loadedAt = 0;
  }
}
