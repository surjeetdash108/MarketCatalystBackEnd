import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { chunkedBatchSet } from '../common/firestore-batch.util';
import { SyncMetaService } from '../common/sync-meta.service';
import { SyncRegistry } from '../common/sync-registry.service';
import { activeUniverse } from '../common/ticker-universe';
import { PolygonService } from '../vendors/polygon/polygon.service';

/**
 * Per-ticker dividend history → `dividend_history/{ticker}`
 * and split history      → `splits/{ticker}`.
 *
 * Distinct from `dividends.job.ts`, which sweeps EVERY ticker over a forward
 * 30-day ex-date window to build the calendar. This walks ONE ticker backwards
 * to build the history chart, and derives the figures the dividend card was
 * inventing: the 10-year bar series, the trailing-twelve-month total, the growth
 * rate, and the consecutive-increase streak. `divHistory()` in the UI
 * extrapolated all of these from the single current amount.
 *
 * Splits are synced alongside because they come from the same corporate-actions
 * family and nothing else consumed them — the daily bar job refetches with
 * `adjusted=true`, so a split silently rewrites history with no record of why.
 */

const JOB_NAME = 'corporate-actions';
const BATCH_SIZE = 40;
const HISTORY_LIMIT = 200;
const ANNUAL_YEARS = 10;
const CAGR_YEARS = 5;
const DELAY_MS = 120;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AnnualTotal {
  year: number;
  total: number;
  payments: number;
}

/**
 * Calendar-year totals by ex-date, newest first. Calendar rather than fiscal
 * because the chart's x-axis is years and the vendor supplies no fiscal mapping
 * for distributions.
 */
export function annualTotals(
  history: Array<{ exDividendDate: string | null; cashAmount: number }>,
): AnnualTotal[] {
  const byYear = new Map<number, { total: number; payments: number }>();
  for (const d of history) {
    if (!d.exDividendDate) continue;
    const year = Number(d.exDividendDate.slice(0, 4));
    if (!Number.isFinite(year)) continue;
    const cur = byYear.get(year) ?? { total: 0, payments: 0 };
    cur.total += d.cashAmount ?? 0;
    cur.payments += 1;
    byYear.set(year, cur);
  }
  return [...byYear.entries()]
    .map(([year, v]) => ({
      year,
      total: Math.round(v.total * 10000) / 10000,
      payments: v.payments,
    }))
    .sort((a, b) => b.year - a.year);
}

/**
 * Compound annual growth over `years` COMPLETE calendar years. The current year
 * is excluded — it is partial by definition, and including it reads as a ~75%
 * dividend cut every January.
 */
export function dividendCagr(totals: AnnualTotal[], years: number): number | null {
  const thisYear = new Date().getUTCFullYear();
  const complete = totals.filter((t) => t.year < thisYear);
  if (complete.length < years + 1) return null;
  const latest = complete[0];
  const base = complete[years];
  if (!base || base.total <= 0 || latest.total <= 0) return null;
  const cagr = (latest.total / base.total) ** (1 / years) - 1;
  return Number.isFinite(cagr) ? Math.round(cagr * 10000) / 100 : null;
}

/** Consecutive complete years, most recent first, whose total exceeded the prior year's. */
export function increaseStreak(totals: AnnualTotal[]): number {
  const thisYear = new Date().getUTCFullYear();
  const complete = totals.filter((t) => t.year < thisYear);
  let streak = 0;
  for (let i = 0; i < complete.length - 1; i++) {
    // Only count strictly consecutive years — a gap means the streak is broken,
    // not that the years either side should be compared to each other.
    if (complete[i].year !== complete[i + 1].year + 1) break;
    if (complete[i].total > complete[i + 1].total) streak++;
    else break;
  }
  return streak;
}

@Injectable()
export class CorporateActionsJob implements OnModuleInit {
  private readonly logger = new Logger(CorporateActionsJob.name);

