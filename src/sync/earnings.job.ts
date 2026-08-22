import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { EARNINGS_ESTIMATES_ADAPTER } from "../adapters/types";
import type { EarningsEstimatesAdapter } from "../adapters/earnings-estimates.adapter";
import { addDays, daysBetween, isoDate } from "../common/date.util";

const JOB_NAME = "earnings";
// Reported quarters come from Polygon SEC financials keyed on `filing_date`
// (past-only — Polygon has no calendar/estimate feed). When an estimates adapter
// (FMP) is configured it ALSO adds a forward window of upcoming reports, filling
// the calendar gap Polygon structurally cannot: those rows carry consensus
// estimates and `epsActual: null` until the company files.
const LOOKBACK_DAYS = 180;
// How far back to pull FMP's announcement-based calendar (which carries actuals)
// to cover the window where a company has reported but its SEC 10-Q — the only
// thing Polygon's filing-date feed sees — hasn't posted yet (~2 weeks).
const RECENT_REPORTED_DAYS = 30;
// A Polygon 10-Q filing date and FMP's announcement date for the same quarter
// sit days-to-weeks apart; treat an FMP row within this many days of a Polygon
// reported row for the same ticker as the same quarter (avoids a duplicate).
const DUP_TOLERANCE_DAYS = 21;




/**
 * Last calendar day of the NEXT quarter after `d`. The FMP upcoming-earnings
 * window runs today → here, so the hub covers every remaining reporter in the
 * current quarter plus the whole next quarter (a natural earnings-season span)
 * rather than an arbitrary fixed day count.
 */
