import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { chunkedBatchSet } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { IPOS_ADAPTER, type IposAdapter } from "../adapters/types";
import { SyncRegistry } from "../common/sync-registry.service";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { FmpService } from "../vendors/fmp/fmp.service";
import {
  classifyFromSic,
  withVendorIndustryFallback,
} from "../common/sic-tv.util";
import { isoDate } from "../common/date.util";
import { etDate } from "../common/market-calendar.util";

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

/**
 * The priced deal wins; the range midpoint is only a stand-in until the IPO
 * prices (TRXB: range 14-16 priced at 14, the midpoint showed 15).
 */
export function offerPrice(
  finalPrice: number | null | undefined,
  low: number | null,
  high: number | null,
): number | null {
  if (finalPrice != null && finalPrice > 0) return finalPrice;
  if (low != null && high != null) return (low + high) / 2;
  return low ?? high;
}

/**
 * The status to store. The feed's status is a snapshot from when the deal was
 * announced ("pending"); once the ticker has traded it is listed ("history",
 * shown as "Listed"), whatever the feed last said. A withdrawn deal stays
 * withdrawn.
 */
export function listedStatus(
  feedStatus: string | null | undefined,
  hasTraded: boolean,
): string {
  const s = feedStatus ?? "pending";
  if (s === "withdrawn") return s;
  return hasTraded ? "history" : s;
}

interface Aftermarket {
  traded: boolean;
  currentPrice: number | null;
  day1Close: number | null;
  day1PopPct: number | null;
  returnSinceIpoPct: number | null;
}

/** The fields of a stored ipos/{id} doc the refresh reads. */
interface StoredIpo extends Record<string, unknown> {
  symbol?: string | null;
  date?: string | null;
  status?: string | null;
  offerPrice?: number | null;
  currentPrice?: number | null;
  day1Close?: number | null;
  day1PopPct?: number | null;
  returnSinceIpoPct?: number | null;
  sector?: string | null;
  securityType?: string | null;
}

const round2 = (v: number | null) =>
  v == null ? null : Math.round(v * 100) / 100;

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
      const today = etDate();
      const docs: Array<{ id: string; data: Record<string, unknown> }> = [];
      for (const e of events) {
        const { low, high } = parsePriceRange(e.price);
        const id = `${e.date}_${e.symbol || slugify(e.name)}`;
        const offer = offerPrice(e.finalPrice, low, high);
        const after = await this.aftermarket(e.symbol, e.date, offer, today);
        const ref = e.symbol
          ? await this.reference(e.symbol)
          : { sector: null, type: null };

        docs.push({
          id,
          data: {
            date: e.date,
            symbol: e.symbol,
            name: e.name,
            sector: ref.sector,
            exchange: e.exchange,
            priceLow: low,
            priceHigh: high,
            offerPrice: offer ?? null,
            currentPrice: after.currentPrice,
            day1Close: after.day1Close,
            day1PopPct: after.day1PopPct,
            returnSinceIpoPct: after.returnSinceIpoPct,
            numberOfShares: e.numberOfShares,
            totalSharesValue: e.totalSharesValue,
            status: listedStatus(e.status, after.traded),
            securityType: e.securityType ?? ref.type,
            source,
            warnings: result.warnings,
            updatedAt: new Date().toISOString(),
          },
        });
      }

      // The feed stops returning a deal once it lists, so a stored row written
      // while it was "pending" (FMBM, 19 Nov) was never refreshed: no price, no
      // "Listed". Re-check every stored, not-yet-listed row in the window that
      // this run's feed did not cover.
      const covered = new Set(docs.map((d) => d.id));
      const fromIso = isoDate(from);
      const stale = await this.firebase.firestore
        .collection("ipos")
        .where("date", ">=", fromIso)
        .get();
      let refreshed = 0;
      for (const snap of stale.docs) {
        if (covered.has(snap.id)) continue;
        const d = snap.data() as StoredIpo;
        const symbol = typeof d.symbol === "string" ? d.symbol : null;
        const date = typeof d.date === "string" ? d.date : null;
        if (!symbol || !date || date > today || d.status === "withdrawn")
          continue;
        const offer = typeof d.offerPrice === "number" ? d.offerPrice : null;
        const after = await this.aftermarket(symbol, date, offer, today);
        const ref =
          !d.sector || !d.securityType ? await this.reference(symbol) : null;
        docs.push({
          id: snap.id,
          data: {
            ...d,
            currentPrice: after.currentPrice ?? d.currentPrice ?? null,
            day1Close: after.day1Close ?? d.day1Close ?? null,
            day1PopPct: after.day1PopPct ?? d.day1PopPct ?? null,
            returnSinceIpoPct:
              after.returnSinceIpoPct ?? d.returnSinceIpoPct ?? null,
            status: listedStatus(d.status, after.traded),
            sector: d.sector || ref?.sector || null,
            securityType: d.securityType || ref?.type || null,
            updatedAt: new Date().toISOString(),
          },
        });
        refreshed++;
      }
      if (refreshed > 0)
        this.logger.log(
          `ipos: re-checked ${refreshed} stored row(s) the feed no longer returns`,
        );
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

  /**
   * Aftermarket figures from daily bars since the listing date. `traded` is
   * true once any bar exists. Best-effort: a failed fetch leaves them null.
   */
  private async aftermarket(
    symbol: string | null | undefined,
    date: string | null | undefined,
    offer: number | null,
    today: string,
  ): Promise<Aftermarket> {
    const none: Aftermarket = {
      traded: false,
      currentPrice: null,
      day1Close: null,
      day1PopPct: null,
      returnSinceIpoPct: null,
    };
    if (!symbol || !date || date > today) return none;
    try {
      const bars = await this.polygon.getAggsRange(symbol, date, today);
      if (bars.length === 0) return none;
      const day1Close = bars[0].c ?? null;
      const currentPrice = bars[bars.length - 1].c ?? null;
      const pct = (v: number | null) =>
        v != null && offer && offer > 0
          ? round2(((v - offer) / offer) * 100)
          : null;
      return {
        traded: true,
        currentPrice,
        day1Close,
        day1PopPct: pct(day1Close),
        returnSinceIpoPct: pct(currentPrice),
      };
    } catch {
      return none;
    }
  }

  /**
   * Sector and security type for a ticker. Sector: SIC first, then FMP's
   * industry mapped into the app's sector names (new tickers often have no
   * SIC yet). Type: Polygon's ticker type (CS, ETF, WARRANT, UNIT, ...).
   */
  private async reference(
    symbol: string,
  ): Promise<{ sector: string | null; type: string | null }> {
    const [details, fmpProfile] = (await Promise.all([
      this.polygon.getTickerDetails(symbol).catch(() => null),
      this.fmp.enabled
        ? this.fmp.getCompanyProfile(symbol).catch(() => null)
        : Promise.resolve(null),
    ])) as [
      { sic_code?: string | number; type?: unknown } | null,
      { industry?: string | null } | null,
    ];
    const cls = withVendorIndustryFallback(
      classifyFromSic(details?.sic_code, symbol),
      fmpProfile?.industry,
    );
    const type = typeof details?.type === "string" ? details.type : null;
    return { sector: cls.sector ?? null, type };
  }
}