  constructor(
    private readonly polygon: PolygonService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ['dividend_history', 'splits'],
      cronExpression: '40 6 * * *',
      timeZone: 'America/New_York',
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
        return { count: 0, note: 'no active tickers yet' };
      }
      // Batch never larger than the active universe, so a small
      // universe is fully covered in one premarket run.
      const cursor = await this.meta.getCursor(JOB_NAME);
      const batch = Array.from(
        { length: Math.min(BATCH_SIZE, universe.length) },
        (_, i) => universe[(cursor + i) % universe.length],
      );

      // Prices for the yield derivation, read once for the batch rather than
      // per ticker. A missing company doc just leaves yield null.
      const priceByTicker = new Map<string, number>();
      const companyDocs = await this.firebase.firestore
        .getAll(
          ...batch.map((t) => this.firebase.firestore.collection('companies').doc(t)),
        )
        .catch(() => []);
      for (const doc of companyDocs) {
        const price = doc.data()?.price;
        if (typeof price === 'number' && price > 0) priceByTicker.set(doc.id, price);
      }

      const divDocs: { id: string; data: Record<string, unknown> }[] = [];
      const splitDocs: { id: string; data: Record<string, unknown> }[] = [];
      let failed = 0;

      for (const ticker of batch) {
        try {
          const history = await this.polygon.getDividendHistory(ticker, HISTORY_LIMIT);
          const totals = annualTotals(history);
          const cutoff = new Date();
          cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
          const cutoffIso = cutoff.toISOString().slice(0, 10);
          const ttm = history.filter(
            (d) => d.exDividendDate != null && d.exDividendDate >= cutoffIso,
          );
          const ttmTotal = ttm.reduce((s, d) => s + (d.cashAmount ?? 0), 0);
          const price = priceByTicker.get(ticker) ?? null;

          divDocs.push({
            id: ticker,
            data: {
              ticker,
              // Newest first, as returned. The chart reverses for display; the
              // "next/most recent payment" reads are the common case.
              history: history.map((d) => ({
                exDividendDate: d.exDividendDate,
                paymentDate: d.paymentDate,
                declarationDate: d.declarationDate,
                recordDate: d.recordDate,
                amount: d.cashAmount,
                dividendType: d.dividendType,
                frequency: d.frequency,
              })),
              annualTotals: totals.slice(0, ANNUAL_YEARS),
              ttmTotal: ttm.length > 0 ? Math.round(ttmTotal * 10000) / 10000 : null,
              ttmPayments: ttm.length,
              yieldPct:
                price != null && ttm.length > 0
                  ? Math.round((ttmTotal / price) * 10000) / 100
                  : null,
              yieldBasisPrice: price,
              cagr5yPct: dividendCagr(totals, CAGR_YEARS),
              increaseStreakYears: increaseStreak(totals),
              frequency: history[0]?.frequency ?? null,
              isPayer: history.length > 0,
              source: 'polygon',
              updatedAt: new Date().toISOString(),
            },
          });

          const splits = await this.polygon.getSplits(ticker);
          splitDocs.push({
            id: ticker,
            data: {
              ticker,
              splits,
              latestSplit: splits[0] ?? null,
              source: 'polygon',
              updatedAt: new Date().toISOString(),
            },
          });
        } catch (err) {
          this.logger.error(`corporate actions failed for ${ticker}: ${err.message}`);
          failed++;
        }
        await sleep(DELAY_MS);
      }

      await chunkedBatchSet(this.firebase.firestore, 'dividend_history', divDocs);
      await chunkedBatchSet(this.firebase.firestore, 'splits', splitDocs);
      await this.meta.setCursor(
        JOB_NAME,
        (cursor + BATCH_SIZE) % universe.length,
      );
      await this.meta.record(JOB_NAME, { ok: true, count: divDocs.length });
      return { dividendDocs: divDocs.length, splitDocs: splitDocs.length, failed };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: err.message });
      throw err;
    }
  }
}
