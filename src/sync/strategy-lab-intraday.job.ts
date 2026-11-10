import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { LAB_INTRADAY, StrategyLabService } from "../live/strategy-lab.service";
import {
  lastDate,
  mergeRows,
  packFromRows,
  packToRows,
  type BarPack,
} from "../live/strategy-lab/bar-pack";
import {
  INTRADAY_WINDOW_DAYS,
  LabStoreService,
  STORED_INTRADAY,
  type StoredIntraday,
} from "../live/strategy-lab/lab-store.service";
import {
  LabResultsService,
  barsFor,
  normalizeCfg,
  runKey,
  type LabRun,
} from "../live/strategy-lab/lab-results.service";
import {
  ruleProblems,
  runOne,
  tfInfo,
  type UniverseRow,
} from "../live/strategy-lab/universe-runner";
import { LAB_STRATEGIES } from "../live/strategy-lab/strategies";

const JOB_NAME = "strategy-lab-intraday";
const DAY = 86_400_000;
const CONCURRENCY = 8;
/** Whole-window fills per candle per run — the first runs build coverage in steps so each stays well under 5 minutes. */
const MAX_FILLS_PER_RUN = Number(process.env.LAB_INTRADAY_FILLS_PER_RUN) || 250;
/** 15-min packs only need a refresh every third 5-minute run. */
const REFRESH_MS: Record<StoredIntraday, number> = {
  "5m": 4 * 60_000,
  "15m": 14 * 60_000,
};
/** A run that dies keeps the lease no longer than this. */
const LEASE_MS = 8 * 60_000;

const etDay = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(
    new Date(ms),
  );
const etHm = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));

/** Weekday 09:30–16:10 ET (a little past the close to capture the last bars). */
export function inSession(now = Date.now()): boolean {
  const d = new Date(`${etDay(now)}T12:00:00Z`).getUTCDay();
  const hm = etHm(now);
  return d >= 1 && d <= 5 && hm >= "09:30" && hm <= "16:10";
}

/**
 * Strategy Lab intraday data + precompute (worker, every 5 minutes in the
 * session). FMP has no bulk intraday feed, so each stock costs one call per
 * refresh: stored packs fetch only the bars since their last stored day.
 * After refreshing a candle size it reruns that candle's library strategies
 * across the universe, so their "ready this bar" lists stay current.
 */
