import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FmpService } from "../fmp/fmp.service";
import { SecEdgarService } from "../sec-edgar/sec-edgar.service";
import { PolygonService, type PolygonAggBar, type PolygonTickerRef } from "../polygon/polygon.service";
import {
  dividendTypeFor,
  etMidnightMs,
  etParts,
  etWallToEpochMs,
  exchangeToMic,
  FMP_US_EXCHANGES,
  frequencyToLabel,
  frequencyToNumber,
  fromFmpSymbol,
  ipoStatusFor,
  isPolygonOnlyTicker,
  isUsSymbol,
  micFromFmpExchange,
  normalizePriceRange,
  parseEodBulkCsv,
  sessionPhase,
  toFmpSymbol,
} from "./fmp-mapping.util";

type Row = Record<string, any>;

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Polygon (multiplier, timespan) → FMP historical-chart interval. */
function fmpInterval(timespan: string, multiplier: number): string | null {
  if (timespan === "minute" && [1, 5, 15, 30].includes(multiplier)) return `${multiplier}min`;
  if (timespan === "hour" && multiplier === 1) return "1hour";
  if (timespan === "hour" && multiplier === 4) return "4hour";
  return null;
}

/** Guard against a vendor answering a paging request with the same window forever. */
const MAX_INTRADAY_PAGES = 60;
/** Fewer usable FMP peers than this → Polygon's related-companies list. */
const MIN_FMP_PEERS = 3;
/** dividends-calendar silently caps a response at 4000 rows (global feed). */
const FMP_CALENDAR_CAP = 4000;
/** company-screener row cap per request; an answer this size may be truncated. */
const FMP_SCREENER_LIMIT = 10_000;
/** delisted-companies is newest-first, 100 rows a page (~2-3 weeks of delistings). */
const FMP_DELISTED_MAX_PAGES = 40;
const FMP_DELISTED_TTL_MS = 6 * 3_600_000;
/** Exchanges whose delistings count — the venues Polygon's stock universe covers (no OTC). */
const US_LISTING_VENUE = /^(NASDAQ|NYSE|AMEX|BATS|CBOE)/i;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date: string, days: number) => isoDay(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);

/**
 * FMP-FIRST market data, Polygon as backup — for EVERY consumer of
 * PolygonService (live screens, sync jobs, adapters), with no consumer changes.
 *
 * PolygonModule provides this subclass under the PolygonService token when
 * MARKET_DATA_PRIMARY=fmp (the default). Each override:
 *   1. asks FMP and maps the answer into Polygon's exact shape;
 *   2. on an FMP error, an empty answer, or a ticker FMP cannot serve, calls
 *      `super` — the original Polygon implementation.
 * The ticker universe is FMP-first too, but MERGED: FMP's screener lists ~3k
 * fewer symbols than Polygon (ETFs, preferreds, warrants, units), so Polygon
 * fills the symbols FMP lacks and the type/FIGI fields FMP has no equivalent
 * for, rather than only standing by for an outage.
 *
 * Methods NOT overridden stay Polygon: FMP has no options chains, and Polygon's
 * news is a separate adapter merged FMP-first by news.job / on-demand news.
 * Polygon's financials endpoints are retired; PolygonService already serves
 * those from FMP.
 *
 * MARKET_DATA_PRIMARY=polygon restores plain PolygonService everywhere.
 */
@Injectable()
export class MarketDataService extends PolygonService {
  private readonly routeLogger = new Logger("MarketData");

  constructor(
    config: ConfigService,
    private readonly fmpApi: FmpService,
    private readonly sec: SecEdgarService,
  ) {
    super(config, fmpApi);
    this.routeLogger.log(
      fmpApi.enabled
        ? "Market data: FMP primary, Polygon fallback"
        : "Market data: FMP_API_KEY unset — serving Polygon only",
    );
  }

