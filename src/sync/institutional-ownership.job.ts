import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { TICKER_UNIVERSE } from "../common/ticker-universe";
import { FmpService } from "../vendors/fmp/fmp.service";
import { SyncRegistry } from "../common/sync-registry.service";

const JOB_NAME = "institutional-ownership";
const BATCH_SIZE = 25;
// Large caps always have 13F holders — used only to discover the most recent
// published reporting quarter once per run (rollups lag the quarter by ~45d).
const REFERENCE_TICKERS = ["AAPL", "MSFT", "NVDA"];

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

      const docs = [];
      for (const ticker of batch) {
        try {
          const row = await this.fmp.getInstitutionalOwnership(
            ticker,
            period.year,
            period.quarter,
          );
          if (!row) continue;
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
