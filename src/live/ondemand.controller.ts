import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { createHash } from "crypto";
import { OnDemandService, BARS_TFS } from "./ondemand.service";
import { TickerSearchService } from "./ticker-search.service";
import { SearchedTickersService } from "./searched-tickers.service";
import { OPTIONS_UNIVERSE } from "../common/options-universe";

/**
 * On-demand data endpoints (see ondemand.service.ts for the caching design).
 *
 *   GET /live/bars?ticker=AAPL&tf=1Y            → bars, cache-aside via stock_bars
 *   GET /live/company?ticker=AAPL               → profile+price, cache-aside via companies
 *   GET /live/dividend-history?ticker=AAPL      → cache-aside via dividend_history
 *   GET /live/splits?ticker=AAPL                → cache-aside via splits
 *   GET /live/financials?ticker=AAPL            → cache-aside via financials
 *   GET /live/news?ticker=AAPL                  → per-ticker cache-aside via news
 *   GET /live/options-chain?ticker=AAPL         → cache-aside via options_chains (curated 8-ticker universe)
 *   GET /live/search?q=apple                    → in-memory universe search (no Firestore)
 *   POST /live/searched-ticker {ticker}          → record a resolved ticker search/selection
 *   GET /live/most-searched-tickers?limit=10     → top searched tickers, by selection count
 *
 * Responses carry Cache-Control + ETag so each BROWSER also caches: a repeat
 * view inside the max-age costs zero requests, and a 304 costs no body.
 */

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

function etagFor(obj: unknown): string {
  return `"${createHash("sha1").update(JSON.stringify(obj)).digest("hex").slice(0, 20)}"`;
}

function sendWithEtag(req: Request, res: Response, body: unknown): void {
  const tag = etagFor(body);
  res.setHeader("ETag", tag);
  if (req.headers["if-none-match"] === tag) {
    res.status(304).end();
    return;
  }
  res.json(body);
}

@Controller("live")
export class OnDemandController {
  constructor(
    private readonly ondemand: OnDemandService,
    private readonly search: TickerSearchService,
    private readonly searchedTickers: SearchedTickersService,
  ) {}

  @Get("bars")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=60, stale-while-revalidate=120",
  )
  async bars(
    @Query("ticker") ticker: string | undefined,
    @Query("tf") tf: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    const frame = (tf ?? "").toUpperCase().trim();
    if (!this.ondemand.isValidTf(frame)) {
      throw new BadRequestException(`tf must be one of ${BARS_TFS.join(", ")}`);
    }
    const result = await this.ondemand.getBars(sym, frame);
    sendWithEtag(req, res, result);
  }

  @Get("company")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async company(
    @Query("ticker") ticker: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    const doc = await this.ondemand.getCompany(sym);
    if (!doc) throw new NotFoundException(`No data for ${sym}`);
    sendWithEtag(req, res, doc);
  }

  @Get("dividend-history")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async dividendHistory(
    @Query("ticker") ticker: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    const doc = await this.ondemand.getDividendHistory(sym);
    if (!doc) throw new NotFoundException(`No data for ${sym}`);
    sendWithEtag(req, res, doc);
  }

  @Get("splits")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async splits(
    @Query("ticker") ticker: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    const doc = await this.ondemand.getSplits(sym);
    if (!doc) throw new NotFoundException(`No data for ${sym}`);
    sendWithEtag(req, res, doc);
  }

  @Get("financials")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async financials(
    @Query("ticker") ticker: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    const doc = await this.ondemand.getFinancials(sym);
    if (!doc) throw new NotFoundException(`No data for ${sym}`);
    sendWithEtag(req, res, doc);
  }

  @Get("news")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async news(
    @Query("ticker") ticker: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    const articles = await this.ondemand.getNews(sym);
    sendWithEtag(req, res, articles);
  }

  @Get("options-chain")
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async optionsChain(
    @Query("ticker") ticker: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    if (!OPTIONS_UNIVERSE.includes(sym)) {
      throw new BadRequestException(
        `Options data is only available for: ${OPTIONS_UNIVERSE.join(", ")}`,
      );
    }
    const doc = await this.ondemand.getOptionsChain(sym);
    if (!doc) throw new NotFoundException(`No data for ${sym}`);
    sendWithEtag(req, res, doc);
  }

  @Get("search")
  @Header("Cache-Control", "public, max-age=3600, s-maxage=3600")
  async find(
    @Query("q") q: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const query = (q ?? "").trim();
    if (!query) throw new BadRequestException("q is required");
    if (query.length > 40) throw new BadRequestException("q too long");
    const results = await this.search.search(query);
    sendWithEtag(req, res, { q: query, results });
  }

  @Post("searched-ticker")
  async recordSearchedTicker(@Body("ticker") ticker: string | undefined) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    await this.searchedTickers.record(sym);
    return { ok: true };
  }

  @Get("most-searched-tickers")
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=60, stale-while-revalidate=120",
  )
  async mostSearchedTickers(
    @Query("limit") limit: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const n = Math.min(Math.max(parseInt(limit ?? "10", 10) || 10, 1), 50);
    const results = await this.searchedTickers.mostSearched(n);
    sendWithEtag(req, res, { results });
  }

  /** Cache/coalescing observability, like /live/stats for the snapshot path. */
  @Get("ondemand-stats")
  @Header("Cache-Control", "no-store")
  stats() {
    return { ...this.ondemand.stats, search: this.search.stats };
  }
}
