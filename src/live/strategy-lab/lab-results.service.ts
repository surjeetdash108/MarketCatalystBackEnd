import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { FirebaseAdminService } from "../../common/firebase-admin.provider";
import {
  aggregateIntraday,
  indexAtOrAfter,
  packToEngineBars,
  type BarPack,
  type EngineBar,
} from "./bar-pack";
import {
  INTRADAY_WINDOW_DAYS,
  LabStoreService,
  type StoredIntraday,
  type UniverseEntry,
} from "./lab-store.service";
import {
  IPER,
  ruleProblems,
  runOne,
  tfInfo,
  type RunCfg,
  type UniverseRow,
} from "./universe-runner";

const RESULTS_COL = "lab_results";
const DAY = 86_400_000;
/** Candles folded from stored 15-minute bars. */
const AGGREGATED: Record<string, number> = { "30m": 30, "1h": 60, "4h": 240 };

export interface LabRun {
  key: string;
  tf: string;
  /** Latest bar the run used (daily date, or intraday timestamp). */
  asOf: string | null;
  computedAt: string;
  universe: number;
  tested: number;
  unavailable: number;
  /** Stocks whose entry rules are met now (ready) or nearly met (setup). */
  rows: UniverseRow[];
}

const etDay = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(
    new Date(ms),
  );

/** JSON with object keys sorted, so equal rule sets hash equally however they were built. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

export function normalizeCfg(tf: string, cfg: Partial<RunCfg>): RunCfg {
  const T = tfInfo(tf);
  const num = (v: unknown, d: number) =>
    Number.isFinite(Number(v)) ? Number(v) : d;
  const out: RunCfg = {
    stop: Math.max(0, num(cfg.stop, 0.08)),
    tp: cfg.tp == null ? null : num(cfg.tp, 0),
    trail: cfg.trail == null ? null : num(cfg.trail, 0),
    costBps: Math.max(0, num(cfg.costBps, 5)),
    years: Math.min(10, Math.max(1, Math.round(num(cfg.years, 5)))),
  };
  if (T.fmp) out.idays = Math.round(num(cfg.idays, T.days ?? 21));
  return out;
}

export const runKey = (spec: unknown, tf: string, cfg: RunCfg) =>
  createHash("sha1")
    .update(
      canonical({
        spec: { entry: (spec as any).entry, exit: (spec as any).exit },
        tf,
        cfg,
      }),
    )
    .digest("hex");

/**
 * Which stored bars a candle size is served from, or why it can't be run
 * across the universe.
 */
export function sourceFor(
  tf: string,
  cfg: RunCfg,
):
  | { kind: "daily" }
  | { kind: "intraday"; packTf: StoredIntraday; agg?: number }
  | { error: string } {
  if (tf === "d" || tf === "1w") return { kind: "daily" };
  if (tf === "5m" || tf === "15m") {
    if ((cfg.idays ?? 0) > INTRADAY_WINDOW_DAYS[tf])
      return {
        error: `${tfInfo(tf).l} history is kept for ${INTRADAY_WINDOW_DAYS[tf]} days — pick a shorter period.`,
      };
    return { kind: "intraday", packTf: tf };
  }
  if (AGGREGATED[tf]) {
    if ((cfg.idays ?? 0) > INTRADAY_WINDOW_DAYS["15m"])
      return {
        error: `${tfInfo(tf).l} candles are built from 15-min bars, kept for ${INTRADAY_WINDOW_DAYS["15m"]} days — pick a period of 90 days or less.`,
      };
    return { kind: "intraday", packTf: "15m", agg: AGGREGATED[tf] };
  }
  return {
    error: `${tfInfo(tf).l} candles can't be scanned across every stock — use 5-min or a larger candle.`,
  };
}

/** One stock's bars for a run, in the engine's shape (prototype fetchLong / fetchScan windows). */
export function barsFor(
  pack: BarPack,
  tf: string,
  cfg: RunCfg,
  now = Date.now(),
): EngineBar[] {
  const src = sourceFor(tf, cfg);
  if ("error" in src) return [];
  if (src.kind === "daily") {
    // fetchLong(s, key, years): years + 1 of history so indicators are warm at the start date.
    const from = new Date(now);
    from.setFullYear(from.getFullYear() - cfg.years - 1);
    return packToEngineBars(
      pack,
      indexAtOrAfter(pack, Date.parse(`${etDay(from.getTime())}T00:00:00Z`)),
    );
  }
  // fetchScan(s, key, tf, days): calendar days back from today.
  const fromDay = etDay(now - (cfg.idays ?? 21) * DAY);
  const bars = packToEngineBars(
    pack,
    indexAtOrAfter(pack, Date.parse(`${fromDay}T00:00:00Z`)),
  );
  return src.agg ? aggregateIntraday(bars, src.agg) : bars;
}

