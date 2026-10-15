import { Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { isoDateFromMs } from "../common/date.util";
import { etDate } from "../common/market-calendar.util";
import {
  BETA_MAX_RETURNS,
  BETA_MIN_RETURNS,
  computeMonthlyBeta,
  monthEndDates,
  monthKey,
  type MonthlyBeta,
} from "../common/monthly-beta.util";
import {
  PolygonService,
  planHistoryFloor,
} from "../vendors/polygon/polygon.service";

const BENCHMARK = "SPY";
/** Comfortably more than five years of sessions (~1,260). */
const BENCHMARK_BARS = 1_400;
/** Re-read the benchmark at most this often within a month, so a month-end bar
 *  that landed after the first load is picked up the same day. */
const MARKET_TTL_MS = 6 * 60 * 60 * 1000;
/** Polygon's ceiling on base aggregates per aggs request. */
const POLYGON_MAX_BASE_AGGS = 50_000;

/** The benchmark's completed month-ends, the calendar every stock is read on. */
export interface MarketMonths {
  /** Month-end session dates, ascending — also the stock doc ids to read. */
  dates: string[];
  /** month key → SPY month-end close. */
  closes: Map<string, number>;
  /** The newest completed month, e.g. "2026-09". Stored as `betaAsOf`. */
  asOf: string;
}

export interface MonthlyBetaResult {
  beta: MonthlyBeta | null;
  /** Where the stock's closes came from. */
  source: "ohlcv_bars" | "polygon";
  asOf: string;
}

/**
 * Loads month-end closes and computes the 5-year monthly beta.
 *
 * WHY MONTH-END DOCUMENT READS
 * Five years of daily bars is ~1,260 `ohlcv_bars` documents per ticker, and
 * Firestore bills per document. Beta only needs the LAST session of each month,
 * and bar ids are `${ticker}_${barDate}`, so those ~61 documents are fetched
 * directly by id — about 20x fewer reads, and the same prices the charts show.
 * The month-end calendar comes from SPY, which stock-history always syncs.
 *
 * FALLBACK
 * A ticker with fewer stored month-ends than SPY (recent listing, history not
 * fully backfilled), or whose history is mid re-backfill after a split, is read
 * from Polygon's monthly aggregates instead — one call — and whichever source
 * covers more months wins.
 */
@Injectable()
export class MonthlyBetaService {
  private readonly logger = new Logger(MonthlyBetaService.name);
  private market: { forMonth: string; at: number; data: MarketMonths } | null =
    null;

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly polygon: PolygonService,
  ) {}

  /** SPY's completed month-ends. Throws when there is too little history to
   *  compute any beta — every ticker would otherwise be written as N/A. */
  async loadMarket(now: Date = new Date()): Promise<MarketMonths> {
    const currentMonth = monthKey(etDate(now));
    const hit = this.market;
    if (
      hit &&
      hit.forMonth === currentMonth &&
      now.getTime() - hit.at < MARKET_TTL_MS
    ) {
      return hit.data;
    }

    const snap = await this.firebase.firestore
      .collection("ohlcv_bars")
      .where("ticker", "==", BENCHMARK)
      .orderBy("barDate", "desc")
      .limit(BENCHMARK_BARS)
      .select("barDate", "close")
      .get();
    const closeByDate = new Map<string, number>();
    for (const d of snap.docs) {
      const date: unknown = d.get("barDate");
      const close: unknown = d.get("close");
      if (typeof date === "string" && typeof close === "number" && close > 0)
        closeByDate.set(date, close);
    }
    const dates = monthEndDates([...closeByDate.keys()], currentMonth).slice(
      -(BETA_MAX_RETURNS + 1),
    );
    if (dates.length < BETA_MIN_RETURNS + 1) {
      throw new Error(
        `${BENCHMARK} has ${dates.length} completed month-ends in ohlcv_bars; ` +
          `need ${BETA_MIN_RETURNS + 1}. Has stock-history backfilled it?`,
      );
    }
    const data: MarketMonths = {
      dates,
      closes: new Map(dates.map((d) => [monthKey(d), closeByDate.get(d)])),
      asOf: monthKey(dates[dates.length - 1]),
    };
    this.market = { forMonth: currentMonth, at: now.getTime(), data };
    return data;
  }

  /**
   * Beta for one ticker against `market`. `historyPending` forces the vendor
   * read: stored bars are being re-backfilled after a split and may still mix
   * two adjustment bases.
   */
  async computeFor(
    ticker: string,
    market: MarketMonths,
    opts: { historyPending?: boolean } = {},
  ): Promise<MonthlyBetaResult> {
    let closes = opts.historyPending
      ? new Map<string, number>()
      : await this.storedMonthEnds(ticker, market.dates);
    let source: MonthlyBetaResult["source"] = "ohlcv_bars";

    if (closes.size < market.dates.length) {
      const vendor: Map<string, number> | null = await this.vendorMonthEnds(
        ticker,
        market,
      ).catch((err: unknown): null => {
        this.logger.warn(
          `monthly beta: Polygon fallback failed for ${ticker}: ${(err as Error).message}`,
        );
        return null;
      });
      if (vendor && vendor.size > closes.size) {
        closes = vendor;
        source = "polygon";
      }
    }

    return {
      beta: computeMonthlyBeta(closes, market.closes),
      source,
      asOf: market.asOf,
    };
  }

  /** The ticker's stored close on each month-end session, by document id. */
  private async storedMonthEnds(
    ticker: string,
    dates: string[],
  ): Promise<Map<string, number>> {
    const col = this.firebase.firestore.collection("ohlcv_bars");
    const snaps = await this.firebase.firestore.getAll(
      ...dates.map((d) => col.doc(`${ticker}_${d}`)),
      { fieldMask: ["close"] },
    );
    const out = new Map<string, number>();
    snaps.forEach((s, i) => {
      const close: unknown = s.exists ? s.get("close") : null;
      if (typeof close === "number" && close > 0)
        out.set(monthKey(dates[i]), close);
    });
    return out;
  }

  /** Split-adjusted monthly closes from Polygon, completed months only. */
  private async vendorMonthEnds(
    ticker: string,
    market: MarketMonths,
  ): Promise<Map<string, number>> {
    // `from` is clamped to the plan's 5-year edge: Polygon rejects the WHOLE
    // request when it reaches past it. `to` is the last completed month-end, so
    // the still-forming current month is never returned.
    //
    // `limit` caps the BASE (daily) aggregates Polygon rolls up, not the monthly
    // bars it returns: limit=120 yields ~6 months. Five years is ~1,260 sessions,
    // so ask for the endpoint's maximum.
    const bars = await this.polygon.getAggsRange(
      ticker,
      planHistoryFloor(),
      market.dates[market.dates.length - 1],
      "month",
      1,
      POLYGON_MAX_BASE_AGGS,
    );
    const out = new Map<string, number>();
    for (const b of bars) {
      // A monthly bar's `t` is the START of its month — midnight New York,
      // which is still the 1st in UTC. Reading it in New York time instead
      // would be fine too, but UTC also survives a vendor that stamps UTC
      // midnight (in New York that is the previous month's last day).
      const m = monthKey(isoDateFromMs(b.t));
      if (market.closes.has(m) && typeof b.c === "number" && b.c > 0)
        out.set(m, b.c);
    }
    return out;
  }
}
