/**
 * Live-fetch coalescer used by every market-data live service after the
 * cache/sync-job architecture was removed. It is NOT a persistent cache:
 *
 *   - In-flight coalescing: concurrent requests for the same key share ONE
 *     vendor call (so N simultaneous dashboard loads = 1 Polygon/FMP hit).
 *   - Tiny reuse window (`ttlMs`, default 5s): a request arriving within a few
 *     seconds of a completed fetch reuses that result instead of re-hitting the
 *     vendor. This only smooths bursts and protects rate limits — it never
 *     serves data older than `ttlMs`, and there is no cron/Firestore behind it.
 *
 * A rejected fetch is never stored, so the next request retries live.
 */
export class LiveCoalescer {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly recent = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly ttlMs = 5_000) {}

  async run<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const now = Date.now();

    const hit = this.recent.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value as T;

    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const p = (async () => {
      const value = await fetcher();
      this.recent.set(key, { at: Date.now(), value });
      this.prune();
      return value;
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, p);
    return p;
  }

  /** Drop reuse-window entries older than ttl so per-ticker keys can't grow
   *  unbounded. Cheap: only runs after a real (uncoalesced) fetch. */
  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, v] of this.recent) {
      if (v.at < cutoff) this.recent.delete(k);
    }
  }
}
