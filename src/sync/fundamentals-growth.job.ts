import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  batchSetWithCreatedAt,
  type PendingWrite,
} from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { activeUniverse } from "../common/ticker-universe";
import { FINANCIALS_ADAPTER, type FinancialsAdapter } from "../adapters/types";
import { SyncRegistry } from "../common/sync-registry.service";
import {
  ttmReportedEpsFromRows,
  latestAnnualEpsGrowth,
  type EpsHistoryRow,
} from "./financials.job";

const JOB_NAME = "fundamentals-growth";
// Configurable so a backfill can cover the whole universe in one run
// (FUNDAMENTALS_BATCH_SIZE=442), matching the financials job's pattern.
const BATCH_SIZE = Number(process.env.FUNDAMENTALS_BATCH_SIZE) || 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (n: number, p = 4) => Math.round(n * 10 ** p) / 10 ** p;

@Injectable()
export class FundamentalsGrowthJob implements OnModuleInit {
  private readonly logger = new Logger(FundamentalsGrowthJob.name);

  constructor(
    @Inject(FINANCIALS_ADAPTER) private readonly financials: FinancialsAdapter,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["companies"],
      cronExpression: "30 4 * * *",
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
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { count: 0, note: "no active tickers yet" };
      }
      // Batch never larger than the active universe, so a small
      // universe is fully covered in one premarket run.
      const cursor = await this.meta.getCursor(JOB_NAME);
      const batch = Array.from(
        { length: Math.min(BATCH_SIZE, universe.length) },
        (_, i) => universe[(cursor + i) % universe.length],
      );
      // Batch-read the fresh financials docs (for the FMP non-GAAP epsHistory —
      // financials.job runs just before this in the premarket bundle) and the
      // company docs (for the current price → non-GAAP P/E). Same-basis as the
      // earnings/EPS fix so P/E + EPS growth match NASDAQ/IBD, not GAAP.
      const finSnaps = await this.firebase.firestore.getAll(
        ...batch.map((t) => this.firebase.firestore.collection("financials").doc(t)),
      );
      const coSnaps = await this.firebase.firestore.getAll(
        ...batch.map((t) => this.firebase.firestore.collection("companies").doc(t)),
      );
      const epsHistByTicker = new Map<string, EpsHistoryRow[]>();
      const priceByTicker = new Map<string, number | null>();
      finSnaps.forEach((s) => {
        if (s.exists) epsHistByTicker.set(s.id, (s.data()?.epsHistory ?? []) as EpsHistoryRow[]);
      });
      coSnaps.forEach((s) => {
        if (s.exists) priceByTicker.set(s.id, (s.data()?.price ?? null) as number | null);
      });

      const writes = [];
      let skipped = 0;
      for (const ticker of batch) {
        try {
          const result = await this.financials.fetchIncomeStatements(
            ticker,
            "annual",
            2,
          );
          const periods = result.data;
          const [latest, prior] = periods;
          if (!latest) {
            skipped++;
            await sleep(this.financials.requestDelayMs);
            continue;
          }
          const revGrowth =
            prior &&
            prior.revenue != null &&
            prior.revenue > 0 &&
            latest.revenue != null
              ? (latest.revenue - prior.revenue) / prior.revenue
              : null;
          const epsGrowth =
            prior &&
            prior.dilutedEps != null &&
            prior.dilutedEps > 0 &&
            latest.dilutedEps != null
              ? (latest.dilutedEps - prior.dilutedEps) / prior.dilutedEps
              : null;
          const gp =
            latest.grossProfit ??
            (latest.revenue != null && latest.costOfRevenue != null
              ? latest.revenue - latest.costOfRevenue
              : null);
          const grossMargin =
            gp != null && latest.revenue != null && latest.revenue > 0
              ? gp / latest.revenue
              : null;

          // Non-GAAP (FMP consensus basis) — same as NASDAQ/IBD, from epsHistory.
          // epsTtm = last 4 reported quarters; P/E = price ÷ epsTtm; EPS growth =
          // latest-vs-prior full fiscal year. Fall back to the Polygon GAAP
          // epsGrowth only when FMP has no history yet.
          const epsHist = epsHistByTicker.get(ticker) ?? [];
          const epsTtm = ttmReportedEpsFromRows(epsHist);
          const price = priceByTicker.get(ticker) ?? null;
          const peReported =
            epsTtm != null && epsTtm > 0 && price != null && price > 0
              ? Math.round((price / epsTtm) * 100) / 100
              : null;
          const epsGrowthReported = latestAnnualEpsGrowth(epsHist);
          const epsGrowthFinal =
            epsGrowthReported != null
              ? epsGrowthReported
              : epsGrowth == null
                ? null
                : round(epsGrowth);

          writes.push({
            ticker,
            data: {
              // Conditional (merge:true): revenueGrowthYoY/epsGrowthYoY/grossMargin
              // are null when a period is missing or the prior-year base is
              // non-positive — that's "couldn't compute", not a real value. Writing
              // null onto the shared companies doc would clobber the last good
              // figure, so omit each unless computed (mirrors the eps/peRatio spread
              // below).
              ...(revGrowth != null
                ? { revenueGrowthYoY: round(revGrowth) }
                : {}),
              ...(epsGrowthFinal != null
                ? { epsGrowthYoY: epsGrowthFinal }
                : {}),
              ...(grossMargin != null
                ? { grossMargin: round(grossMargin) }
                : {}),
              fundamentalsFiscalYear: latest.fiscalYear,
              fundamentalsUpdatedAt: new Date().toISOString(),
              // Non-GAAP TTM EPS + P/E (null-safe: only override when we have the
              // FMP history + a price, else leave the profile's existing value).
              ...(epsTtm != null ? { epsTtm } : {}),
              ...(peReported != null ? { peRatio: peReported } : {}),
              ...(epsTtm != null ? { eps: epsTtm } : {}),
            },
          });
        } catch (err) {
          this.logger.error(
            `Failed fundamentals for ${ticker}: ${err.message}`,
          );
          skipped++;
        }
        await sleep(this.financials.requestDelayMs);
      }
      if (writes.length > 0) {
        const pendingWrites: PendingWrite[] = [];
        const col = this.firebase.firestore.collection("companies");
        for (const w of writes)
          // `ticker` included in the write itself: this merge-write can be
          // the FIRST write for a ticker outside the primary sync universe,
          // and a doc missing `ticker` crashes frontend code that assumes
          // the field is always present (CompanyDoc types it non-nullable)
          // — e.g. the ticker-search dropdown, 2026-08-01.
          pendingWrites.push({
            ref: col.doc(w.ticker),
            data: { ticker: w.ticker, ...w.data },
          });
        await batchSetWithCreatedAt(this.firebase.firestore, pendingWrites);
      }
      await this.meta.setCursor(
        JOB_NAME,
        (cursor + BATCH_SIZE) % universe.length,
      );
      await this.meta.record(JOB_NAME, { ok: true, count: writes.length });
      return { updated: writes.length, skipped };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