  /** Runs the FMP path; falls back to Polygon on error or an empty answer. */
  private async fmpFirst<T>(
    what: string,
    fmp: () => Promise<T>,
    polygon: () => Promise<T>,
    isEmpty: (v: T) => boolean = (v) => v == null || (Array.isArray(v) && v.length === 0),
  ): Promise<T> {
    if (!this.fmpApi.enabled) return polygon();
    try {
      const v = await fmp();
      if (!isEmpty(v)) return v;
      this.routeLogger.debug(`${what}: FMP empty — Polygon fallback`);
    } catch (err) {
      this.routeLogger.warn(`${what}: FMP failed (${(err as Error)?.message ?? err}) — Polygon fallback`);
    }
    return polygon();
  }

  /** Same normalisation PolygonService.getAggsRange applies (BUG-DATA-011). */
  private static clean(b: PolygonAggBar): PolygonAggBar {
    const fin = (n: number) => (Number.isFinite(n) ? n : null);
    return {
      ...b,
      v: Number.isFinite(b.v) && b.v >= 0 ? Math.round(b.v) : 0,
      o: fin(b.o), h: fin(b.h), l: fin(b.l), c: fin(b.c),
    };
  }

  // ── Bars ──────────────────────────────────────────────────────────────────

  async getAggsRange(
    ticker: string,
    from: string,
    to: string,
    timespan = "day",
    multiplier = 1,
    limit = 5000,
  ): Promise<PolygonAggBar[]> {
    const polygon = () => super.getAggsRange(ticker, from, to, timespan, multiplier, limit);
    if (isPolygonOnlyTicker(ticker)) return polygon();
    const interval = timespan === "day" && multiplier === 1 ? "day" : fmpInterval(timespan, multiplier);
    if (!interval) return polygon();
    return this.fmpFirst(
      `bars ${ticker} ${multiplier}${timespan}`,
      async () => {
        const bars = interval === "day"
          ? await this.fmpDailyBars(ticker, from, to)
          : await this.fmpIntradayBars(ticker, interval, from, to);
        // Polygon sort=asc&limit=N returns the OLDEST N.
        return bars.slice(0, limit);
      },
      polygon,
    );
  }

