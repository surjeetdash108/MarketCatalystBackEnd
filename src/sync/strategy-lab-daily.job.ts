import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { FmpService } from "../vendors/fmp/fmp.service";
import { fromFmpSymbol } from "../vendors/market-data/fmp-mapping.util";
import { StrategyLabService } from "../live/strategy-lab.service";
import {
  mergeRows,
  packFromRows,
  packToRows,
  type LabBar,
} from "../live/strategy-lab/bar-pack";
import {
  DAILY_YEARS,
  LabStoreService,
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
  type UniverseRow,
} from "../live/strategy-lab/universe-runner";
import { LAB_STRATEGIES } from "../live/strategy-lab/strategies";

const JOB_NAME = "strategy-lab-daily";
/** A stored pack further behind than this is re-fetched whole instead of patched from bulk files. */
const MAX_BULK_DAYS = 10;
const FETCH_CONCURRENCY = 8;
const CHUNK = 100;
const DAY = 86_400_000;

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
const isWeekday = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5;
};

/** Weekdays strictly after `after` up to and including `upTo` (ET dates), oldest first. */
export function weekdaysBetween(after: string, upTo: string): string[] {
  const out: string[] = [];
  for (
    let ms = Date.parse(`${after}T12:00:00Z`) + DAY;
    ms <= Date.parse(`${upTo}T12:00:00Z`);
    ms += DAY
  ) {
    const day = new Date(ms).toISOString().slice(0, 10);
    if (isWeekday(day)) out.push(day);
  }
  return out;
}

/** Latest session whose daily bar is final: today after 16:15 ET on a weekday, else the previous weekday. */
export function lastCompletedSession(now = Date.now()): string {
  let day = etDay(now);
  if (!(isWeekday(day) && etHm(now) >= "16:15")) {
    do
      day = new Date(Date.parse(`${day}T12:00:00Z`) - DAY)
        .toISOString()
        .slice(0, 10);
    while (!isWeekday(day));
  }
  return day;
}

