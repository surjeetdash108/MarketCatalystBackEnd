import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncMetaService } from "../common/sync-meta.service";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { activeUniverse } from "../common/ticker-universe";

const JOB_NAME = "company-quotes";

/**
 * Keeps `companies.price` / `pctChange` CURRENT for the WHOLE universe.
 *
 * WHY THIS EXISTS
 * `companies.job` is a deep per-ticker profile sweep (peers, dividends, TTM EPS,
 * sector…), so it is deliberately slow: BATCH_SIZE=60 once a day against a ~570
 * name universe — a full cycle takes ~9.5 DAYS. Nothing else refreshed the quote
 * fields on `companies` intraday (`market-quotes.job` writes the separate
 * `tickers` collection), and the on-demand path only refreshes a ticker when a
 * user actually opens it. The result: every screen reading `companies.pctChange`
 * — heatmap, screener, movers, themes — showed today's move for a handful of
 * recently-viewed names and a random past day's move for everything else, while
 * the stock drawer (which polls /live/quotes) showed the real number. Same
 * ticker, two different values, which is exactly what users reported.
 *
 * This job closes that gap cheaply: the universal-snapshot endpoint returns 250
 * tickers per call, so the entire universe is ~3 calls per run.
 *
 * It writes ONLY the quote fields (merge:true), so it never clobbers the profile
 * fields companies.job owns, the technicals technical-indicators.job owns, or
 * `volume`, which belongs to the quotes path.
 *
 * Source is `getUniversalSnapshot` — the SAME vendor call behind /live/quotes —
 * so the heatmap tile and the stock drawer now agree by construction rather than
 * by luck.
 */
const SNAPSHOT_CHUNK = 250;

/** Share of the regular session elapsed (0.05–1) at `ms`, or null before the
 *  open / on a weekend — weighting a partial day's volume for live RVOL. */
export function sessionFraction(ms: number): number | null {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hour12: false })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  if (p.weekday === "Sat" || p.weekday === "Sun") return null;
  const mins = (Number(p.hour) % 24) * 60 + Number(p.minute) - (9 * 60 + 30);
  if (mins <= 0) return null;
  return Math.min(1, Math.max(0.05, mins / 390));
}

/** How long the 20-day average volumes are reused before re-reading them. */
const AVG_VOLUME_TTL_MS = 60 * 60_000;

@Injectable()
export class CompanyQuotesJob implements OnModuleInit {
  private readonly logger = new Logger(CompanyQuotesJob.name);
  private avgVolCache: { at: number; map: Map<string, number> } | null = null;

  /** 20-day average volume per ticker (written nightly), cached an hour. */
  private async avgVolumes(): Promise<Map<string, number>> {
    if (this.avgVolCache && Date.now() - this.avgVolCache.at < AVG_VOLUME_TTL_MS) return this.avgVolCache.map;
    const map = new Map<string, number>();
    try {
      const snap = await this.firebase.firestore.collection("companies").select("avgVolume20").get();
      for (const d of snap.docs) {
        const v = d.get("avgVolume20");
        if (typeof v === "number" && v > 0) map.set(d.id, v);
      }
      this.avgVolCache = { at: Date.now(), map };
    } catch (err) {
      this.logger.warn(`company-quotes: avg volume read failed: ${(err as Error).message}`);
    }
    return this.avgVolCache?.map ?? map;
  }

  constructor(
    private readonly polygon: PolygonService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["companies"],
      // Every 5 minutes across extended trading (04:00–20:00 ET, weekdays).
      // Outside that window quotes don't move, so the last run's close stands.
      cronExpression: "*/5 4-20 * * 1-5",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const universe = await activeUniverse(this.firebase.firestore);
      if (universe.length === 0) {
        this.logger.warn("company-quotes: empty universe — nothing to refresh");
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { count: 0 };
      }

      const now = new Date().toISOString();
      const docs: Array<{ id: string; data: Record<string, unknown> }> = [];
      const avgVol = await this.avgVolumes();
      const fraction = sessionFraction(Date.now());
      let missing = 0;

      for (let i = 0; i < universe.length; i += SNAPSHOT_CHUNK) {
        const chunk = universe.slice(i, i + SNAPSHOT_CHUNK);
        const snaps = await this.polygon
          .getUniversalSnapshot(chunk)
          .catch((err) => {
            // One bad chunk must not lose the whole run — the other chunks
            // still refresh, and the next run retries this one.
            this.logger.warn(
              `company-quotes: snapshot chunk ${i}-${i + chunk.length} failed: ${err.message}`,
            );
            return [];
          });
        const seen = new Set<string>();
        for (const s of snaps) {
          if (!s.ticker || s.price == null) continue;
          seen.add(s.ticker);
          // Live relative volume: today's volume against the 20-day average
          // scaled to the share of the session elapsed (TradingView's "relative
          // volume at time"). The stored daily rvol is the LAST session's, so
          // ISRG read 2.8x the morning after its earnings day. Not written
          // before the open, when there is no session volume yet.
          const avg = avgVol.get(s.ticker);
          const liveRvol =
            fraction != null && s.volume != null && avg != null && avg > 0
              ? Math.round((s.volume / (avg * fraction)) * 100) / 100
              : undefined;
          docs.push({
            id: s.ticker,
            data: {
              price: s.price,
              pctChange: s.changePercent ?? null,
              prevClose: s.previousClose ?? null,
              ...(liveRvol !== undefined ? { rvol: liveRvol, dayVolume: s.volume } : {}),
              quoteUpdatedAt: now,
              updatedAt: now,
            },
          });
        }
        missing += chunk.length - seen.size;
      }

      // Data-loss guard: a non-throwing empty upstream would otherwise record a
      // "successful" run that refreshed nothing, masking a broken vendor.
      if (docs.length === 0) {
        this.logger.warn(
          `company-quotes: 0 of ${universe.length} tickers returned a quote — skipping write`,
        );
        await this.meta.record(JOB_NAME, {
          ok: false,
          error: "snapshot returned no quotes for any ticker",
        });
        return { count: 0 };
      }

      await chunkedBatchSet(this.firebase.firestore, "companies", docs);
      await this.meta.record(JOB_NAME, { ok: true, count: docs.length });
      this.logger.log(
        `company-quotes: refreshed ${docs.length}/${universe.length} quotes` +
          (missing > 0 ? ` (${missing} without a snapshot)` : ""),
      );
      return { count: docs.length, missing };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: err.message });
      throw err;
    }
  }
}
