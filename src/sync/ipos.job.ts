import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { IPOS_ADAPTER, type IposAdapter } from "../adapters/types";
import { SyncRegistry } from "../common/sync-registry.service";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { FmpService } from "../vendors/fmp/fmp.service";
import { resolveSector } from "../common/sic-sector.util";
import { classifyFromSic } from "../common/sic-tv.util";
import { isoDate } from "../common/date.util";

const JOB_NAME = "ipos";
// Cover the full "Recent IPO performance" range so every displayed name is
// reprocessed (aftermarket returns + sector). Was 45, which left IPOs older
// than ~6 weeks in the list without a refreshed doc/sector.
const LOOKBACK_DAYS = 120;
const LOOKAHEAD_DAYS = 90;


function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function parsePriceRange(price: string) {
  if (!price) return { low: null, high: null };
  const parts = price.split("-").map((p) => Number(p.trim()));
  if (parts.length === 2 && parts.every((n) => !Number.isNaN(n))) {
    return { low: parts[0], high: parts[1] };
  }
  const single = Number(price);
  return Number.isNaN(single)
    ? { low: null, high: null }
    : { low: single, high: single };
}

@Injectable()
export class IposJob implements OnModuleInit {
  private readonly logger = new Logger(IposJob.name);

  constructor(
    @Inject(IPOS_ADAPTER) private readonly ipos: IposAdapter,
    private readonly polygon: PolygonService,
    private readonly fmp: FmpService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["ipos"],
      cronExpression: "15 6 * * *",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const from = new Date();
      from.setUTCDate(from.getUTCDate() - LOOKBACK_DAYS);
      const to = new Date();
      to.setUTCDate(to.getUTCDate() + LOOKAHEAD_DAYS);
      const result = await this.ipos.fetchIpos(isoDate(from), isoDate(to));
      const events = result.data;
      const source = result.source;
      if (result.warnings.length > 0) {
        this.logger.log(
          `ipos: ${result.warnings.map((w) => w.code).join(", ")}`,
        );
      }
      const today = isoDate(new Date());
      // Aftermarket enrichment: for IPOs that have ALREADY listed, fetch daily
      // bars and compute real current price + day-1 pop + return-since-offer.
      // Was mock-only because the IPO feed carries no post-listing price.
      const docs = [];
      for (const e of events) {
        const { low, high } = parsePriceRange(e.price);
        const id = `${e.date}_${e.symbol || slugify(e.name)}`;
        const offer =
          low != null && high != null ? (low + high) / 2 : (low ?? high);

        let currentPrice: number | null = null;
        let day1Close: number | null = null;
        let day1Pop: number | null = null;
        let returnSinceIpo: number | null = null;
        // Only for listed names with a past listing date and a real ticker.
        if (e.symbol && e.date && e.date <= today) {
          try {
            const bars = await this.polygon.getAggsRange(
              e.symbol,
              e.date,
              today,
            );
            if (bars.length > 0) {
              day1Close = bars[0].c ?? null;
              currentPrice = bars[bars.length - 1].c ?? null;
              if (offer && offer > 0) {
                if (day1Close != null)
                  day1Pop = ((day1Close - offer) / offer) * 100;
                if (currentPrice != null)
                  returnSinceIpo = ((currentPrice - offer) / offer) * 100;
              }
            }
          } catch {
            // Best-effort; a missing series just leaves the aftermarket fields null.
          }
        }

        // Sector from Polygon's ticker reference (SIC → sector). New IPO tickers
        // aren't in the `companies` universe yet, so the UI had no sector to show;
        // fetch it here per listed name (best-effort).
        let sector: string | null = null;
        if (e.symbol) {
          try {
            const [details, fmpProfile] = await Promise.all([
              this.polygon.getTickerDetails(e.symbol),
              this.fmp.enabled
                ? this.fmp.getCompanyProfile(e.symbol).catch(() => null)
                : Promise.resolve(null),
            ]);
            sector = classifyFromSic(
              details?.sic_code as string | number | undefined,
            ).sector;
          } catch {
            // Best-effort; leave null if the reference lookup fails.
          }
        }

        docs.push({
          id,
          data: {
            date: e.date,
            symbol: e.symbol,
            name: e.name,
            sector,
            exchange: e.exchange,
            priceLow: low,
            priceHigh: high,
            offerPrice: offer ?? null,
            currentPrice,
            day1Close,
            day1PopPct:
              day1Pop == null ? null : Math.round(day1Pop * 100) / 100,
            returnSinceIpoPct:
              returnSinceIpo == null
                ? null
                : Math.round(returnSinceIpo * 100) / 100,
            numberOfShares: e.numberOfShares,
            totalSharesValue: e.totalSharesValue,
            status: e.status,
            source,
            warnings: result.warnings,
            updatedAt: new Date().toISOString(),
          },
        });
      }
      await chunkedBatchSet(this.firebase.firestore, "ipos", docs);
      await this.meta.record(JOB_NAME, { ok: true, count: docs.length });
      return { count: docs.length };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: err.message,
      });
      throw err;
    }
  }
}