@Injectable()
export class StrategyLabIntradayJob implements OnModuleInit {
  private readonly logger = new Logger(StrategyLabIntradayJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly lab: StrategyLabService,
    private readonly store: LabStoreService,
    private readonly results: LabResultsService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["lab_ibars", "lab_results", "lab_meta"],
      cronExpression: "*/5 9-16 * * 1-5",
      timeZone: "America/New_York",
    });
  }

  async run() {
    if (!(await this.acquire()))
      return { skipped: "another run holds the lease" };
    try {
      const out: Record<string, unknown> = {};
      for (const tf of STORED_INTRADAY) {
        const m = await this.store.getMeta(`intraday_${tf}`);
        const due =
          !m?.updatedAt ||
          Date.now() - Date.parse(m.updatedAt) >= REFRESH_MS[tf];
        const empty = !m?.asOf;
        if (!empty && (!due || !inSession())) {
          out[tf] = "not due";
          continue;
        }
        out[tf] = await this.refresh(tf);
      }
      await this.meta.record(JOB_NAME, { ok: true });
      return out;
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: (err as Error).message,
      });
      throw err;
    } finally {
      await this.release();
    }
  }

  private async refresh(tf: StoredIntraday) {
    const t0 = Date.now();
    const universe = await this.store.universe();
    const interval = LAB_INTRADAY[tf];
    const windowDays = INTRADAY_WINDOW_DAYS[tf];
    const keepFrom = Date.parse(
      `${etDay(Date.now() - windowDays * DAY)}T00:00:00Z`,
    );
    const windowStartDay = etDay(Date.now() - windowDays * DAY);
    const cfg = normalizeCfg(tf, {
      stop: 0.08,
      tp: null,
      trail: null,
      costBps: 5,
      years: 5,
      idays: tfInfo(tf).days,
    });
    const strategies = LAB_STRATEGIES.filter(
      (s) => s.tf === tf && !ruleProblems(s.cond).length,
    );
    const acc = new Map<
      string,
      { rows: UniverseRow[]; tested: number; unavailable: number }
    >(strategies.map((s) => [s.k, { rows: [], tested: 0, unavailable: 0 }]));
    let fills = 0,
      refreshed = 0,
      failed = 0,
      asOf = "";
    const now = Date.now();
    const q = [...universe];
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (q.length) {
          const u = q.shift()!;
          let pack: BarPack | null = null;
          try {
            pack = await this.store.readIntraday(u.t, tf);
            const last = pack ? lastDate(pack) : null;
            if (!pack || !last || last.slice(0, 10) < windowStartDay) {
              if (fills >= MAX_FILLS_PER_RUN) pack = null;
              else {
                fills++;
                const rows = await this.lab.fetchIntraday(
                  u.t,
                  interval,
                  windowDays,
                );
                pack = rows.length ? packFromRows(rows, true) : null;
                if (pack) await this.store.writeIntraday(u.t, tf, pack);
              }
            } else {
              const add = await this.lab.fetchIntradaySince(
                u.t,
                interval,
                last.slice(0, 10),
              );
              if (add.length) {
                pack = packFromRows(
                  mergeRows(packToRows(pack), add, keepFrom),
                  true,
                );
                await this.store.writeIntraday(u.t, tf, pack);
              }
              refreshed++;
            }
          } catch (err) {
            failed++;
            this.logger.warn(
              `${tf} pack ${u.t}: ${(err as Error)?.message ?? err}`,
            );
          }
          const l = pack ? lastDate(pack) : null;
          if (l && l > asOf) asOf = l;
          const bars =
            pack && pack.t.length ? barsFor(pack, tf, cfg, now) : null;
          for (const s of strategies) {
            const a = acc.get(s.k)!;
            if (!bars) {
              a.unavailable++;
              continue;
            }
            const row = runOne(u.t, u.n, bars, s.cond, tf, cfg);
            if (!row) continue;
            a.tested++;
            if (row.st) a.rows.push(row);
          }
        }
      }),
    );
    await this.store.setMeta(`intraday_${tf}`, {
      asOf,
      universe: universe.length,
      fills,
      refreshed,
      failed,
    });
    for (const s of strategies) {
      const a = acc.get(s.k)!;
      const run: LabRun = {
        key: runKey(s.cond, tf, cfg),
        tf,
        asOf,
        computedAt: new Date(now).toISOString(),
        universe: universe.length,
        tested: a.tested,
        unavailable: a.unavailable,
        rows: a.rows,
      };
      await this.results.write(run);
    }
    const summary = {
      asOf,
      fills,
      refreshed,
      failed,
      strategies: strategies.length,
      ms: Date.now() - t0,
    };
    this.logger.log(`intraday ${tf}: ${JSON.stringify(summary)}`);
    return summary;
  }

  private lockRef() {
    return this.firebase.firestore.collection("lab_meta").doc("intraday_lock");
  }

  /** Firestore lease so overlapping scheduler hits (or worker instances) never run together. */
  private async acquire(): Promise<boolean> {
    return this.firebase.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(this.lockRef());
      const until = Number(snap.get("until") ?? 0);
      if (until > Date.now()) return false;
      tx.set(this.lockRef(), {
        until: Date.now() + LEASE_MS,
        at: new Date().toISOString(),
      });
      return true;
    });
  }

  private async release() {
    await this.lockRef()
      .set({ until: 0, releasedAt: new Date().toISOString() })
      .catch(() => undefined);
  }
}
