import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  batchSetWithCreatedAt,
  type PendingWrite,
} from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { SECTORS_ADAPTER, type SectorsAdapter } from "../adapters/types";
import { SyncRegistry } from "../common/sync-registry.service";

const JOB_NAME = "sectors";

function slug(sector: string): string {
  return sector
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

@Injectable()
export class SectorsJob implements OnModuleInit {
  private readonly logger = new Logger(SectorsJob.name);

  constructor(
    @Inject(SECTORS_ADAPTER) private readonly sectors: SectorsAdapter,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["sectors", "sectors_history"],
      cronExpression: "0 18 * * 1-5",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  /**
   * Cap-weighted sector performance computed from our OWN constituents.
   *
   * This used to read 11 SPDR sector ETFs through the sectors adapter, and the
   * docs it wrote carried a permanent STALE_DATA warning saying so ("Derived
   * from 11 SPDR sector ETFs, not true cap-weighted sector aggregates").
   * That approach cannot survive the move to the TradingView/FactSet taxonomy:
   * it has 20 sectors (Electronic Technology, Health Technology, Distribution
   * Services, …) and no ETF exists for them, so there is nothing to proxy.
   *
   * Aggregating the companies collection is both the only option and the more
   * accurate one — it is a real cap-weighted aggregate of the universe we
   * actually show, so the warning goes away rather than being restated.
   */
  async run() {
    try {
      const db = this.firebase.firestore;
      const snap = await db.collection("companies").get();

      const agg = new Map<
        string,
        { weighted: number; capSum: number; members: number }
      >();
      for (const d of snap.docs) {
        const c = d.data() as {
          sector?: string | null;
          marketCap?: number | null;
          pctChange?: number | null;
        };
        const sector = c.sector?.trim();
        // A member needs both a weight and a move; anything else would either
        // skew the average or contribute nothing.
        if (!sector || c.marketCap == null || c.pctChange == null) continue;
        if (!(c.marketCap > 0) || !Number.isFinite(c.pctChange)) continue;
        const cur = agg.get(sector) ?? { weighted: 0, capSum: 0, members: 0 };
        cur.weighted += c.marketCap * c.pctChange;
        cur.capSum += c.marketCap;
        cur.members += 1;
        agg.set(sector, cur);
      }

      const date = new Date().toISOString().slice(0, 10);
      const writes: PendingWrite[] = [];
      const col = db.collection("sectors");
      const historyCol = db.collection("sectors_history");

      for (const [sector, a] of agg) {
        if (a.capSum <= 0) continue;
        const doc = {
          sector,
          exchange: "constituent-weighted",
          pctChange: Math.round((a.weighted / a.capSum) * 100) / 100,
          memberCount: a.members,
          asOfDate: date,
          source: "companies",
          // Cleared deliberately: the ETF-proxy caveat no longer applies.
          warnings: [],
          updatedAt: new Date().toISOString(),
        };
        writes.push({ ref: col.doc(slug(sector)), data: doc });
        writes.push({
          ref: historyCol.doc(`${date}_${slug(sector)}`),
          data: doc,
          merge: false,
        });
      }

      // Sector names changed with the taxonomy migration, so docs keyed by the
      // OLD slugs would linger forever and the heatmap would render dead tiles.
      // Guarded: never wipe on an empty aggregate (a bad companies read).
      const stale: FirebaseFirestore.DocumentReference[] = [];
      if (agg.size > 0) {
        const liveSlugs = new Set([...agg.keys()].map(slug));
        const existing = await col.get();
        for (const d of existing.docs) {
          if (!liveSlugs.has(d.id)) stale.push(d.ref);
        }
      }

      await batchSetWithCreatedAt(this.firebase.firestore, writes);
      // Deleted after the writes land, so a failure mid-way leaves the old
      // tiles in place rather than an empty heatmap.
      for (const ref of stale) await ref.delete();
      const removed = stale.length;

      await this.meta.record(JOB_NAME, { ok: true, count: agg.size });
      this.logger.log(
        `sectors: ${agg.size} cap-weighted sectors from ${snap.size} companies` +
          (removed ? `, ${removed} stale sector doc(s) removed` : ""),
      );
      return { count: agg.size, removed };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: err.message });
      throw err;
    }
  }
}
