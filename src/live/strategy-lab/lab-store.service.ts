import { Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "../../common/firebase-admin.provider";
import { activeUniverse } from "../../common/ticker-universe";
import { decodePack, encodePack, type BarPack } from "./bar-pack";

/** Candle sizes kept as stored intraday packs (the library's intraday strategies use these). */
export const STORED_INTRADAY = ["5m", "15m"] as const;
export type StoredIntraday = (typeof STORED_INTRADAY)[number];
/** Calendar days of history kept per stored intraday candle (the largest period offered for it). */
export const INTRADAY_WINDOW_DAYS: Record<StoredIntraday, number> = {
  "5m": 30,
  "15m": 90,
};
/** Years of daily history kept (the 10Y backtest needs one more year of warm-up). */
export const DAILY_YEARS = 11;

const DAILY_COL = "lab_bars";
const INTRADAY_COL = "lab_ibars";
const META_COL = "lab_meta";
/** Intraday packs held in memory for on-demand runs before re-reading. */
const INTRADAY_MEM_MS = 4 * 60_000;
const READ_CONCURRENCY = 16;

export interface UniverseEntry {
  t: string;
  n: string;
}

/**
 * Firestore-backed bar packs for Strategy Lab (one doc per stock per candle)
 * plus the per-instance memory cache the live service backtests from.
 * Workers write the packs (StrategyLabDailyJob / StrategyLabIntradayJob);
 * the live service only reads them.
 */
@Injectable()
export class LabStoreService {
  private readonly logger = new Logger(LabStoreService.name);
  private dailyMem: { asOf: string; packs: Map<string, BarPack> } | null = null;
  private dailyLoading: Promise<Map<string, BarPack>> | null = null;
  private readonly intraMem = new Map<
    string,
    { at: number; asOf: string; packs: Map<string, BarPack> }
  >();
  private universeMem: { at: number; list: UniverseEntry[] } | null = null;

  constructor(private readonly firebase: FirebaseAdminService) {}

  private get db() {
    return this.firebase.firestore;
  }

  /** The tracked universe (same list every per-ticker job uses) with display names. */
  async universe(): Promise<UniverseEntry[]> {
    if (this.universeMem && Date.now() - this.universeMem.at < 3_600_000)
      return this.universeMem.list;
    const [tickers, names] = await Promise.all([
      activeUniverse(this.db),
      this.db.collection("companies").select("name").get(),
    ]);
    const nameOf = new Map(
      names.docs.map((d) => [d.id, String(d.get("name") ?? d.id)]),
    );
    const list = tickers.map((t) => ({ t, n: nameOf.get(t) ?? t }));
    this.universeMem = { at: Date.now(), list };
    return list;
  }

  // ── Daily packs ──────────────────────────────────────────────────────────
  async readDaily(t: string): Promise<BarPack | null> {
    const snap = await this.db.collection(DAILY_COL).doc(t).get();
    return snap.exists
      ? decodePack(snap.data() as Record<string, unknown>)
      : null;
  }

  async writeDaily(t: string, p: BarPack): Promise<void> {
    await this.db
      .collection(DAILY_COL)
      .doc(t)
      .set({
        ticker: t,
        ...encodePack(p),
        updatedAt: new Date().toISOString(),
      });
  }

  /** {ticker → last bar date, bar count} without downloading the columns. */
  async dailyIndex(): Promise<Map<string, { last: string | null; n: number }>> {
    const snap = await this.db.collection(DAILY_COL).select("last", "n").get();
    return new Map(
      snap.docs.map((d) => [
        d.id,
        { last: (d.get("last") as string) ?? null, n: Number(d.get("n") ?? 0) },
      ]),
    );
  }

  /**
   * Every universe stock's daily pack, held in memory until the stored data
   * moves to a newer session (lab_meta/daily.asOf).
   */
  async allDaily(): Promise<{
    asOf: string | null;
    packs: Map<string, BarPack>;
  }> {
    const asOf = (await this.getMeta("daily"))?.asOf ?? null;
    if (this.dailyMem && asOf && this.dailyMem.asOf === asOf)
      return { asOf, packs: this.dailyMem.packs };
    this.dailyLoading ??= this.loadAll(
      DAILY_COL,
      (await this.universe()).map((u) => u.t),
      (t) => t,
    ).finally(() => (this.dailyLoading = null));
    const packs = await this.dailyLoading;
    if (asOf) this.dailyMem = { asOf, packs };
    return { asOf, packs };
  }

  // ── Intraday packs ───────────────────────────────────────────────────────
  private intraId = (t: string, tf: string) => `${tf}_${t}`;

  async readIntraday(t: string, tf: StoredIntraday): Promise<BarPack | null> {
    const snap = await this.db
      .collection(INTRADAY_COL)
      .doc(this.intraId(t, tf))
      .get();
    return snap.exists
      ? decodePack(snap.data() as Record<string, unknown>)
      : null;
  }

  async writeIntraday(
    t: string,
    tf: StoredIntraday,
    p: BarPack,
  ): Promise<void> {
    await this.db
      .collection(INTRADAY_COL)
      .doc(this.intraId(t, tf))
      .set({
        ticker: t,
        tf,
        ...encodePack(p),
        updatedAt: new Date().toISOString(),
      });
  }

  async allIntraday(
    tf: StoredIntraday,
  ): Promise<{ asOf: string | null; packs: Map<string, BarPack> }> {
    const asOf = (await this.getMeta(`intraday_${tf}`))?.asOf ?? null;
    const hit = this.intraMem.get(tf);
    if (hit && hit.asOf === asOf && Date.now() - hit.at < INTRADAY_MEM_MS)
      return { asOf, packs: hit.packs };
    const packs = await this.loadAll(
      INTRADAY_COL,
      (await this.universe()).map((u) => u.t),
      (t) => this.intraId(t, tf),
    );
    this.intraMem.set(tf, { at: Date.now(), asOf: asOf ?? "", packs });
    return { asOf, packs };
  }

  // ── Meta ─────────────────────────────────────────────────────────────────
  async getMeta(name: string): Promise<Record<string, any> | null> {
    const snap = await this.db.collection(META_COL).doc(name).get();
    return snap.exists ? (snap.data() as Record<string, any>) : null;
  }

  async setMeta(name: string, data: Record<string, unknown>): Promise<void> {
    await this.db
      .collection(META_COL)
      .doc(name)
      .set({ ...data, updatedAt: new Date().toISOString() }, { merge: true });
  }

  private async loadAll(
    col: string,
    tickers: string[],
    idOf: (t: string) => string,
  ): Promise<Map<string, BarPack>> {
    const out = new Map<string, BarPack>();
    const t0 = Date.now();
    for (let i = 0; i < tickers.length; i += READ_CONCURRENCY * 8) {
      const chunk = tickers.slice(i, i + READ_CONCURRENCY * 8);
      const refs = chunk.map((t) => this.db.collection(col).doc(idOf(t)));
      const snaps = await this.db.getAll(...refs);
      snaps.forEach((s, k) => {
        if (s.exists)
          out.set(chunk[k], decodePack(s.data() as Record<string, unknown>));
      });
    }
    this.logger.log(
      `loaded ${out.size}/${tickers.length} ${col} packs in ${Date.now() - t0}ms`,
    );
    return out;
  }
}
