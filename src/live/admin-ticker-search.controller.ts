import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AdminGuard } from "../common/admin.guard";
import { AllowEditor } from "../common/editor-access.decorator";
import { DelistedTickersService } from "../common/delisted-tickers.service";
import { CachedCollectionsService } from "./cached-collections.service";
import { OnDemandService } from "./ondemand.service";
import { TickerSearchService, type SearchHit } from "./ticker-search.service";
import type { QuoteRow } from "./official-quote.util";

/**
 * The ticker picker in the admin console (Market Catalyst Pulse). The console
 * runs on the admin account, which has no plan, so it can't use the user
 * routes (/live/search, /market-data/companies, /live/quotes) that Market
 * Catalyst's search box calls. This serves the same search in one call:
 *
 *   empty q → the 15 largest companies (quick access);
 *   otherwise → /live/search hits + company name/ticker substring matches,
 *   ranked exact ticker → ticker prefix → name prefix → substring
 *   (the rules of the UI's app/iq/search-matches.ts),
 *
 * then live quotes for the first 12 (the same shared quote cache).
 */

export interface PickRow {
  sym: string;
  name: string | null;
  price: number | null;
  pctChange: number | null;
  extended: unknown;
}

interface CompanyLike {
  ticker?: unknown;
  name?: unknown;
  price?: unknown;
  pctChange?: unknown;
  marketCap?: unknown;
}

const QUICK = 15;
const SHOW = 12;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v ? v : null;

interface Match {
  sym: string;
  name: string | null;
  price: number | null;
  pctChange: number | null;
}

/** Ranking shared in spirit with the UI's searchMatchesFor — keep the two in step. */
export function rankMatches(
  query: string,
  hits: Array<{ ticker: string; name: string | null }>,
  companies: CompanyLike[],
): Match[] {
  const cos: Array<Match & { cap: number }> = companies
    .map((c) => ({
      sym: str(c.ticker) ?? "",
      name: str(c.name),
      price: num(c.price),
      pctChange: num(c.pctChange),
      cap: num(c.marketCap) ?? 0,
    }))
    .filter((c) => c.sym);
  const strip = (c: Match & { cap: number }): Match => ({
    sym: c.sym,
    name: c.name,
    price: c.price,
    pctChange: c.pctChange,
  });
  if (!query.trim()) {
    return [...cos]
      .sort((a, b) => b.cap - a.cap)
      .slice(0, QUICK)
      .map(strip);
  }
  const q = query.trim().toLowerCase();
  const upper = query.trim().toUpperCase();
  const bySym = new Set(hits.map((h) => h.ticker));
  const coBySym = new Map(cos.map((c) => [c.sym, c]));
  const candidates: Match[] = [
    ...hits.map((h) => ({
      sym: h.ticker,
      name: h.name,
      price: coBySym.get(h.ticker)?.price ?? null,
      pctChange: coBySym.get(h.ticker)?.pctChange ?? null,
    })),
    ...cos
      .filter(
        (c) =>
          !bySym.has(c.sym) &&
          ((c.name ?? "").toLowerCase().includes(q) ||
            c.sym.toLowerCase().includes(q)),
      )
      .map(strip),
  ];
  const exact: Match[] = [];
  const tickerPrefix: Match[] = [];
  const namePrefix: Match[] = [];
  const substring: Match[] = [];
  for (const m of candidates) {
    const s = m.sym.toUpperCase();
    const n = (m.name ?? "").toLowerCase();
    if (s === upper) exact.push(m);
    else if (s.startsWith(upper)) tickerPrefix.push(m);
    else if (n.startsWith(q)) namePrefix.push(m);
    else substring.push(m);
  }
  return [...exact, ...tickerPrefix, ...namePrefix, ...substring];
}

@AllowEditor()
@UseGuards(AdminGuard)
@Controller("api/admin")
export class AdminTickerSearchController {
  constructor(
    private readonly search: TickerSearchService,
    private readonly cached: CachedCollectionsService,
    private readonly ondemand: OnDemandService,
    private readonly delisted: DelistedTickersService,
  ) {}

  @Get("ticker-search")
  async find(
    @Query("q") q: string | undefined,
  ): Promise<{ q: string; results: PickRow[] }> {
    const query = (q ?? "").trim();
    if (query.length > 40) throw new BadRequestException("q too long");
    const hitsP: Promise<SearchHit[]> = query
      ? this.search
          .search(query)
          .then((r) => this.delisted.filterRows<SearchHit>(r))
      : Promise.resolve<SearchHit[]>([]);
    const [{ companies }, hits] = await Promise.all([
      this.cached.get(["companies"]),
      hitsP,
    ]);
    const gone = await this.delisted.get();
    const ranked = rankMatches(query, hits, (companies ?? []) as CompanyLike[])
      .filter((m) => !gone.has(m.sym))
      .slice(0, SHOW);
    const quotes: QuoteRow[] = ranked.length
      ? await this.ondemand
          .getQuotes(ranked.map((m) => m.sym))
          .catch((): QuoteRow[] => [])
      : [];
    const byT = new Map(quotes.map((x) => [x.ticker.toUpperCase(), x]));
    return {
      q: query,
      results: ranked.map((m) => {
        const lq = byT.get(m.sym.toUpperCase());
        return {
          sym: m.sym,
          name: m.name ?? lq?.name ?? null,
          price: lq?.price ?? m.price,
          pctChange: lq?.pctChange ?? m.pctChange,
          extended: lq?.extended ?? null,
        };
      }),
    };
  }
}