/**
 * Universe-wide Strategy Lab backtests: every tracked stock, results cached
 * in Firestore (lab_results/{hash of rules + candle + settings}) and reused
 * until the underlying bars move on. Library strategies are precomputed by the
 * jobs; anything else is computed here on first request.
 */
@Injectable()
export class LabResultsService {
  private readonly logger = new Logger(LabResultsService.name);
  private readonly inflight = new Map<string, Promise<LabRun>>();

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly store: LabStoreService,
  ) {}

  async validate(
    spec: any,
    tf: string,
    rawCfg: Partial<RunCfg>,
  ): Promise<LabRun> {
    const problems = ruleProblems(spec);
    if (problems.length)
      throw new BadRequestException(
        `These rules need ${problems.join(", ")} — swap them for price-based conditions to backtest.`,
      );
    const cfg = normalizeCfg(tf, rawCfg);
    const src = sourceFor(tf, cfg);
    if ("error" in src) throw new BadRequestException(src.error);
    const key = runKey(spec, tf, cfg);
    const current =
      src.kind === "daily"
        ? (await this.store.getMeta("daily"))?.asOf
        : (await this.store.getMeta(`intraday_${src.packTf}`))?.asOf;
    if (!current)
      throw new BadRequestException(
        "Strategy Lab price data is still being prepared — try again in a few minutes.",
      );
    const cached = await this.read(key);
    if (cached && cached.asOf === current) return cached;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.computeFromStore(spec, tf, cfg, key, src, current).finally(() =>
        this.inflight.delete(key),
      );
      this.inflight.set(key, p);
    }
    return p;
  }

  async read(key: string): Promise<LabRun | null> {
    const snap = await this.firebase.firestore
      .collection(RESULTS_COL)
      .doc(key)
      .get();
    return snap.exists ? (snap.data() as LabRun) : null;
  }

  async write(run: LabRun): Promise<void> {
    await this.firebase.firestore.collection(RESULTS_COL).doc(run.key).set(run);
  }

  private async computeFromStore(
    spec: any,
    tf: string,
    cfg: RunCfg,
    key: string,
    src: { kind: "daily" } | { kind: "intraday"; packTf: StoredIntraday },
    asOf: string,
  ): Promise<LabRun> {
    const t0 = Date.now();
    const universe = await this.store.universe();
    const { packs } =
      src.kind === "daily"
        ? await this.store.allDaily()
        : await this.store.allIntraday(src.packTf);
    const run = computeRun(
      universe,
      (t) => packs.get(t),
      spec,
      tf,
      cfg,
      key,
      asOf,
    );
    await this.write(run);
    this.logger.log(
      `computed ${tf} run ${key.slice(0, 8)}: ${run.tested}/${run.universe} tested, ${run.rows.length} ready/setup in ${Date.now() - t0}ms`,
    );
    return run;
  }
}

/** Run one rule set over the universe from packs (shared by the jobs and on-demand runs). */
export function computeRun(
  universe: UniverseEntry[],
  packOf: (t: string) => BarPack | undefined,
  spec: any,
  tf: string,
  cfg: RunCfg,
  key: string,
  asOf: string | null,
  now = Date.now(),
): LabRun {
  const rows: UniverseRow[] = [];
  let tested = 0,
    unavailable = 0;
  for (const u of universe) {
    const pack = packOf(u.t);
    if (!pack || !pack.t.length) {
      unavailable++;
      continue;
    }
    const row = runOne(u.t, u.n, barsFor(pack, tf, cfg, now), spec, tf, cfg);
    if (!row) continue; // too little history for the engine (it needs 260 bars)
    tested++;
    if (row.st) rows.push(row);
  }
  return {
    key,
    tf,
    asOf,
    computedAt: new Date(now).toISOString(),
    universe: universe.length,
    tested,
    unavailable,
    rows,
  };
}

export { IPER };