  private async fmpDailyBars(ticker: string, from: string, to: string): Promise<PolygonAggBar[]> {
    const rows = (await this.fmpApi.request(
      `historical-price-eod/full?symbol=${encodeURIComponent(toFmpSymbol(ticker))}&from=${from}&to=${to}`,
    )) as Row[];
    return rows
      .map((r) => MarketDataService.clean({
        T: ticker,
        t: etMidnightMs(String(r.date)),
        o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close),
        v: Number(r.volume),
        vw: num(r.vwap) ?? undefined,
      }))
      .filter((b) => Number.isFinite(b.t))
      .sort((a, b) => a.t - b.t);
  }

  /**
   * FMP caps each historical-chart answer (~2.4k 1-min / ~1.4k 5-min bars, ~1
   * month of 30-min), newest first. Page BACKWARDS — re-requesting up to the
   * oldest day received (that day may have been cut mid-session; dedupe by t
   * fixes the overlap) — until `from` is covered. Extended hours included, as
   * Polygon's intraday aggregates are.
   */
  private async fmpIntradayBars(
    ticker: string,
    interval: string,
    from: string,
    to: string,
  ): Promise<PolygonAggBar[]> {
    const sym = encodeURIComponent(toFmpSymbol(ticker));
    const byT = new Map<number, PolygonAggBar>();
    let end = to;
    for (let page = 0; page < MAX_INTRADAY_PAGES; page++) {
      const rows = (await this.fmpApi.request(
        `historical-chart/${interval}?symbol=${sym}&from=${from}&to=${end}&extended=true`,
      )) as Row[];
      if (rows.length === 0) break;
      let oldestDay = end;
      for (const r of rows) {
        const wall = String(r.date ?? "");
        const t = etWallToEpochMs(wall);
        if (!Number.isFinite(t)) continue;
        if (wall.slice(0, 10) < oldestDay) oldestDay = wall.slice(0, 10);
        byT.set(t, MarketDataService.clean({
          T: ticker, t,
          o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close),
          v: Number(r.volume),
        }));
      }
      // Covered the window, or no progress (a single day bigger than the cap).
      if (oldestDay <= from || oldestDay === end) break;
      end = oldestDay;
    }
    return [...byT.values()].sort((a, b) => a.t - b.t);
  }

  async getGroupedDaily(date: string): Promise<PolygonAggBar[]> {
    return this.fmpFirst(
      `grouped-daily ${date}`,
      async () => {
        const t = etMidnightMs(date);
        return parseEodBulkCsv(await this.fmpApi.requestText(`eod-bulk?date=${date}`))
          // eod-bulk is GLOBAL and includes mutual funds; Polygon's grouped
          // feed is US listings that traded. Keep US-shaped symbols with volume.
          .filter((b) => b.date === date && isUsSymbol(b.symbol) && b.volume > 0)
          .map((b) => MarketDataService.clean({
            T: fromFmpSymbol(b.symbol), t,
            o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume,
          }));
      },
      () => super.getGroupedDaily(date),
    );
  }

  async getOfficialClose(ticker: string, date: string): Promise<number | null> {
    if (isPolygonOnlyTicker(ticker)) return super.getOfficialClose(ticker, date);
    return this.fmpFirst(
      `official close ${ticker} ${date}`,
      async () => {
        const rows = (await this.fmpApi.request(
          `historical-price-eod/full?symbol=${encodeURIComponent(toFmpSymbol(ticker))}&from=${date}&to=${date}`,
          { retries: 0 },
        )) as Row[];
        return num(rows.find((r) => String(r.date) === date)?.close);
      },
      () => super.getOfficialClose(ticker, date),
    );
  }

  // ── Reference ─────────────────────────────────────────────────────────────

  /**
   * Peers: FMP's list when it has at least MIN_FMP_PEERS US names. FMP peers
   * are global and lean on foreign OTC lines — for AAPL it answers 002241.SZ,
   * PCRFF, SONY, SSNLF, XIACF, i.e. just SONY once filtered, where Polygon
   * answers MSFT, AMZN, GOOGL, NVDA — so a short FMP list yields to a longer
   * Polygon one, but is still used when Polygon has none (GAUZ).
   */
  async getRelatedCompanies(ticker: string): Promise<string[]> {
    let fromFmp: string[] = [];
    if (this.fmpApi.enabled) {
      try {
        const rows = (await this.fmpApi.request(
          `stock-peers?symbol=${encodeURIComponent(toFmpSymbol(ticker))}`,
        )) as Row[];
        fromFmp = rows
          .map((r) => String(r.symbol ?? ""))
          .filter((s) => isUsSymbol(s) && !/^[A-Z]{4}[FY]$/.test(s))
          .map(fromFmpSymbol)
          .filter((s) => s !== ticker.toUpperCase());
      } catch (err) {
        this.routeLogger.warn(`peers ${ticker}: FMP failed (${(err as Error)?.message ?? err}) — Polygon fallback`);
      }
    }
    if (fromFmp.length >= MIN_FMP_PEERS) return fromFmp;
    const fromPolygon = await super.getRelatedCompanies(ticker).catch(() => [] as string[]);
    return fromPolygon.length > fromFmp.length ? fromPolygon : fromFmp;
  }

  /**
   * FMP `profile` mapped onto the Polygon ticker-details field names consumers
   * read (name, market_cap, description, primary_exchange, shares outstanding,
   * homepage …). FMP has no SIC code, and sector/industry across the app is
   * derived from SIC (classifyFromSic), so it comes from SEC EDGAR — the same
   * authoritative source the Polygon path already falls back to.
   */
  async getTickerDetails(ticker: string): Promise<any> {
    if (isPolygonOnlyTicker(ticker)) return super.getTickerDetails(ticker);
    return this.fmpFirst(
      `details ${ticker}`,
      async () => {
        const [p] = (await this.fmpApi.request(
          `profile?symbol=${encodeURIComponent(toFmpSymbol(ticker))}`,
        )) as Row[];
        if (!p || !p.companyName) return null;
        const marketCap = num(p.marketCap);
        const price = num(p.price);
        const shares = marketCap != null && price ? Math.round(marketCap / price) : null;
        const isFund = !!p.isEtf || !!p.isFund;
        const sic = isFund ? null : await this.sec.getSicByTicker(ticker).catch(() => null);
        return {
          ticker: ticker.toUpperCase(),
          name: p.companyName,
          market: "stocks",
          locale: "us",
          type: p.isEtf ? "ETF" : p.isFund ? "FUND" : p.isAdr ? "ADRC" : "CS",
          active: p.isActivelyTrading !== false,
          currency_name: p.currency ? String(p.currency).toLowerCase() : "usd",
          cik: p.cik ?? undefined,
          primary_exchange: exchangeToMic(p.exchange),
          market_cap: marketCap,
          share_class_shares_outstanding: shares,
          weighted_shares_outstanding: shares,
          description: p.description ?? null,
          homepage_url: p.website ?? null,
          phone_number: p.phone ?? null,
          ceo: p.ceo ?? null,
          total_employees: num(p.fullTimeEmployees),
          list_date: await (async () => {
            let ld = p.ipoDate ? String(p.ipoDate).slice(0, 10) : null;
            try {
              const poly = await super.getTickerDetails(ticker).catch(() => null);
              if (poly?.list_date && (!ld || poly.list_date < ld)) ld = poly.list_date;
            } catch {}
            return ld;
          })(),
          address: { address1: p.address ?? null, city: p.city ?? null, state: p.state ?? null, postal_code: p.zip ?? null },
          sic_code: sic,
          sic_description: null,
          branding: p.image ? { icon_url: p.image, logo_url: p.image } : undefined,
          source: "fmp",
        };
      },
      () => super.getTickerDetails(ticker),
    );
  }

  async getBrandingImage(ticker: string): Promise<{ data: Buffer; contentType: string } | null> {
    return this.fmpFirst(
      `logo ${ticker}`,
      async () => {
        const resp = await fetch(
          `https://images.financialmodelingprep.com/symbol/${encodeURIComponent(toFmpSymbol(ticker))}.png`,
          { signal: AbortSignal.timeout(10_000) },
        );
        if (!resp.ok) return null;
        const contentType = resp.headers.get("content-type") ?? "image/png";
        if (!contentType.startsWith("image/")) return null;
        const data = Buffer.from(await resp.arrayBuffer());
        return data.length > 0 ? { data, contentType } : null;
      },
      () => super.getBrandingImage(ticker),
    );
  }

  /**
   * Active US listings: FMP's company screener first, Polygon's reference list
   * merged in. FMP wins the name for every symbol it lists; Polygon adds the
   * symbols FMP does not carry plus the type/CIK/FIGI fields FMP lacks, and
   * keeps the venue — FMP labels NYSE American listings "NYSE Arca" (IMO, BTG).
   * Either vendor alone still yields a universe, so one outage degrades
   * coverage instead of failing the load. Inactive listings stay Polygon-only.
   */
  async getAllTickers(active = true): Promise<PolygonTickerRef[]> {
    if (!active || !this.fmpApi.enabled) return super.getAllTickers(active);
    const [fmp, polygon] = await Promise.allSettled([
      this.fmpTickerUniverse(),
      super.getAllTickers(active),
    ]);
    if (fmp.status === "rejected") {
      this.routeLogger.warn(`ticker universe: FMP failed (${(fmp.reason as Error)?.message ?? fmp.reason}) — Polygon only`);
    }
    if (polygon.status === "rejected") {
      if (fmp.status === "rejected" || fmp.value.length === 0) throw polygon.reason;
      this.routeLogger.warn(`ticker universe: Polygon gap-fill failed (${(polygon.reason as Error)?.message ?? polygon.reason}) — FMP only`);
    }
    const fromFmp = fmp.status === "fulfilled" ? fmp.value : [];
    const fromPolygon = polygon.status === "fulfilled" ? polygon.value : [];
    const polygonBy = new Map(fromPolygon.map((t) => [t.ticker, t] as const));
    const out: PolygonTickerRef[] = [];
    const seen = new Set<string>();
    for (const f of fromFmp) {
      const p = polygonBy.get(f.ticker);
      // With Polygon's list in hand, add only FMP-only symbols of 1–4 letters:
      // dotted forms (MER.PK, AAC.UN) are share classes Polygon spells
      // differently (MERpK, AAC.U), and 5-letter ones are warrants, rights,
      // mutual funds or NASDAQ test symbols (BBBYW, FPCRX, ZXZZT) the
      // screener reports as plain stock.
      if (!p && fromPolygon.length > 0 && !/^[A-Z]{1,4}$/.test(f.ticker)) continue;
      out.push(p ? { ...p, name: f.name || p.name } : f);
      seen.add(f.ticker);
    }
    for (const p of fromPolygon) if (!seen.has(p.ticker)) out.push(p);
    return out;
  }

  private async fmpTickerUniverse(): Promise<PolygonTickerRef[]> {
    const out: PolygonTickerRef[] = [];
    for (const exchange of FMP_US_EXCHANGES) {
      // isFund=false drops mutual funds (Polygon's stock market has none); ETFs
      // are flagged isEtf, never isFund, so they stay in.
      const rows = (await this.fmpApi.request(
        `company-screener?exchange=${exchange}&isActivelyTrading=true&isFund=false&limit=${FMP_SCREENER_LIMIT}`,
      )) as Row[];
      if (rows.length >= FMP_SCREENER_LIMIT) {
        throw new Error(`company-screener ${exchange} hit the ${FMP_SCREENER_LIMIT}-row cap — list may be truncated`);
      }
      for (const r of rows) {
        const symbol = String(r.symbol ?? "");
        if (!isUsSymbol(symbol) || !r.companyName) continue;
        out.push({
          ticker: fromFmpSymbol(symbol),
          name: String(r.companyName),
          market: "stocks",
          locale: "us",
          primary_exchange: micFromFmpExchange(r.exchange, r.exchangeShortName) ?? undefined,
          type: r.isEtf ? "ETF" : "CS",
          active: true,
          currency_name: "usd",
        });
      }
    }
    return out;
  }

  private delistedIndex: { at: number; bySymbol: Map<string, string> } | null = null;
  private delistedLoading: Promise<Map<string, string>> | null = null;

  /**
   * FMP's delisting record for a symbol first; Polygon's inactive record when
   * FMP holds none (null either way when neither vendor has one — a symbol
   * that merely went missing from one listing pull is not proof of delisting).
   */
  async getDelisting(ticker: string): Promise<{ delistedAt: string | null } | null> {
    return this.fmpFirst(
      `delisting ${ticker}`,
      async () => {
        const delistedAt = (await this.fmpDelistedIndex()).get(ticker.toUpperCase());
        return delistedAt ? { delistedAt } : null;
      },
      () => super.getDelisting(ticker),
    );
  }

  /** US symbol → newest FMP delisting date, built once per TTL and shared by concurrent lookups. */
  private async fmpDelistedIndex(): Promise<Map<string, string>> {
    if (this.delistedIndex && Date.now() - this.delistedIndex.at < FMP_DELISTED_TTL_MS) {
      return this.delistedIndex.bySymbol;
    }
    this.delistedLoading ??= (async () => {
      const today = etParts(Date.now()).date;
      const bySymbol = new Map<string, string>();
      for (let page = 0; page < FMP_DELISTED_MAX_PAGES; page++) {
        const rows = (await this.fmpApi.request(`delisted-companies?page=${page}&limit=100`)) as Row[];
        if (rows.length === 0) break;
        for (const r of rows) {
          const symbol = String(r.symbol ?? "");
          const date = String(r.delistedDate ?? "").slice(0, 10);
          // The feed is global and lists scheduled (future) delistings too.
          if (!isUsSymbol(symbol) || !US_LISTING_VENUE.test(String(r.exchange ?? ""))) continue;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) continue;
          const ticker = fromFmpSymbol(symbol);
          const prev = bySymbol.get(ticker);
          if (!prev || date > prev) bySymbol.set(ticker, date);
        }
      }
      this.delistedIndex = { at: Date.now(), bySymbol };
      return bySymbol;
    })().finally(() => {
      this.delistedLoading = null;
    });
    return this.delistedLoading;
  }

  // ── Corporate actions & calendars ─────────────────────────────────────────

  async getDividendHistory(ticker: string, limit = 200) {
    return this.fmpFirst(
      `dividend history ${ticker}`,
      async () => {
        const rows = (await this.fmpApi.request(
          `dividends?symbol=${encodeURIComponent(toFmpSymbol(ticker))}`,
        )) as Row[];
        return rows
          .map((d) => ({
            exDividendDate: d.date ?? null,
            paymentDate: d.paymentDate || null,
            declarationDate: d.declarationDate || null,
            recordDate: d.recordDate || null,
            cashAmount: num(d.dividend),
            dividendType: dividendTypeFor(d.frequency),
            frequency: frequencyToNumber(d.frequency),
          }))
          .sort((a, b) => String(b.exDividendDate).localeCompare(String(a.exDividendDate)))
          .slice(0, limit);
      },
      () => super.getDividendHistory(ticker, limit),
    );
  }

  async getSplits(ticker: string, limit = 50) {
    return this.fmpFirst(
      `splits ${ticker}`,
      async () => {
        const rows = (await this.fmpApi.request(
          `splits?symbol=${encodeURIComponent(toFmpSymbol(ticker))}`,
        )) as Row[];
        return rows
          .filter((s) => num(s.numerator) && num(s.denominator))
          .map((s) => ({
            executionDate: String(s.date).slice(0, 10),
            // Polygon: AAPL's 4-for-1 is split_from 1, split_to 4.
            splitFrom: Number(s.denominator),
            splitTo: Number(s.numerator),
          }))
          .sort((a, b) => b.executionDate.localeCompare(a.executionDate))
          .slice(0, limit);
      },
      () => super.getSplits(ticker, limit),
      // An empty split history is normal — only fall back on an error.
      (v) => v == null,
    );
  }

  async getSplitsInRange(afterDate: string, throughDate: string) {
    return this.fmpFirst(
      `splits ${afterDate}..${throughDate}`,
      async () => {
        const rows = (await this.fmpApi.request(
          `splits-calendar?from=${addDays(afterDate, 1)}&to=${throughDate}`,
        )) as Row[];
        return rows
          .filter((s) => isUsSymbol(String(s.symbol ?? "")) && num(s.numerator) && num(s.denominator))
          .filter((s) => String(s.date) > afterDate && String(s.date) <= throughDate)
          .map((s) => ({
            ticker: fromFmpSymbol(String(s.symbol)),
            executionDate: String(s.date).slice(0, 10),
            splitFrom: Number(s.denominator),
            splitTo: Number(s.numerator),
          }));
      },
      () => super.getSplitsInRange(afterDate, throughDate),
      (v) => v == null,
    );
  }

  async getDividendsCalendar(from: string, to: string) {
    return this.fmpFirst(
      `dividends calendar ${from}..${to}`,
      async () => {
        const rows: Row[] = [];
        // Weekly windows keep each answer under FMP's 4000-row cap; a capped
        // week is re-read a day at a time.
        for (let start = from; start <= to; start = addDays(start, 7)) {
          const end = addDays(start, 6) < to ? addDays(start, 6) : to;
          const week = (await this.fmpApi.request(`dividends-calendar?from=${start}&to=${end}`)) as Row[];
          if (week.length < FMP_CALENDAR_CAP) {
            rows.push(...week);
            continue;
          }
          for (let d = start; d <= end; d = addDays(d, 1)) {
            rows.push(...((await this.fmpApi.request(`dividends-calendar?from=${d}&to=${d}`)) as Row[]));
          }
        }
        const us = rows.filter((d) => isUsSymbol(String(d.symbol ?? "")) && d.date >= from && d.date <= to);
        // The dividends job keys docs on symbol+date and appends vendorEventId
        // only to separate two events on one ex-date (regular + special).
        const perDay = new Map<string, number>();
        for (const d of us) perDay.set(`${d.symbol}_${d.date}`, (perDay.get(`${d.symbol}_${d.date}`) ?? 0) + 1);
        return us.map((d) => {
          const dividend = num(d.dividend);
          const dividendType = dividendTypeFor(d.frequency);
          return {
            vendorEventId: (perDay.get(`${d.symbol}_${d.date}`) ?? 0) > 1 ? `${dividendType}${dividend ?? ""}` : null,
            dividendType,
            symbol: fromFmpSymbol(String(d.symbol)),
            date: String(d.date),
            recordDate: d.recordDate || null,
            paymentDate: d.paymentDate || null,
            declarationDate: d.declarationDate || null,
            dividend,
            yield: null,
            frequency: frequencyToLabel(d.frequency),
          };
        });
      },
      () => super.getDividendsCalendar(from, to),
    );
  }

  async getIpoCalendar(from: string, to: string) {
    return this.fmpFirst(
      `ipo calendar ${from}..${to}`,
      async () => {
        const today = etParts(Date.now()).date;
        const rows = (await this.fmpApi.request(`ipos-calendar?from=${from}&to=${to}`)) as Row[];
        return rows
          .filter((r) => r.symbol && isUsSymbol(String(r.symbol)))
          .map((r) => {
            const { price, single } = normalizePriceRange(r.priceRange);
            const status = ipoStatusFor(r.actions, String(r.date ?? ""), today);
            return {
              date: String(r.date ?? ""),
              symbol: fromFmpSymbol(String(r.symbol)),
              name: String(r.company ?? ""),
              exchange: String(r.exchange ?? ""),
              price,
              finalPrice: status === "priced" || status === "history" ? single : null,
              numberOfShares: num(r.shares),
              totalSharesValue: num(r.dealSize),
              status,
            };
          });
      },
      () => super.getIpoCalendar(from, to),
    );
  }

  // ── Market clock ──────────────────────────────────────────────────────────

  private async fmpHolidays(): Promise<Row[]> {
    const [nyse, nasdaq] = await Promise.all([
      this.fmpApi.request("holidays-by-exchange?exchange=NYSE") as Promise<Row[]>,
      this.fmpApi.request("holidays-by-exchange?exchange=NASDAQ") as Promise<Row[]>,
    ]);
    return [...nyse, ...nasdaq];
  }

  async getMarketStatus() {
    return this.fmpFirst(
      "market status",
      async () => {
        const now = Date.now();
        const today = etParts(now).date;
        const [hours, holidays] = await Promise.all([
          this.fmpApi.request("exchange-market-hours?exchange=NYSE") as Promise<Row[]>,
          this.fmpHolidays(),
        ]);
        if (hours.length === 0) return null;
        const todayRow = holidays.find((h) => h.date === today);
        const closedToday = !!todayRow?.isClosed;
        // Early close (e.g. day after Thanksgiving): adjCloseTime "1:00 PM".
        const early = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(String(todayRow?.adjCloseTime ?? ""));
        const closeMinute = early
          ? ((Number(early[1]) % 12) + (early[3].toUpperCase() === "PM" ? 12 : 0)) * 60 + Number(early[2])
          : 16 * 60;
        let phase = closedToday ? "closed" : sessionPhase(now, closeMinute);
        // FMP's own flag is the authority on whether the regular session is live.
        if (phase === "open" && hours[0].isMarketOpen === false) phase = "closed";
        const state = phase === "open" ? "open" : phase === "closed" ? "closed" : "extended-hours";
        return {
          market: state,
          earlyHours: phase === "pre",
          afterHours: phase === "post",
          exchanges: { nyse: state, nasdaq: state, otc: state },
          serverTime: new Date(now).toISOString(),
        };
      },
      () => super.getMarketStatus(),
    );
  }

  async getUpcomingMarketHolidays() {
    return this.fmpFirst(
      "market holidays",
      async () => {
        const today = etParts(Date.now()).date;
        return (await this.fmpHolidays())
          .filter((h) => String(h.date) >= today)
          .map((h) => ({
            date: String(h.date),
            exchange: String(h.exchange),
            name: String(h.name ?? ""),
            status: h.isClosed ? "closed" : "early-close",
            ...(h.adjOpenTime ? { open: String(h.adjOpenTime) } : {}),
            ...(h.adjCloseTime ? { close: String(h.adjCloseTime) } : {}),
          }))
          .sort((a, b) => a.date.localeCompare(b.date));
      },
      () => super.getUpcomingMarketHolidays(),
    );
  }

  async getTreasuryYields(limit = 2) {
    return this.fmpFirst(
      "treasury yields",
      async () => {
        const to = isoDay(Date.now());
        const from = isoDay(Date.now() - Math.max(21, limit * 2) * 86_400_000);
        const rows = (await this.fmpApi.request(`treasury-rates?from=${from}&to=${to}`)) as Row[];
        return rows
          .sort((a, b) => String(b.date).localeCompare(String(a.date)))
          .slice(0, limit)
          .map((r) => ({
            date: String(r.date),
            yield1Month: num(r.month1),
            yield3Month: num(r.month3),
            yield1Year: num(r.year1),
            yield2Year: num(r.year2),
            yield5Year: num(r.year5),
            yield10Year: num(r.year10),
            yield30Year: num(r.year30),
            source: "fmp" as const,
          }));
      },
      () => super.getTreasuryYields(limit),
    );
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  /**
   * FMP batch-quote (+ batch extended-hours trades) in Polygon's universal
   * snapshot shape. Tickers FMP cannot price — and Polygon-only ones (I:SPX) —
   * are fetched from Polygon and merged, so a partial FMP answer never drops rows.
   */
  async getUniversalSnapshot(tickers: string[]) {
    if (tickers.length === 0) return [];
    type Snap = Awaited<ReturnType<PolygonService["getUniversalSnapshot"]>>[number];
    const fmpTickers = tickers.filter((t) => !isPolygonOnlyTicker(t));
    let fromFmp: Snap[] = [];
    if (this.fmpApi.enabled && fmpTickers.length > 0) {
      try {
        fromFmp = await this.fmpSnapshot(fmpTickers);
      } catch (err) {
        this.routeLogger.warn(`snapshot: FMP failed (${(err as Error)?.message ?? err}) — Polygon fallback`);
      }
    }
    const have = new Set(fromFmp.map((s) => s.ticker));
    const missing = tickers.filter((t) => !have.has(t));
    const fromPolygon = missing.length ? await super.getUniversalSnapshot(missing) : [];
    const byTicker = new Map([...fromPolygon, ...fromFmp].map((s) => [s.ticker, s] as const));
    return tickers.map((t) => byTicker.get(t)).filter((s): s is Snap => !!s);
  }

  private async fmpSnapshot(tickers: string[]) {
    const symToTicker = new Map(tickers.map((t) => [toFmpSymbol(t), t] as const));
    const syms = [...symToTicker.keys()];
    const [quotes, ext] = await Promise.all([
      this.fmpApi.request(`batch-quote?symbols=${encodeURIComponent(syms.join(","))}`) as Promise<Row[]>,
      this.fmpApi.getExtendedTrades(syms),
    ]);
    const extBy = new Map(ext.map((e) => [e.symbol, e] as const));
    const now = Date.now();
    const today = etParts(now).date;
    const phase = sessionPhase(now);
    const marketStatus =
      phase === "open" ? "open" : phase === "pre" ? "early_trading" : phase === "post" ? "late_trading" : "closed";
    return quotes
      .filter((q) => symToTicker.has(String(q.symbol)) && num(q.price) != null)
      .map((q) => {
        const ticker = symToTicker.get(String(q.symbol))!;
        const price = num(q.price)!;
        // /stable/quote is regular-session only: before the open `price` is
        // still the prior close, after the close it is today's close — which
        // is exactly the base each extended-hours move is measured from.
        const e = extBy.get(String(q.symbol));
        const eParts = e ? etParts(e.at) : null;
        const eMin = eParts ? eParts.hour * 60 + eParts.minute : -1;
        const extPct = e && price > 0 ? ((e.price - price) / price) * 100 : null;
        const early = eParts?.date === today && eMin < 9 * 60 + 30 ? extPct : null;
        const late = eParts?.date === today && eMin >= 16 * 60 ? extPct : null;
        return {
          ticker,
          name: q.name ?? null,
          marketStatus,
          price,
          change: num(q.change),
          changePercent: num(q.changePercentage ?? q.changesPercentage),
          earlyTradingChangePercent: early,
          lateTradingChangePercent: late,
          open: num(q.open),
          high: num(q.dayHigh),
          low: num(q.dayLow),
          previousClose: num(q.previousClose),
          volume: num(q.volume),
          vwap: null,
          source: "fmp" as const,
        };
      });
  }
}
