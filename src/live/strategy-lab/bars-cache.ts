import type { LabBar } from "./bar-pack";

/**
 * Least-recently-used cache of bar arrays, capped by the total number of bars
 * held (so a few 11-year daily histories and many short intraday ones are
 * weighed by what they actually cost in memory). Entries also expire by age.
 */
export class BarsLru {
  private readonly map = new Map<string, { rows: LabBar[]; at: number }>();
  private total = 0;

  constructor(private readonly maxBars: number) {}

  /** Bars currently held. */
  get bars(): number {
    return this.total;
  }

  get(key: string, maxAgeMs: number): LabBar[] | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > maxAgeMs) {
      this.drop(key);
      return undefined;
    }
    this.map.delete(key); // re-insert: Map order is recency order
    this.map.set(key, hit);
    return hit.rows;
  }

  set(key: string, rows: LabBar[]): void {
    this.drop(key);
    this.map.set(key, { rows, at: Date.now() });
    this.total += rows.length;
    for (const k of this.map.keys()) {
      if (this.total <= this.maxBars || k === key) break;
      this.drop(k);
    }
  }

  private drop(key: string): void {
    const hit = this.map.get(key);
    if (!hit) return;
    this.total -= hit.rows.length;
    this.map.delete(key);
  }
}
