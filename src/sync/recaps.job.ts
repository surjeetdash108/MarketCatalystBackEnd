import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { setWithCreatedAt } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { isoDate } from "../common/date.util";

/**
 * End-of-Day recap → `recaps/{date}` (delivery-plan R28).
 *
 * A recap is a frozen EOD SNAPSHOT of data that already lives in other synced
 * collections — indices, movers, sectors and breadth. It composes them (it does
 * not call any vendor) into one document so `recap.tsx` can render a real,
 * date-stamped recap instead of the hardcoded "Tuesday May 21" it shipped with.
 *
 * Deliberately snapshot-per-day rather than a live read: the recap for a past
 * session must not change when the underlying collections advance. It runs after
 * the 18:00 ET EOD jobs (market-movers / sectors / market-breadth), at 18:45 ET.
 *
 * The NARRATIVE lead (the prose "stocks closed higher because…") is NOT produced
 * here — that is AI copy tracked under R36 (Anthropic). This job owns the DATA.
 */

const JOB_NAME = "recaps";
const TOP_N = 6;


@Injectable()
export class RecapsJob implements OnModuleInit {
  private readonly logger = new Logger(RecapsJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["recaps"],
      cronExpression: "45 18 * * 1-5",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  private num(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }

  async run() {
    try {
      const db = this.firebase.firestore;
      const weekAgo = isoDate(new Date(Date.now() - 7 * 86_400_000));
      const [
        indicesSnap,
        moversSnap,
        sectorsSnap,
        breadthSnap,
        idxHistSnap,
        secHistSnap,
      ] = await Promise.all([
        db.collection("market_indices").get(),
        db.collection("market_movers").get(),
        db.collection("sectors").get(),
        db.collection("market_breadth").get(),
        db
          .collection("market_indices_history")
          .where("asOfDate", ">=", weekAgo)
          .get(),
        db.collection("sectors_history").where("asOfDate", ">=", weekAgo).get(),
      ]);

      // Indices (SPX/NDX/DJI/RUT/VIX/US10Y/…) — label, value, % move.
      const indices = indicesSnap.docs.map((d) => {
        const x = d.data();
        return {
          id: d.id,
          label: x.label ?? d.id,
          value: this.num(x.value),
          pctChange: this.num(x.pctChange),
          change: this.num(x.change),
          isProxy: !!x.isProxy,
          proxyTicker: x.proxyTicker ?? null,
          unit: x.unit ?? null,
        };
      });

      // Movers → top gainers / losers by % change.
      const movers = moversSnap.docs
        .map((d) => {
          const x = d.data();
          return {
            ticker: x.ticker ?? d.id,
            name: x.name ?? x.ticker ?? d.id,
            price: this.num(x.price),
            pctChange: this.num(x.pctChange),
            sector: x.sector ?? null,
            cap: x.cap ?? null,
          };
        })
        .filter((m) => m.pctChange != null);
      const byPct = [...movers].sort(
        (a, b) => (b.pctChange ?? 0) - (a.pctChange ?? 0),
      );
      const topGainers = byPct.slice(0, TOP_N);
      const topLosers = byPct.slice(-TOP_N).reverse();

      // Sectors → leaders / laggards by % change.
      const sectors = sectorsSnap.docs
        .map((d) => {
          const x = d.data();
          return { sector: x.sector ?? d.id, pctChange: this.num(x.pctChange) };
        })
        .filter((s) => s.pctChange != null)
        .sort((a, b) => (b.pctChange ?? 0) - (a.pctChange ?? 0));
      const sectorLeaders = sectors.slice(0, 3);
      const sectorLaggards = sectors.slice(-3).reverse();

      // Internals → the latest breadth day.
      const breadth = breadthSnap.docs
        .map((d) => ({ id: d.id, data: d.data() }))
        .sort((a, b) => b.id.localeCompare(a.id))[0]?.data;
      const breadthId = breadthSnap.docs
        .map((d) => d.id)
        .sort((a, b) => b.localeCompare(a))[0];
      const internals = breadth
        ? {
            date: breadthId,
            advancers: this.num(breadth.advancers),
            decliners: this.num(breadth.decliners),
            netAdvancers: this.num(breadth.netAdvancers),
            breadthPct: this.num(breadth.breadthPct),
            trin: this.num(breadth.trin),
            mcclellan: this.num(breadth.mcclellan),
            upVolume: this.num(breadth.upVolume),
            downVolume: this.num(breadth.downVolume),
          }
        : null;

      // ── Weekly aggregates (delivery-plan R28 weekly tab) ──
      // Index weekly % = price move from the first to the last history row this
      // week (values are already scaled to the index level). Sector weekly % =
      // the daily sector %s compounded across the week (sectors carry no level).
      const idxByLabel = new Map<
        string,
        { asOfDate: string; value: number | null }[]
      >();
      for (const d of idxHistSnap.docs) {
        const x = d.data();
        const label = (x.label as string) ?? d.id;
        const arr = idxByLabel.get(label) ?? [];
        arr.push({ asOfDate: x.asOfDate as string, value: this.num(x.value) });
        idxByLabel.set(label, arr);
      }
      const weeklyIndices = [...idxByLabel.entries()].map(([label, rows]) => {
        const sorted = rows
          .filter((r) => r.value != null && r.asOfDate)
          .sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));
        if (sorted.length < 2) return { label, pctChange: null };
        const first = sorted[0].value;
        const last = sorted[sorted.length - 1].value;
        const pct = first !== 0 ? ((last - first) / first) * 100 : null;
        return {
          label,
          pctChange: pct == null ? null : Math.round(pct * 100) / 100,
        };
      });

      const secByName = new Map<string, number[]>();
      for (const d of secHistSnap.docs) {
        const x = d.data();
        const name = (x.sector as string) ?? d.id;
        const pc = this.num(x.pctChange);
        if (pc == null) continue;
        const arr = secByName.get(name) ?? [];
        arr.push(pc);
        secByName.set(name, arr);
      }
      const weeklySectors = [...secByName.entries()]
        .map(([sector, pcts]) => {
          const compound =
            (pcts.reduce((acc, p) => acc * (1 + p / 100), 1) - 1) * 100;
          return { sector, pctChange: Math.round(compound * 100) / 100 };
        })
        .sort((a, b) => b.pctChange - a.pctChange);
      const weekly = {
        indices: weeklyIndices,
        sectorLeaders: weeklySectors.slice(0, 3),
        sectorLaggards: weeklySectors.slice(-3).reverse(),
      };

      const date = breadthId ?? isoDate(new Date());
      await setWithCreatedAt(db, db.collection("recaps").doc(date), {
        date,
        indices,
        topGainers,
        topLosers,
        sectorLeaders,
        sectorLaggards,
        internals,
        weekly,
        // Narrative is R36 (Anthropic) — this job intentionally leaves it null.
        narrative: null,
        source: "polygon-derived",
        updatedAt: new Date().toISOString(),
      });

      await this.meta.record(JOB_NAME, { ok: true, count: 1 });
      this.logger.log(
        `recap ${date}: ${indices.length} indices, ${topGainers.length}/${topLosers.length} movers, ` +
          `${sectorLeaders.length}/${sectorLaggards.length} sector lead/lag, internals ${internals ? "yes" : "no"}`,
      );
      return { date, gainers: topGainers.length, losers: topLosers.length };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: err.message });
      throw err;
    }
  }
}
