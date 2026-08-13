import { Controller, Get, Header, Inject } from '@nestjs/common';
import { MARKET_BARS_ADAPTER, type MarketBarsAdapter } from '../adapters/types';
import { Edgar8kFeedService, type AnnouncementSeed } from './edgar-8k-feed.service';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/**
 * GET /market-data/earnings-announcements — SEC-EDGAR 8-K item-2.02 earnings
 * announcements with session (BMO/AMC) and post-announcement price reaction.
 * Calls SEC EDGAR directly via Edgar8kFeedService (shared with
 * filings-wire.controller.ts) — mirrors edgar-8k.job.ts's fetch, minus
 * persistence. The reaction calc uses MARKET_BARS_ADAPTER live instead of
 * reading the `ohlcv_bars` Firestore cache the job reads from.
 */
@Controller('market-data')
export class EarningsAnnouncementsController {
  constructor(
    private readonly edgar8k: Edgar8kFeedService,
    @Inject(MARKET_BARS_ADAPTER) private readonly marketBars: MarketBarsAdapter,
  ) {}

  /** Post-announcement % move around `announceDate`, direction-aware by session. */
  private async reactionPct(
    ticker: string,
    announceDate: string,
    session: 'BMO' | 'AMC' | 'Intraday' | null,
  ): Promise<number | null> {
    try {
      const from = isoDate(addDays(new Date(announceDate), -30));
      const to = isoDate(addDays(new Date(announceDate), 7));
      const result = await this.marketBars.fetchDailyBars(ticker, from, to);
      const bars = result.data.slice(-20); // already ascending; last 20 up to `to`
      if (bars.length < 2) return null;
      let idx = bars.findIndex((b) => b.date >= announceDate);
      if (idx === -1) idx = bars.length - 1;
      if (session === 'AMC') {
        const base = bars[idx]?.close;
        const next = bars[idx + 1]?.close;
        if (base != null && base > 0 && next != null) return ((next - base) / base) * 100;
        return null;
      }
      const prev = bars[idx - 1]?.close;
      const cur = bars[idx]?.close;
      if (prev != null && prev > 0 && cur != null) return ((cur - prev) / prev) * 100;
      return null;
    } catch {
      return null;
    }
  }

  @Get('earnings-announcements')
  @Header('Cache-Control', 'no-store')
  async earningsAnnouncements() {
    const { announcements } = await this.edgar8k.fetchAll();
    const docs = [];
    for (const a of announcements as AnnouncementSeed[]) {
      const reactionPct = await this.reactionPct(a.ticker, a.announceDate, a.session);
      docs.push({
        id: `${a.ticker}_${a.announceDate}`,
        ticker: a.ticker,
        companyName: a.companyName,
        announceDate: a.announceDate,
        session: a.session,
        reactionPct: reactionPct == null ? null : Math.round(reactionPct * 100) / 100,
        accessionNumber: a.accessionNumber,
        url: a.url,
        updatedAt: new Date().toISOString(),
      });
    }
    return docs;
  }
}