function endOfNextQuarter(d: Date): Date {
  const nextQ = Math.floor(d.getUTCMonth() / 3) + 1; // 1..4 (0-indexed quarter + 1)
  const year = d.getUTCFullYear() + Math.floor(nextQ / 4);
  const endMonth = (nextQ % 4) * 3 + 2; // last month of that quarter (0-indexed)
  return new Date(Date.UTC(year, endMonth + 1, 0)); // day 0 of next month = last day
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
              // Beat/miss must be like-for-like: use FMP's consensus-basis
              // actual (same basis as its estimate) when FMP matched this
              // report; fall back to Polygon's GAAP diluted EPS only when FMP
              // has no actual. Mixing GAAP actual with a non-GAAP estimate is
              // what produced bogus ±100% surprises.
              epsActual: e?.epsActual ?? r.epsActual,
              revenueEstimate: e?.revenueEstimate ?? null,
              revenueActual: r.revenueActual ?? null,
              // Year-ago comparables (same fiscal quarter, prior year) — filled
              // from the financials history below. Drive the "1 Year Ago" EPS
              // and "Yr/Yr Rev" columns of the at-a-glance snapshot.
              epsActualYearAgo: null as number | null,
              revenueYearAgo: null as number | null,
              updatedAt: new Date().toISOString(),
            },
          };
        });

      // Reported rows carry Polygon's GAAP diluted EPS and (often) no estimate,
      // because FMP's announcement date can sit >21d from the SEC filing date so
      // the calendar overlay misses. The `financials/{ticker}` docs already hold
      // the FMP matched pair (epsActualReported + epsEstimateReported, split-
      // normalized, NASDAQ basis), so reuse THAT — keyed by periodEnd === the
      // quarter endDate — as the source of truth. This makes the Hub's recent-
      // reporter feed agree with its 10-quarter history and never surface a raw
      // GAAP EPS. financials.job writes those docs; a one-run staleness is
      // harmless since a reported quarter's numbers don't change.
      const reportedTickers = [
        ...new Set(docs.map((d) => d.data.ticker as string)),
      ];
      const finPair = new Map<
        string,
        { a: number | null; e: number | null; rev: number | null }
      >();
      // Same-quarter-a-year-ago lookup, keyed ticker_fiscalPeriod_fiscalYear, so
      // a Q2-2026 report can read its Q2-2025 EPS/revenue for the year-over-year
      // columns. Uses the FMP consensus-basis actual (epsActualReported) so the
      // year-ago EPS shares a basis with the current one.
      const finFiscal = new Map<
        string,
        { eps: number | null; rev: number | null }
      >();
      for (let i = 0; i < reportedTickers.length; i += 300) {
        const refs = reportedTickers
          .slice(i, i + 300)
          .map((t) => this.firebase.firestore.collection("financials").doc(t));
        const snaps = await this.firebase.firestore.getAll(...refs);
        for (const s of snaps) {
          if (!s.exists) continue;
          const qs = (s.data()?.quarters ?? []) as Array<{
            endDate?: string;
            epsActualReported?: number | null;
            epsEstimateReported?: number | null;
            revenue?: number | null;
            fiscalPeriod?: string | null;
            fiscalYear?: string | number | null;
          }>;
          for (const q of qs) {
            if (q.endDate) {
              finPair.set(`${s.id}_${q.endDate}`, {
                a: q.epsActualReported ?? null,
                e: q.epsEstimateReported ?? null,
                rev: q.revenue ?? null,
              });
            }
            if (q.fiscalPeriod && q.fiscalYear != null) {
              finFiscal.set(`${s.id}_${q.fiscalPeriod}_${Number(q.fiscalYear)}`, {
                eps: q.epsActualReported ?? null,
                rev: q.revenue ?? null,
              });
            }
          }
        }
      }
      for (const d of docs) {
        const ticker = d.data.ticker as string;
        const pe = d.data.periodEnd as string | null;
        if (pe) {
          const m = finPair.get(`${ticker}_${pe}`);
          if (m) {
            if (m.a != null) d.data.epsActual = m.a;
            if (m.e != null) d.data.epsEstimate = m.e;
            if (m.rev != null && d.data.revenueActual == null)
              d.data.revenueActual = m.rev;
          }
        }
        // Year-ago comparables: same fiscal quarter, previous fiscal year.
        const fp = d.data.fiscalPeriod as string | null;
        const fy = d.data.fiscalYear as string | number | null;
        if (fp && fy != null) {
          const ya = finFiscal.get(`${ticker}_${fp}_${Number(fy) - 1}`);
          if (ya) {
            d.data.epsActualYearAgo = ya.eps;
            d.data.revenueYearAgo = ya.rev;
          }
        }
      }

      // Forward calendar (FMP): upcoming reports carry estimates but no actual
      // yet — written as `epsActual: null` rows so the hub shows today's and
      // coming reporters. Reported rows always win on id collision. Skipped
      // entirely when no estimates adapter is configured (Polygon-only build).
      let forwardCount = 0;
      if (this.estimates) {
        // Pull FMP's calendar from RECENT_REPORTED_DAYS back (just-announced
        // reports carry actuals — filling the gap before their 10-Q files)
        // through the next quarter (upcoming reports carry estimates only).
        const calFrom = isoDate(addDays(new Date(), -RECENT_REPORTED_DAYS));
        const fwdTo = isoDate(endOfNextQuarter(new Date()));
        const upcoming = await this.estimates.getUpcoming(calFrom, fwdTo);
        const reportedIds = new Set(docs.map((d) => d.id));
        // Reported dates per ticker, to skip an FMP row whose quarter is already
        // covered by a nearby Polygon 10-Q (same quarter, different date basis).
        const reportedDates = new Map<string, string[]>();
        for (const d of docs) {
          const t = d.data.ticker as string;
          const list = reportedDates.get(t);
          if (list) list.push(d.data.date as string);
          else reportedDates.set(t, [d.data.date as string]);
        }
        const nameByTicker = await this.loadCompanyNames();
        // FMP's calendar is WORLDWIDE (Shenzhen/HK/EU tickers etc.). Resolve
        // names for symbols outside our curated `companies` from the full Polygon
        // US reference — this widens the forward calendar to the whole US market
        // (earningshub parity) while still dropping non-US rows (absent from the
        // reference). Only the symbols missing a curated name are looked up.
        const upcomingSyms = [
          ...new Set(upcoming.map((u) => u.ticker.toUpperCase())),
        ];
        const refNames = await this.loadRefNames(
          upcomingSyms.filter((s) => !nameByTicker.has(s)),
        );
        // Both `continue`s below discard rows. Counted so a coverage problem is
        // visible in the run log: an empty calendar and a broken filter looked
        // identical until a manual FMP probe showed 604 US symbols being lost.
        let droppedNonUs = 0;
        let droppedDuplicate = 0;
        for (const u of upcoming) {
          const sym = u.ticker.toUpperCase();
          const name = nameByTicker.get(sym) ?? refNames.get(sym);
          if (!name) {
            droppedNonUs++;
            continue; // non-US / not an equity in the US reference
          }
          const id = `${u.ticker}_${u.date}`;
          if (reportedIds.has(id)) {
            droppedDuplicate++;
            continue; // exact reported row already covers it
          }
          const near = (reportedDates.get(u.ticker) ?? []).some(
            (d) => daysBetween(d, u.date) <= DUP_TOLERANCE_DAYS,
          );
          if (near) {
            droppedDuplicate++;
            continue; // same quarter already present via Polygon 10-Q
          }
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
              epsActual: u.epsActual,
              revenueEstimate: u.revenueEstimate,
              revenueActual: u.revenueActual,
              // Upcoming/just-announced rows have no reported quarter yet, so no
              // year-ago join (kept null for a uniform shape with reported docs).
              epsActualYearAgo: null as number | null,
              revenueYearAgo: null as number | null,
              updatedAt: new Date().toISOString(),
            },
          });
          forwardCount++;
        }
        this.logger.log(
          `upcoming calendar: ${upcoming.length} rows in · ${droppedNonUs} non-US · ${droppedDuplicate} dup-of-reported`,
        );
      }

      await chunkedBatchSet(this.firebase.firestore, "earnings_events", docs);

      // Full refresh: the collection must hold exactly this run's rows (reported
      // quarters + FMP upcoming). Delete any doc not in the new set — including
      // forward rows whose date passed without a filing (they roll out of the
      // upcoming window and are replaced by the reported quarter, or dropped).
      const keep = new Set(docs.map((d) => d.id));
      const col = this.firebase.firestore.collection("earnings_events");
      // Data-loss guard: `docs` combines the reported set (Polygon financials)
      // and the forward set (FMP upcoming). If BOTH came back empty the keep-set
      // is empty and the delete-pass below would wipe the entire collection —
      // exactly the wrong response to a non-throwing empty upstream (FMP's
      // documented silent-empty or a Polygon soft error). Skip the delete and
      // warn; a genuinely-empty upstream is a no-op, never a wipe.
      let stale: FirebaseFirestore.DocumentReference[] = [];
      if (keep.size === 0) {
        this.logger.warn(
          "earnings: refresh returned 0 rows (reported + forward both empty) — skipping delete-pass to avoid wiping collection earnings_events",
        );
      } else {
        stale = (await col.listDocuments()).filter((ref) => !keep.has(ref.id));
        for (let i = 0; i < stale.length; i += 400) {
          const batch = this.firebase.firestore.batch();
          for (const ref of stale.slice(i, i + 400)) batch.delete(ref);
          await batch.commit();
        }
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

  /**
   * Resolve display names for FMP calendar symbols that are NOT in our curated
   * `companies`, from the full Polygon US ticker reference (`tickers`, ~13k US
   * listings written weekly by ticker-universe.job). This is what widens the
   * forward calendar from the ~385 tracked names to the whole US market: a
   * symbol absent from this reference is a non-US FMP row (Shenzhen/HK/EU) and is
   * dropped; a present one is labelled with its Polygon name. Only common-stock /
   * ADR types are kept so ETFs, warrants and units don't clutter the calendar.
   *
   * Reads only the specific symbols in the calendar window (batched getAll), not
   * the whole 13k reference.
   */
  private async loadRefNames(symbols: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (symbols.length === 0) return map;
    const col = this.firebase.firestore.collection("tickers");
    const EQUITY_TYPES = new Set(["CS", "ADRC"]);
    for (let i = 0; i < symbols.length; i += 300) {
      const refs = symbols.slice(i, i + 300).map((s) => col.doc(s));
      const snaps = await this.firebase.firestore.getAll(...refs);
      for (const snap of snaps) {
        if (!snap.exists) continue;
        const d = snap.data() as Record<string, unknown>;
        const type = d.type as string | undefined;
        if (type && !EQUITY_TYPES.has(type)) continue;
        const name = d.name as string | undefined;
        if (name) map.set(snap.id.toUpperCase(), name);
      }
    }
    return map;
  }
}
