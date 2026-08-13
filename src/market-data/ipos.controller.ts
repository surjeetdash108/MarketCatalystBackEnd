import { Controller, Get, Header, Inject } from '@nestjs/common';
import { IPOS_ADAPTER, type IposAdapter } from '../adapters/types';
import { PolygonService } from '../vendors/polygon/polygon.service';

const LOOKBACK_DAYS = 45;
const LOOKAHEAD_DAYS = 90;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function parsePriceRange(price: string) {
  if (!price) return { low: null, high: null };
  const parts = price.split('-').map((p) => Number(p.trim()));
  if (parts.length === 2 && parts.every((n) => !Number.isNaN(n))) {
    return { low: parts[0], high: parts[1] };
  }
  const single = Number(price);
  return Number.isNaN(single) ? { low: null, high: null } : { low: single, high: single };
}

/**
 * GET /market-data/ipos — backs the IPO Corner screen's live calendar.
 * Calls the IPOs adapter directly on every request (no Firestore cache, no
 * sync job) — mirrors ipos.job.ts's fetch + aftermarket-enrichment loop,
 * minus persistence.
 */
@Controller('market-data')
export class IposController {
  constructor(
    @Inject(IPOS_ADAPTER) private readonly iposAdapter: IposAdapter,
    private readonly polygon: PolygonService,
  ) {}

  @Get('ipos')
  @Header('Cache-Control', 'no-store')
  async ipos() {
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - LOOKBACK_DAYS);
    const to = new Date();
    to.setUTCDate(to.getUTCDate() + LOOKAHEAD_DAYS);
    const result = await this.iposAdapter.fetchIpos(isoDate(from), isoDate(to));
    const events = result.data;
    const source = result.source;
    const today = isoDate(new Date());

    const docs = [];
    for (const e of events) {
      const { low, high } = parsePriceRange(e.price);
      const id = `${e.date}_${e.symbol || slugify(e.name)}`;
      const offer = low != null && high != null ? (low + high) / 2 : low ?? high;

      let currentPrice: number | null = null;
      let day1Close: number | null = null;
      let day1Pop: number | null = null;
      let returnSinceIpo: number | null = null;
      if (e.symbol && e.date && e.date <= today) {
        try {
          const bars = await this.polygon.getAggsRange(e.symbol, e.date, today);
          if (bars.length > 0) {
            day1Close = bars[0].c ?? null;
            currentPrice = bars[bars.length - 1].c ?? null;
            if (offer && offer > 0) {
              if (day1Close != null) day1Pop = ((day1Close - offer) / offer) * 100;
              if (currentPrice != null) returnSinceIpo = ((currentPrice - offer) / offer) * 100;
            }
          }
        } catch {
          // Best-effort; a missing series just leaves the aftermarket fields null.
        }
      }

      docs.push({
        id,
        date: e.date,
        symbol: e.symbol,
        name: e.name,
        exchange: e.exchange,
        priceLow: low,
        priceHigh: high,
        offerPrice: offer ?? null,
        currentPrice,
        day1Close,
        day1PopPct: day1Pop == null ? null : Math.round(day1Pop * 100) / 100,
        returnSinceIpoPct: returnSinceIpo == null ? null : Math.round(returnSinceIpo * 100) / 100,
        numberOfShares: e.numberOfShares,
        totalSharesValue: e.totalSharesValue,
        status: e.status,
        source,
        warnings: result.warnings,
        updatedAt: new Date().toISOString(),
      });
    }
    return docs;
  }
}
