import { Inject, Injectable, Logger } from "@nestjs/common";
import { DIVIDENDS_ADAPTER, type DividendsAdapter } from "../adapters/types";
import { PolygonService } from "../vendors/polygon/polygon.service";

const LOOKAHEAD_DAYS = 30;
const SNAPSHOT_CHUNK = 250;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Stable, unique document ID for one dividend event.
 *
 * symbol alone lost every repeat event for a ticker (1119 events -> 1062 docs).
 * symbol+exDate fixed most of it but still lost 17, because a company can pay a
 * REGULAR and a SPECIAL dividend on the same ex-date — verified against the
 * vendor: JBSS 2026-08-17 has CD $0.95 and SC $1.05, HRZN has CD $0.06 and
 * SC $0.03. Polygon supplies a stable per-event id, so a short slice of it is
 * appended as the discriminator; the symbol/date prefix is kept so IDs stay
 * readable in the console. Falls back gracefully for a vendor with no event id,
 * where symbol+date has been sufficient.
 */
function dividendDocId(e: {
  symbol: string;
  date: string | null;
  vendorEventId?: string | null;
}): string {
  const base = e.date ? `${e.symbol}_${e.date}` : e.symbol;
  return e.vendorEventId ? `${base}_${e.vendorEventId.slice(0, 12)}` : base;
}

@Injectable()
export class DividendsJob {
  private readonly logger = new Logger(DividendsJob.name);

  constructor(
    @Inject(DIVIDENDS_ADAPTER) private readonly dividends: DividendsAdapter,
    private readonly polygon: PolygonService,
  ) {}

  /**
   * Live-direct: fetch + shape the dividend calendar WITHOUT reading or writing
   * Firestore, returning the exact `{id, ...data}` shape the `dividends`
   * collection read used to yield. Backs GET /market-data/dividends.
   */
  async fetchLive(): Promise<Record<string, unknown>[]> {
    const docs = await this.buildDocs();
    return docs.map((d) => ({ id: d.id, ...d.data }));
  }

  private async buildDocs(): Promise<
    { id: string; data: Record<string, unknown> }[]
  > {
    const from = isoDate(new Date());
    const to = new Date();
    to.setUTCDate(to.getUTCDate() + LOOKAHEAD_DAYS);
    const toStr = isoDate(to);
    const result = await this.dividends.fetchDividends(from, toStr);
    const events = result.data;
    const source = result.source;
    if (result.warnings.length > 0) {
      this.logger.log(
        `dividends: ${result.warnings.map((w) => w.code).join(", ")}`,
      );
    }
    // Annualized yield per row. Polygon has no yield field (it arrives null),
    // which left the Macro screen's high-yield vs growth buckets unable to
    // bucket anything and every row rendering "n/a". amount x payments-per-year
    // over the last price is the same figure a vendor would supply. Prices are
    // pulled LIVE from Polygon's universal snapshot (the `companies` cache is
    // gone), batched at up to 250 tickers per call.
    const symbols = [...new Set(events.map((e) => e.symbol).filter(Boolean))];
    const priceByTicker = new Map<string, number>();
    for (let i = 0; i < symbols.length; i += SNAPSHOT_CHUNK) {
      const chunk = symbols.slice(i, i + SNAPSHOT_CHUNK);
      const snaps = await this.polygon
        .getUniversalSnapshot(chunk)
        .catch(() => []);
      for (const s of snaps) {
        if (typeof s.price === "number" && s.price > 0)
          priceByTicker.set(s.ticker, s.price);
      }
    }
    const PAYMENTS_PER_YEAR: Record<string, number> = {
      Annual: 1,
      "Semi-Annual": 2,
      Quarterly: 4,
      Monthly: 12,
    };
    const annualizedYield = (e: (typeof events)[number]): number | null => {
      const price = priceByTicker.get(e.symbol);
      // A one-time/special dividend has no annual cadence to project, so it
      // gets no yield rather than a fabricated 4x annualization.
      const perYear = e.frequency ? PAYMENTS_PER_YEAR[e.frequency] : undefined;
      if (!price || !perYear || !e.dividend) return null;
      return Math.round(((e.dividend * perYear) / price) * 10000) / 100;
    };

    // Doc ID is symbol + ex-dividend date, NOT symbol alone. A company can have
    // more than one dividend event inside the lookahead window (a regular
    // quarterly plus a special dividend, or two ex-dates spanning a quarter
    // boundary). Keying on symbol alone made the second event overwrite the
    // first — 1119 events collapsed to 1062 documents, so 57 were silently
    // lost. Events with no ex-date fall back to symbol alone rather than
    // producing an "undefined"-suffixed key.
    return events.map((e) => ({
      id: dividendDocId(e),
      data: {
        ticker: e.symbol,
        exDividendDate: e.date,
        recordDate: e.recordDate,
        paymentDate: e.paymentDate,
        declarationDate: e.declarationDate,
        dividendAmount: e.dividend,
        yieldPct: e.yield ?? annualizedYield(e),
        yieldIsDerived: e.yield == null,
        frequency: e.frequency,
        source,
        warnings: result.warnings,
        updatedAt: new Date().toISOString(),
      },
    }));
  }
}