/** Parse FMP's eod-bulk CSV (columns by header name — its order is open, low, high, close). */
export function parseBulkEod(
  csv: string,
  wanted: Set<string>,
): Map<string, LabBar> {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const out = new Map<string, LabBar>();
  if (!lines.length) return out;
  const head = lines[0].split(",").map((h) => h.replace(/"/g, "").trim());
  const col = (name: string) => head.indexOf(name);
  const [iS, iD, iO, iH, iL, iC, iV] = [
    "symbol",
    "date",
    "open",
    "high",
    "low",
    "close",
    "volume",
  ].map(col);
  if ([iS, iD, iO, iH, iL, iC, iV].some((i) => i < 0))
    throw new Error("eod-bulk: unexpected columns " + head.join(","));
  for (let k = 1; k < lines.length; k++) {
    const f = lines[k].split(",");
    const sym = fromFmpSymbol(f[iS].replace(/"/g, ""));
    if (!wanted.has(sym)) continue;
    const o = Number(f[iO]),
      h = Number(f[iH]),
      l = Number(f[iL]),
      c = Number(f[iC]),
      v = Number(f[iV]);
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
    out.set(sym, [
      f[iD].replace(/"/g, ""),
      o,
      h,
      l,
      c,
      Number.isFinite(v) ? v : 0,
    ]);
  }
  return out;
}

/**
 * Strategy Lab daily data + precompute (worker). After the close:
 *  1. Daily packs: full 11-year fetch for stocks with no pack, a split in the
 *     last 10 days, or a gap too big to patch; everyone else gets the missing
 *     sessions appended from FMP's bulk EOD file (one call per session).
 *  2. Runs every runnable daily library strategy across the universe with the
 *     default settings and stores the results, so "Run backtest" on a library
 *     strategy is a cache read.
 */
@Injectable()
export class StrategyLabDailyJob implements OnModuleInit {
  private readonly logger = new Logger(StrategyLabDailyJob.name);

  constructor(
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly fmp: FmpService,
    private readonly lab: StrategyLabService,
    private readonly store: LabStoreService,
    private readonly results: LabResultsService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["lab_bars", "lab_results", "lab_meta"],
      cronExpression: "30 17 * * 1-5",
      timeZone: "America/New_York",
    });
  }

  async run() {
    try {
      const bars = await this.updatePacks();
      const pre = await this.precompute();
      await this.meta.record(JOB_NAME, { ok: true, count: bars.updated });
      return { ...bars, ...pre };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  async updatePacks() {
    const t0 = Date.now();
    const universe = (await this.store.universe()).map((u) => u.t);
    const want = new Set(universe);
    const index = await this.store.dailyIndex();
    const session = lastCompletedSession();
    const splitFrom = etDay(Date.now() - 10 * DAY);
    const splits = new Set(
      (
        (await this.fmp
          .request(`splits-calendar?from=${splitFrom}&to=${etDay(Date.now())}`)
          .catch(() => [])) as Array<Record<string, unknown>>
      )
        .map((r) => fromFmpSymbol(String(r.symbol ?? "")))
        .filter((s) => want.has(s)),
    );
    const gapFloor = new Date(
      Date.parse(`${session}T12:00:00Z`) - MAX_BULK_DAYS * DAY,
    )
      .toISOString()
      .slice(0, 10);
    const full: string[] = [],
      patch: string[] = [];
    for (const t of universe) {
      const ix = index.get(t);
      // Young listings simply have short histories — they are patched like the
      // rest; only a missing pack, a gap the bulk files can't bridge, or a split
      // (which restates every past bar) needs the whole history again.
      if (!ix || !ix.last || ix.last < gapFloor || splits.has(t)) full.push(t);
      else if (ix.last < session) patch.push(t);
    }

    // 1) Whole histories.
    let fullOk = 0,
      fullFail = 0;
    const q = [...full];
    await Promise.all(
      Array.from({ length: FETCH_CONCURRENCY }, async () => {
        while (q.length) {
          const t = q.shift() as string;
          try {
            const rows = await this.lab.fetchDaily(t, DAILY_YEARS);
            if (rows.length) {
              await this.store.writeDaily(t, packFromRows(rows, false));
              fullOk++;
            } else fullFail++;
          } catch (err) {
            fullFail++;
            this.logger.warn(
              `daily pack ${t}: ${(err as Error)?.message ?? err}`,
            );
          }
        }
      }),
    );

    // 2) Missing sessions from the bulk EOD files.
    const since = patch.reduce((m, t) => {
      const l = index.get(t)?.last as string;
      return l < m ? l : m;
    }, session);
    const days = weekdaysBetween(since, session);
    const byDay = new Map<string, Map<string, LabBar>>();
    for (const day of days) {
      const csv = await this.fmp
        .requestText(`eod-bulk?date=${day}`)
        .catch(() => "");
      const rows = parseBulkEod(csv, want);
      if (rows.size) byDay.set(day, rows); // a market holiday has no US rows
    }
    const keepFrom = Date.parse(
      `${etDay(Date.now() - (DAILY_YEARS * 365.25 + 7) * DAY)}T00:00:00Z`,
    );
    let patched = 0;
    for (let i = 0; i < patch.length; i += CHUNK) {
      await Promise.all(
        patch.slice(i, i + CHUNK).map(async (t) => {
          const last = index.get(t)?.last as string;
          const add = days
            .filter((d) => d > last)
            .map((d) => byDay.get(d)?.get(t))
            .filter((r): r is LabBar => !!r);
          if (!add.length) return;
          const pack = await this.store.readDaily(t);
          if (!pack) return;
          await this.store.writeDaily(
            t,
            packFromRows(mergeRows(packToRows(pack), add, keepFrom), false),
          );
          patched++;
        }),
      );
    }

    const fresh = await this.store.dailyIndex();
    const asOf = [...fresh.values()].reduce(
      (m, x) => (x.last && x.last > m ? x.last : m),
      "",
    );
    await this.store.setMeta("daily", {
      asOf,
      packs: fresh.size,
      universe: universe.length,
    });
    const summary = {
      session,
      asOf,
      full: full.length,
      fullOk,
      fullFail,
      patched,
      bulkDays: [...byDay.keys()],
      splits: [...splits],
      updated: fullOk + patched,
      ms: Date.now() - t0,
    };
    this.logger.log(`daily packs: ${JSON.stringify(summary)}`);
    return summary;
  }

  /** Every runnable daily library strategy × every stock, default settings. */
  async precompute() {
    const t0 = Date.now();
    const asOf = (await this.store.getMeta("daily"))?.asOf ?? null;
    const universe = await this.store.universe();
    const cfg = normalizeCfg("d", {
      stop: 0.08,
      tp: null,
      trail: null,
      costBps: 5,
      years: 5,
    });
    const strategies = LAB_STRATEGIES.filter(
      (s) => s.tf === "d" && !ruleProblems(s.cond).length,
    );
    const acc = new Map<
      string,
      { rows: UniverseRow[]; tested: number; unavailable: number }
    >(strategies.map((s) => [s.k, { rows: [], tested: 0, unavailable: 0 }]));
    const now = Date.now();
    for (let i = 0; i < universe.length; i += CHUNK) {
      const chunk = universe.slice(i, i + CHUNK);
      const packs = await Promise.all(
        chunk.map((u) => this.store.readDaily(u.t).catch(() => null)),
      );
      chunk.forEach((u, k) => {
        const pack = packs[k];
        const bars =
          pack && pack.t.length ? barsFor(pack, "d", cfg, now) : null;
        for (const s of strategies) {
          const a = acc.get(s.k)!;
          if (!bars) {
            a.unavailable++;
            continue;
          }
          const row = runOne(u.t, u.n, bars, s.cond, "d", cfg);
          if (!row) continue;
          a.tested++;
          if (row.st) a.rows.push(row);
        }
      });
    }
    for (const s of strategies) {
      const a = acc.get(s.k)!;
      const run: LabRun = {
        key: runKey(s.cond, "d", cfg),
        tf: "d",
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
      strategies: strategies.length,
      stocks: universe.length,
      precomputeMs: Date.now() - t0,
    };
    this.logger.log(`daily precompute: ${JSON.stringify(summary)}`);
    return summary;
  }
}
