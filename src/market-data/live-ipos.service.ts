import { Inject, Injectable } from "@nestjs/common";
import { IPOS_ADAPTER, type IposAdapter } from "../adapters/types";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { LiveCoalescer } from "../common/live-coalescer";

/**
 * Live replacement for the `ipos` sync job + Firestore cache. Fetches the IPO
 * calendar (-45d..+90d) and, for names that have already listed, enriches with
 * current price / day-1 pop / return-since-offer from Polygon daily bars — in
 * parallel (the job looped these sequentially). Doc shape preserved from
 * `sync/ipos.job.ts`. Coalesced.
 */
const LOOKBACK_DAYS = 45;
const LOOKAHEAD_DAYS = 90;

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
function parsePriceRange(price: string | null) {
  if (!price) return { low: null, high: null };
  const parts = price.split("-").map((p) => Number(p.trim()));
  if (parts.length === 2 && parts.every((n) => !Number.isNaN(n))) {
    return { low: parts[0], high: parts[1] };
  }
  const single = Number(price);
  return Number.isNaN(single) ? { low: null, high: null } : { low: single, high: single };
}
const r2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);

@Injectable()
export class LiveIposService {
  private readonly coalescer = new LiveCoalescer(5_000);

  constructor(
    @Inject(IPOS_ADAPTER) private readonly ipos: IposAdapter,
    private readonly polygon: PolygonService,
  ) {}

  async getIpos() {
    return this.coalescer.run("ipos", async () => {
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const now = new Date();
      const from = new Date(now); from.setUTCDate(from.getUTCDate() - LOOKBACK_DAYS);
      const to = new Date(now); to.setUTCDate(to.getUTCDate() + LOOKAHEAD_DAYS);
      const today = iso(now);
      const result = await this.ipos.fetchIpos(iso(from), iso(to));

      return Promise.all(
        result.data.map(async (e) => {
          const { low, high } = parsePriceRange(e.price);
          const offer = low != null && high != null ? (low + high) / 2 : (low ?? high);
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
              // Best-effort; missing series leaves aftermarket fields null.
            }
          }
          return {
            id: `${e.date}_${e.symbol || slugify(e.name)}`,
            date: e.date,
            symbol: e.symbol,
            name: e.name,
            exchange: e.exchange,
            priceLow: low,
            priceHigh: high,
            offerPrice: offer ?? null,
            currentPrice,
            day1Close,
            day1PopPct: r2(day1Pop),
            returnSinceIpoPct: r2(returnSinceIpo),
            numberOfShares: e.numberOfShares,
            totalSharesValue: e.totalSharesValue,
            status: e.status,
            source: result.source,
          };
        }),
      );
    });
  }
}
