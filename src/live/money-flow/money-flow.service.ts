import { Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "../../common/firebase-admin.provider";
import { classifyFromSic } from "../../common/sic-tv.util";
import { reconcileMarketCap } from "../../common/validate.util";
import { FmpService, type FmpFullQuote } from "../../vendors/fmp/fmp.service";
import { PolygonService } from "../../vendors/polygon/polygon.service";
import {
  AVG_VOLUME_SESSIONS,
  BAR_MINUTES,
  buildBoard,
  canonicalTicker,
  etClock,
  fmpTicker,
  isSessionComplete,
  referenceFromGrouped,
  type GroupedRow,
  type MoneyFlowBoard,
  type RawBar,
  type StockIn,
} from "./money-flow.calc";

/** Board rebuild interval; a request inside it gets the cached board. */
const BOARD_TTL_MS = 30_000;
/** 5-minute bars are re-pulled at most this often while the session runs. */
const BARS_TTL_MS = 2 * 60_000;
const CONSTITUENTS_TTL_MS = 12 * 60 * 60_000;
const DETAILS_TTL_MS = 24 * 60 * 60_000;
const REFERENCE_TTL_MS = 12 * 60 * 60_000;
const FMP_QUOTE_CHUNK = 100;
const POLYGON_CONCURRENCY = 32;
/** Market proxy whose bars and quote date the board's session. */
const SESSION_PROXY = "SPY";

interface Details {
  at: number;
  name: string | null;
  sic: string | number | null;
  shares: number | null;
  marketCap: number | null;
}

interface Reference {
  sessionDate: string;
  at: number;
  prevSessionDate: string | null;
  prevDay: Map<string, { h: number; l: number; c: number }>;
  avgVolume20: Map<string, number>;
  companies: Map<string, { sector: string | null; name: string | null }>;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * GET /live/money-flow — the Money Flow board, built from vendor data and
 * cached for every viewer (one build per BOARD_TTL_MS, whatever the traffic).
 * Calculations live in money-flow.calc.ts; this class only fetches.
 */
@Injectable()
export class MoneyFlowService {
  private readonly logger = new Logger(MoneyFlowService.name);
  private board: { at: number; value: MoneyFlowBoard } | null = null;
  private building: Promise<MoneyFlowBoard> | null = null;
  private constituents: { at: number; sp500: Set<string>; nasdaq100: Set<string>; names: Map<string, string> } | null =
    null;
  private reference: Reference | null = null;
  private bars: { sessionDate: string; at: number; map: Map<string, RawBar[]> } | null = null;
  private readonly details = new Map<string, Details | null>();
  private readonly detailsAt = new Map<string, number>();

  constructor(
    private readonly polygon: PolygonService,
    private readonly fmp: FmpService,
    private readonly firebase: FirebaseAdminService,
  ) {}

  async get(): Promise<MoneyFlowBoard> {
    if (this.board && Date.now() - this.board.at < BOARD_TTL_MS) return this.board.value;
    const pending = this.refresh();
    // Serve the previous board while the next one builds.
    return this.board ? this.board.value : pending;
  }

  private refresh(): Promise<MoneyFlowBoard> {
    if (!this.building) {
      this.building = this.build()
        .then((b) => {
          this.board = { at: Date.now(), value: b };
          return b;
        })
        .finally(() => {
          this.building = null;
        });
      this.building.catch((err) => this.logger.warn(`money-flow build failed: ${(err as Error).message}`));
    }
    return this.building;
  }

  private async build(): Promise<MoneyFlowBoard> {
    const now = Date.now();
    const { sp500, nasdaq100, names } = await this.loadConstituents();
    const universe = [...new Set([...sp500, ...nasdaq100])].sort();

    const phase: string[] = [];
    let mark = Date.now();
    const lap = (name: string) => {
      phase.push(`${name} ${Date.now() - mark}ms`);
      mark = Date.now();
    };
    lap("constituents");
    const quotes = await this.loadQuotes([SESSION_PROXY, ...universe]);
    lap("quotes");
    const sessionDate = await this.sessionDate(quotes.get(SESSION_PROXY) ?? null, now);
    lap("session");
    const ref = await this.loadReference(sessionDate, universe);
    lap("reference");
    const bars = await this.loadBars(sessionDate, universe, now);
    lap("bars");

    const needSector = universe.filter((t) => !ref.companies.get(t)?.sector);
    await this.loadDetails(needSector);
    lap("details");

    const stocks: StockIn[] = universe.map((t) => {
      const q = quotes.get(t);
      const co = ref.companies.get(t);
      const det = this.details.get(t);
      return {
        ticker: t,
        name: co?.name ?? det?.name ?? names.get(t) ?? null,
        sector: co?.sector ?? (det ? classifyFromSic(det.sic, t).sector : null) ?? null,
        inSp500: sp500.has(t),
        inNasdaq100: nasdaq100.has(t),
        quote: q ? { price: q.price, previousClose: q.previousClose, changePercentage: q.changePercentage } : null,
        bars: bars.get(t) ?? [],
        prevDay: ref.prevDay.get(t) ?? null,
        avgVolume20: ref.avgVolume20.get(t) ?? null,
        marketCap: null,
      };
    });

    const board = buildBoard({ sessionDate, prevSessionDate: ref.prevSessionDate, now, stocks });

    // Market cap only for the stocks on the board (the hover box shows it).
    const shown = [...board.gainers, ...board.losers];
    await this.loadDetails(shown.map((s) => s.t));
    for (const s of shown) {
      const det = this.details.get(s.t);
      s.marketCap = det ? reconcileMarketCap(det.marketCap, s.price, det.shares) : null;
    }
    lap("marketCap");
    this.logger.log(
      `money-flow ${sessionDate}: ${board.universe.priced}/${board.universe.total} priced, ` +
        `${board.universe.withBars} with bars, ${board.sectors.length} sectors, ${Date.now() - now}ms (${phase.join(", ")})`,
    );
    return board;
  }

  private async loadConstituents() {
    if (this.constituents && Date.now() - this.constituents.at < CONSTITUENTS_TTL_MS) return this.constituents;
    try {
      const [sp, nd] = await Promise.all([
        this.fmp.request("sp500-constituent"),
        this.fmp.request("nasdaq-constituent"),
      ]);
      const names = new Map<string, string>();
      const set = (rows: unknown[]) => {
        const s = new Set<string>();
        for (const r of rows as Array<{ symbol?: string; name?: string }>) {
          if (!r?.symbol) continue;
          const t = canonicalTicker(r.symbol);
          s.add(t);
          if (r.name) names.set(t, r.name);
        }
        return s;
      };
      const sp500 = set(sp);
      const nasdaq100 = set(nd);
      if (sp500.size === 0 || nasdaq100.size === 0) throw new Error(`empty constituents (${sp500.size}/${nasdaq100.size})`);
      this.constituents = { at: Date.now(), sp500, nasdaq100, names };
    } catch (err) {
      if (!this.constituents) throw err;
      this.logger.warn(`money-flow: constituents refresh failed, keeping previous: ${(err as Error).message}`);
    }
    return this.constituents!;
  }

  private async loadQuotes(tickers: string[]): Promise<Map<string, FmpFullQuote>> {
    const out = new Map<string, FmpFullQuote>();
    for (let i = 0; i < tickers.length; i += FMP_QUOTE_CHUNK) {
      const rows = await this.fmp.getQuotes(tickers.slice(i, i + FMP_QUOTE_CHUNK).map(fmpTicker));
      for (const q of rows) out.set(canonicalTicker(q.symbol), q);
    }
    return out;
  }

  /**
   * The session the board shows: the later of the proxy's latest regular-session
   * bar date and its quote's date. Before the open both point at the last
   * session; from 09:30 the quote moves first, and bars follow 15 minutes later.
   */
  private async sessionDate(proxyQuote: FmpFullQuote | null, now: number): Promise<string> {
    const today = etClock(now).date;
    const bars = await this.polygon
      .getIntradayBars(SESSION_PROXY, BAR_MINUTES, "minute", addDays(today, -7), today)
      .catch(() => [] as RawBar[]);
    let fromBars: string | null = null;
    for (const b of bars) {
      const { date, minutes } = etClock(b.t);
      if (minutes >= 570 && minutes < 960 && (!fromBars || date > fromBars)) fromBars = date;
    }
    const fromQuote = proxyQuote?.timestamp ? etClock(proxyQuote.timestamp * 1000).date : null;
    const d = [fromBars, fromQuote].filter((x): x is string => !!x && x <= today).sort().pop();
    if (!d) throw new Error("money-flow: no session date from bars or quote");
    return d;
  }

  private async loadReference(sessionDate: string, universe: string[]): Promise<Reference> {
    const r = this.reference;
    if (r && r.sessionDate === sessionDate && Date.now() - r.at < REFERENCE_TTL_MS) return r;
    const want = new Set([...universe, SESSION_PROXY]);
    // Weekdays back from the session, all at once; holidays come back empty and
    // drop out, and a further batch is fetched only if they left too few.
    const grouped: Record<string, GroupedRow[]> = {};
    let from = sessionDate;
    for (let round = 0; Object.keys(grouped).length < AVG_VOLUME_SESSIONS && round < 3; round++) {
      const need = AVG_VOLUME_SESSIONS - Object.keys(grouped).length + 2;
      const batch: string[] = [];
      for (let d = addDays(from, -1); batch.length < need; d = addDays(d, -1)) {
        const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
        if (wd !== 0 && wd !== 6) batch.push(d);
      }
      from = batch[batch.length - 1];
      await mapLimit(batch, batch.length, async (d) => {
        const rows = await this.polygon.getGroupedDaily(d).catch(() => []);
        const kept = rows
          .filter((x) => x.T && want.has(x.T))
          .map((x) => ({ T: x.T as string, h: x.h, l: x.l, c: x.c, v: x.v }));
        if (kept.length) grouped[d] = kept;
      });
    }
    const { prevSessionDate, prevDay, avgVolume20 } = referenceFromGrouped(grouped, sessionDate);

    const companies = new Map<string, { sector: string | null; name: string | null }>();
    const db = this.firebase.firestore;
    const refs = universe.map((t) => db.collection("companies").doc(t));
    for (let i = 0; i < refs.length; i += 300) {
      const snaps = await db.getAll(...refs.slice(i, i + 300), { fieldMask: ["sector", "name"] });
      for (const s of snaps) {
        if (!s.exists) continue;
        companies.set(s.id, {
          sector: (s.get("sector") as string | undefined) || null,
          name: (s.get("name") as string | undefined) || null,
        });
      }
    }
    this.reference = { sessionDate, at: Date.now(), prevSessionDate, prevDay, avgVolume20, companies };
    return this.reference;
  }

  private async loadBars(sessionDate: string, universe: string[], now: number): Promise<Map<string, RawBar[]>> {
    const prev = this.bars;
    const sameSession = prev?.sessionDate === sessionDate;
    if (sameSession && (isSessionComplete(sessionDate, prev!.at) || now - prev!.at < BARS_TTL_MS)) return prev!.map;
    const map = new Map<string, RawBar[]>();
    await mapLimit(universe, POLYGON_CONCURRENCY, async (t) => {
      try {
        map.set(t, await this.polygon.getIntradayBars(t, BAR_MINUTES, "minute", sessionDate, sessionDate));
      } catch (err) {
        const keep = sameSession ? prev!.map.get(t) : undefined;
        if (keep) map.set(t, keep);
        this.logger.debug(`money-flow bars ${t}: ${(err as Error).message}`);
      }
    });
    this.bars = { sessionDate, at: now, map };
    return map;
  }

  private async loadDetails(tickers: string[]): Promise<void> {
    const stale = tickers.filter((t) => {
      const at = this.detailsAt.get(t);
      return at == null || Date.now() - at > DETAILS_TTL_MS;
    });
    await mapLimit(stale, POLYGON_CONCURRENCY, async (t) => {
      try {
        const d = await this.polygon.getTickerDetails(t);
        this.details.set(
          t,
          d
            ? {
                at: Date.now(),
                name: (d.name as string) ?? null,
                sic: (d.sic_code as string) ?? null,
                shares: typeof d.weighted_shares_outstanding === "number" ? d.weighted_shares_outstanding : null,
                marketCap: typeof d.market_cap === "number" ? d.market_cap : null,
              }
            : null,
        );
      } catch {
        this.details.set(t, null);
      }
      this.detailsAt.set(t, Date.now());
    });
  }
}
