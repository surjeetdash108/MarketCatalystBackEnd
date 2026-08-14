import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { EARNINGS_ESTIMATES_ADAPTER } from "../adapters/types";
import type { EarningsEstimatesAdapter } from "../adapters/earnings-estimates.adapter";

const JOB_NAME = "earnings";
// Reported quarters come from Polygon SEC financials keyed on `filing_date`
// (past-only — Polygon has no calendar/estimate feed). When an estimates adapter
// (FMP) is configured it ALSO adds a forward window of upcoming reports, filling
// the calendar gap Polygon structurally cannot: those rows carry consensus
// estimates and `epsActual: null` until the company files.
const LOOKBACK_DAYS = 180;
// How far ahead to pull the FMP upcoming-earnings calendar. Only used when the
// estimates adapter is present; 0 upcoming rows written otherwise.
const LOOKAHEAD_DAYS = 45;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

@Injectable()
export class EarningsJob implements OnModuleInit {
  private readonly logger = new Logger(EarningsJob.name);

  constructor(
    private readonly polygon: PolygonService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    // Optional supplementary estimates (FMP). null when EARNINGS_ESTIMATES_SOURCE
    // = "none" (default) — the job then behaves exactly as a Polygon-only build.
    @Inject(EARNINGS_ESTIMATES_ADAPTER)
    private readonly estimates: EarningsEstimatesAdapter | null,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["earnings_events"],
      cronExpression: "0 6 * * *",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const to = isoDate(new Date());
      const from = isoDate(addDays(new Date(), -LOOKBACK_DAYS));
      const rows = await this.polygon.getFinancialsByFilingDate(from, to);
      // Optional analyst-estimate overlay (FMP). One bulk load for the window;
      // null/no-match leaves the actuals-only behaviour untouched.
      const est = this.estimates
        ? await this.estimates.loadWindow(from, to)
        : null;
      let estimateMatches = 0;
      const docs = rows
        .filter((r) => r.filingDate)
        .map((r) => {
          const e = est?.estimateFor(r.ticker, r.filingDate) ?? null;
          if (e && (e.epsEstimate != null || e.revenueEstimate != null))
            estimateMatches++;
          return {
            id: `${r.ticker}_${r.filingDate}`,
            data: {
              ticker: r.ticker,
              companyName: r.companyName,
              // Reporting date = SEC filing date (Polygon has no announcement feed).
              date: r.filingDate,
              periodEnd: r.periodEnd,
              fiscalPeriod: r.fiscalPeriod,
              fiscalYear: r.fiscalYear,
              // Session stays null (no feed); estimates come from the optional
              // adapter when configured, else null (Polygon has none).
              session: null,
              epsEstimate: e?.epsEstimate ?? null,
              epsActual: r.epsActual,
              revenueEstimate: e?.revenueEstimate ?? null,
              revenueActual: r.revenueActual,
              updatedAt: new Date().toISOString(),
            },
          };
        });
      // Forward calendar (FMP): upcoming reports carry estimates but no actual
      // yet — written as `epsActual: null` rows so the hub shows today's and
      // coming reporters. Reported rows always win on id collision. Skipped
      // entirely when no estimates adapter is configured (Polygon-only build).
      let forwardCount = 0;
      if (this.estimates) {
        const fwdTo = isoDate(addDays(new Date(), LOOKAHEAD_DAYS));
        const upcoming = await this.estimates.getUpcoming(to, fwdTo);
        const reportedIds = new Set(docs.map((d) => d.id));
        const nameByTicker = await this.loadCompanyNames();
        for (const u of upcoming) {
          // FMP's calendar is WORLDWIDE (Shenzhen/HK/EU tickers etc.). This app
          // tracks only the US Polygon universe, so restrict upcoming rows to
          // tickers we actually cover — which also guarantees a display name.
          const name = nameByTicker.get(u.ticker);
          if (!name) continue;
          const id = `${u.ticker}_${u.date}`;
          if (reportedIds.has(id)) continue; // a reported quarter already covers it
          docs.push({
            id,
            data: {
              ticker: u.ticker,
              companyName: name,
              date: u.date,
              periodEnd: null,
              fiscalPeriod: null,
              fiscalYear: null,
              session: null,
              epsEstimate: u.epsEstimate,
              epsActual: null,
              revenueEstimate: u.revenueEstimate,
              revenueActual: null,
              updatedAt: new Date().toISOString(),
            },
          });
          forwardCount++;
        }
      }

      await chunkedBatchSet(this.firebase.firestore, "earnings_events", docs);

      // Full refresh: the collection must hold exactly this run's rows (reported
      // quarters + FMP upcoming). Delete any doc not in the new set — including
      // forward rows whose date passed without a filing (they roll out of the
      // upcoming window and are replaced by the reported quarter, or dropped).
      const keep = new Set(docs.map((d) => d.id));
      const col = this.firebase.firestore.collection("earnings_events");
      const stale = (await col.listDocuments()).filter(
        (ref) => !keep.has(ref.id),
      );
      for (let i = 0; i < stale.length; i += 400) {
        const batch = this.firebase.firestore.batch();
        for (const ref of stale.slice(i, i + 400)) batch.delete(ref);
        await batch.commit();
      }

      await this.meta.record(JOB_NAME, { ok: true, count: docs.length });
      const estNote = this.estimates
        ? `, ${estimateMatches} with ${this.estimates.sourceName} estimates, ${forwardCount} upcoming`
        : "";
      this.logger.log(
        `earnings: wrote ${docs.length} rows (${from}..${to})${estNote}, removed ${stale.length} stale`,
      );
      return {
        count: docs.length,
        removed: stale.length,
        estimateMatches,
        forwardCount,
      };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }

  /** ticker → display name from the `companies` collection (doc id is ticker),
   * so FMP upcoming rows (symbol-only) show a company name in the hub. */
  private async loadCompanyNames(): Promise<Map<string, string>> {
    const snap = await this.firebase.firestore
      .collection("companies")
      .select("name")
      .get();
    const map = new Map<string, string>();
    snap.forEach((d) => {
      const n = d.get("name");
      if (typeof n === "string" && n) map.set(d.id.toUpperCase(), n);
    });
    return map;
  }
}
