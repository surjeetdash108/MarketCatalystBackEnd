import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { TICKER_UNIVERSE } from "../common/ticker-universe";
import { FmpService } from "../vendors/fmp/fmp.service";
import { SyncRegistry } from "../common/sync-registry.service";

const JOB_NAME = "institutional-ownership";
// Tickers per run. Env-overridable (same pattern as FINANCIALS_BATCH_SIZE) so a
// one-off history backfill can be widened without a rebuild — raise it, let two
// runs cover the universe, then put it back to 25 for steady state.
const BATCH_SIZE = Number(process.env.INSTITUTIONAL_BATCH_SIZE) || 25;
// Large caps always have 13F holders — used only to discover the most recent
// published reporting quarter once per run (rollups lag the quarter by ~45d).
const REFERENCE_TICKERS = ["AAPL", "MSFT", "NVDA"];
/** How many reporting quarters of filer history to carry on each doc. */
const HISTORY_QUARTERS = 4;

interface QuarterPoint {
  year: number;
  quarter: number;
  investorsHolding: number | null;
  ownershipPercent: number | null;
}

/** `count` reporting quarters ending at (and including) `from`, newest first. */
function quartersBack(
  from: { year: number; quarter: number },
  count: number,
): Array<{ year: number; quarter: number }> {
  let { year, quarter } = from;
  const out: Array<{ year: number; quarter: number }> = [];
  for (let i = 0; i < count; i++) {
    out.push({ year, quarter });
    quarter -= 1;
    if (quarter < 1) {
      quarter = 4;
      year -= 1;
    }
  }
  return out;
}

const periodKey = (p: { year: number; quarter: number }) =>
  `${p.year}Q${p.quarter}`;

/**
 * Ticker-indexed institutional (13F) ownership from FMP —
 * `institutional_ownership/{ticker}`. Fills the gap SEC 13F leaves: EDGAR 13F
 * positions are keyed by CUSIP, so the app cannot build a per-ticker owners/%
 * table from them. FMP publishes that rollup directly.
 *
 * FMP is the only vendor wired for this; when FMP is off (no key) the run is a
 * no-op. Cursor-batched over TICKER_UNIVERSE like the SEC sweeps, so the
 * collection fills incrementally rather than in one giant fan-out. The latest
 * reporting quarter is resolved ONCE per run (against a large-cap reference)
 * and reused for every ticker in the batch — one FMP call per ticker.
 */
@Injectable()
export class InstitutionalOwnershipJob implements OnModuleInit {
  private readonly logger = new Logger(InstitutionalOwnershipJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly fmp: FmpService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["institutional_ownership"],
      cronExpression: "0 3 * * *",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      if (!this.fmp.enabled) {
        await this.meta.record(JOB_NAME, {
          ok: true,
          count: 0,
          error: "FMP disabled (no FMP_API_KEY) — institutional ownership skipped",
        });
        return { count: 0, note: "fmp disabled" };
      }

      // Discover the most recent published (year, quarter) once, against a
      // reference large cap, so the per-ticker calls don't each re-probe.
      let period: { year: number; quarter: number } | null = null;
      for (const ref of REFERENCE_TICKERS) {
        const row = await this.fmp
          .getLatestInstitutionalOwnership(ref)
          .catch(() => null);
        if (row?.year != null && row.quarter != null) {
          period = { year: row.year, quarter: row.quarter };
          break;
        }
      }
      if (!period) {
        await this.meta.record(JOB_NAME, {
          ok: true,
          count: 0,
          error: "Could not resolve a published 13F reporting quarter from FMP",
        });
        return { count: 0, note: "no reporting quarter resolved" };
      }

      const cursor = await this.meta.getCursor(JOB_NAME);
      const batch = Array.from(
        { length: BATCH_SIZE },
        (_, i) => TICKER_UNIVERSE[(cursor + i) % TICKER_UNIVERSE.length],
      );

      // Existing docs for this batch, so history is EXTENDED rather than
      // refetched. Steady state is then one FMP call per ticker (the new
      // quarter); only a ticker with no stored history pays the backfill.
      const existing = new Map<string, QuarterPoint[]>();
      try {
        const refs = batch.map((t) =>
          this.firebase.firestore.collection("institutional_ownership").doc(t),
        );
        const snaps = await this.firebase.firestore.getAll(...refs);
        for (const snap of snaps) {
          const h = snap.exists
            ? (snap.data() as Record<string, unknown>).history
            : null;
          if (Array.isArray(h)) existing.set(snap.id, h as QuarterPoint[]);
        }
      } catch (err) {
        this.logger.warn(
          `Could not preload institutional history (will backfill): ${(err as Error).message}`,
        );
      }

      const wanted = quartersBack(period, HISTORY_QUARTERS);

      const docs = [];
      for (const ticker of batch) {
        try {
          const row = await this.fmp.getInstitutionalOwnership(
            ticker,
            period.year,
            period.quarter,
          );
          if (!row) continue;

          // Merge: keep what we already have, fetch only the missing quarters.
          const have = new Map(
            (existing.get(ticker) ?? [])
              .filter((p) => p && p.year != null && p.quarter != null)
              .map((p) => [periodKey(p), p]),
          );
          have.set(periodKey(period), {
            year: row.year,
            quarter: row.quarter,
            investorsHolding: row.investorsHolding,
            ownershipPercent: row.ownershipPercent,
          });
          // Missing quarters go out together: a first-pass ticker needs up to
          // 7 of them, and doing those sequentially made the backfill run long
          // enough to threaten the request timeout at larger batch sizes. The
          // loop over TICKERS stays sequential, so this is at most 7 in flight.
          const missing = wanted.filter((q) => !have.has(periodKey(q)));
          const fetched = await Promise.all(
            missing.map((q) =>
              this.fmp
                .getInstitutionalOwnership(ticker, q.year, q.quarter)
                .catch(() => null),
            ),
          );
          missing.forEach((q, i) => {
            const past = fetched[i];
            // Cache the miss too, so a quarter FMP has no rollup for isn't
            // re-requested on every subsequent run.
            have.set(periodKey(q), {
              year: q.year,
              quarter: q.quarter,
              investorsHolding: past?.investorsHolding ?? null,
              ownershipPercent: past?.ownershipPercent ?? null,
            });
          });
          const history = wanted
            .map((q) => have.get(periodKey(q)))
            .filter((p): p is QuarterPoint => !!p);
          docs.push({
            id: ticker,
            data: {
              ticker,
              year: row.year,
              quarter: row.quarter,
              investorsHolding: row.investorsHolding,
              lastInvestorsHolding: row.lastInvestorsHolding,
              investorsHoldingChange: row.investorsHoldingChange,
              numberOf13Fshares: row.numberOf13Fshares,
              lastNumberOf13Fshares: row.lastNumberOf13Fshares,
              numberOf13FsharesChange: row.numberOf13FsharesChange,
              totalInvested: row.totalInvested,
              ownershipPercent: row.ownershipPercent,
              putCallRatio: row.putCallRatio,
              /** Newest-first filer/ownership series, HISTORY_QUARTERS long. */
              history,
              source: "fmp",
              updatedAt: new Date().toISOString(),
            },
          });
        } catch (err) {
          this.logger.warn(
            `Failed institutional ownership for ${ticker}: ${(err as Error).message}`,
          );
        }
      }

      await chunkedBatchSet(
        this.firebase.firestore,
        "institutional_ownership",
        docs,
      );
      await this.meta.setCursor(
        JOB_NAME,
        (cursor + BATCH_SIZE) % TICKER_UNIVERSE.length,
      );
      await this.meta.record(JOB_NAME, { ok: true, count: docs.length });
      return {
        count: docs.length,
        period,
        cursorAdvancedTo: (cursor + BATCH_SIZE) % TICKER_UNIVERSE.length,
      };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: (err as Error).message });
      throw err;
    }
  }
}
