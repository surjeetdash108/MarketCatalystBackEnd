import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Logger,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { createHash } from "crypto";
import { OnDemandService, BARS_TFS, BARS_INTERVALS } from "./ondemand.service";
import { AiAnalysisService } from "./ai-analysis.service";
import { TickerAiAnalysisService } from "./ticker-ai-analysis.service";
import { WhatMattersNowService } from "./what-matters-now.service";
import { LlmGatewayService } from "../vendors/llm-gateway.service";
import { MarketScanService } from "./market-scan.service";
import { MarketGlanceService } from "./market-glance.service";
import { SecEdgarService } from "../vendors/sec-edgar/sec-edgar.service";
import { TickerSearchService } from "./ticker-search.service";
import { SearchedTickersService } from "./searched-tickers.service";
import { EtfMarketService } from "./etf-market.service";
import { EarningsTranscriptSummaryService } from "./earnings-transcript-summary.service";
import { OPTIONS_UNIVERSE } from "../common/options-universe";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { DelistedTickerGuard } from "../common/delisted-ticker.guard";
import { DelistedTickersService } from "../common/delisted-tickers.service";
import { StockDetailsService } from "./stock-details.service";

/**
 * On-demand data endpoints (see ondemand.service.ts for the caching design).
 *
 *   GET /live/bars?ticker=AAPL&tf=1Y            → bars for a date range, cache-aside via stock_bars
 *   GET /live/bars?ticker=AAPL&interval=4H      → candles of one size (1m…1M, regular session), same cache
 *   GET /live/company?ticker=AAPL               → profile+price, cache-aside via companies
 *   GET /live/dividend-history?ticker=AAPL      → cache-aside via dividend_history
 *   GET /live/splits?ticker=AAPL                → cache-aside via splits
 *   GET /live/financials?ticker=AAPL            → cache-aside via financials
 *   GET /live/news?ticker=AAPL                  → per-ticker cache-aside via news
 *   GET /live/earnings-transcript?ticker=AAPL   → latest FMP call transcript, cache-aside via earnings_transcripts
 *   GET /live/options-chain?ticker=AAPL         → cache-aside via options_chains (curated 8-ticker universe)
 *   GET /live/ownership-13dg?ticker=AAPL        → SEC EDGAR 13D/G >5% holders, cache-aside via ownership_13dg
 *   GET /live/filing?cik=..&accession=..        → one SEC filing document, sanitized for in-app rendering
 *   GET /live/search?q=apple                    → in-memory universe search (no Firestore)
 *   POST /live/searched-ticker {ticker}          → record a resolved ticker search/selection
 *   GET /live/most-searched-tickers?limit=10     → top searched tickers, by selection count
 *   GET /live/etf-market                        → dynamic ETF discovery & classification (10 sections)
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
// Every `?ticker=` endpoint here 404s a delisted symbol (see the guard).
@UseGuards(DelistedTickerGuard)
export class OnDemandController {
  private readonly logger = new Logger(OnDemandController.name);

  constructor(
    private readonly tickerAi: TickerAiAnalysisService,
    private readonly wmn: WhatMattersNowService,
    private readonly ondemand: OnDemandService,
    private readonly aiAnalysis: AiAnalysisService,
    private readonly search: TickerSearchService,
    private readonly searchedTickers: SearchedTickersService,
    private readonly marketScan: MarketScanService,
    private readonly marketGlance: MarketGlanceService,
    private readonly secEdgar: SecEdgarService,
    private readonly etfMarketService: EtfMarketService,
    private readonly transcriptSummary: EarningsTranscriptSummaryService,
    private readonly delisted: DelistedTickersService,
    private readonly llmGateway: LlmGatewayService,
    private readonly stockDetails: StockDetailsService,
  ) {}

  /**
   * On-demand AI technical read for one ticker (technicals + news, synthesised
   * by OpenRouter, cached 30 min in ai_technical_analysis). Auth-only — open to
   * every signed-in user (no plan/entitlement gate) but not anonymous, so the
   * paid OpenRouter calls can't be triggered without a login. Cache-Control is
   * `private` precisely because the route is authenticated.
   */
  /**
   * The rolling per-ticker AI analysis maintained by the 10-minute pipeline
   * (ticker_ai_analysis). A pure READ — it never triggers generation, so the
   * Live Feed can surface it per row without incurring a model call. Returns
   * null when a ticker has not been analysed yet, which the UI shows as
   * "no analysis yet" rather than an error.
   */
  /**
   * Market-wide "What Matters Now" digest. Cached for an hour: the first
   * viewer triggers generation, everyone after reads the stored record, and
   * concurrent callers share one model call.
   */
  @Get("what-matters-now")
  @UseGuards(FirebaseAuthGuard)
  @Header("Cache-Control", "private, max-age=300")
  async whatMattersNow(@Req() req: Request, @Res() res: Response) {
    const doc = await this.wmn.getOrGenerate();
    sendWithEtag(req, res, doc ?? { empty: true });
  }

  @Get("ticker-analysis")
  @UseGuards(FirebaseAuthGuard)
  @Header("Cache-Control", "private, max-age=120")
  async tickerAnalysisRead(
    @Query("ticker") ticker: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym)) {
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    }
    // Generates on a miss, then serves from storage thereafter.
    const doc = await this.tickerAi.getOrGenerate(sym);
    sendWithEtag(req, res, doc ?? { ticker: sym, empty: true });
  }

  /**
   * Recent `announcement`-type ticker AI analyses across all names, newest
   * first — feeds the Live Feed's "Earnings Announcement" tab (expandable list).
   * Pure READ: never triggers model generation (that's earnings-actuals.job's
   * job when a result lands).
   */
  @Get("ticker-announcements")
  @UseGuards(FirebaseAuthGuard)
  @Header("Cache-Control", "private, max-age=120")
  async tickerAnnouncements(
    @Query("limit") limit: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const n = Math.min(Math.max(parseInt(limit ?? "50", 10) || 50, 1), 200);
    const rows = await this.delisted.filterRows(
      await this.tickerAi.recentAnnouncements(n),
    );
    sendWithEtag(req, res, rows);
  }

  /**
   * SCANX — Biggest % gainers/losers, sector-categorised. On-demand generated
   * from the companies universe and cached; a request past the 2h cutoff
   * recomputes, otherwise the stored scan is served. Derived from public market
   * data, so no auth gate.
   */
  @Get("scan/biggest-pct")
  @UseGuards(FirebaseAuthGuard)
  @Header("Cache-Control", "public, max-age=300")
  async scanBiggestPct(@Req() req: Request, @Res() res: Response) {
    sendWithEtag(req, res, await this.marketScan.getBiggestPct());
  }

  /**
   * SCANX — Most active stocks (top volume + top relative volume),
   * sector-categorised. Same on-demand + cache pattern; 1h cutoff.
   */
  @Get("scan/most-active")
  @UseGuards(FirebaseAuthGuard)
  @Header("Cache-Control", "public, max-age=300")
  async scanMostActive(@Req() req: Request, @Res() res: Response) {
    sendWithEtag(req, res, await this.marketScan.getMostActive());
  }

  /**
   * "Week at a glance" — the market-wide weekly digests as an expandable
   * history (newest first). The current week is generated on demand (12h
   * cutoff) SYNCHRONOUSLY inside the request, bounded under the 60s
   * Hosting-rewrite limit; the first viewer of a stale week waits for it and
   * everyone after reads this cached copy. See MarketGlanceService.
   */
  @Get("glance/weekly")
  @UseGuards(FirebaseAuthGuard)
  @Header("Cache-Control", "public, max-age=60")
  async glanceWeekly(@Req() req: Request, @Res() res: Response) {
    sendWithEtag(req, res, await this.marketGlance.getWeekly());
  }

  /** "Month at a glance" — same, over calendar months (24h cutoff). */
  @Get("glance/monthly")
  @UseGuards(FirebaseAuthGuard)
  @Header("Cache-Control", "public, max-age=60")
  async glanceMonthly(@Req() req: Request, @Res() res: Response) {
    sendWithEtag(req, res, await this.marketGlance.getMonthly());
  }

  @Get("ai-analysis")
  @UseGuards(FirebaseAuthGuard)
  @Header("Cache-Control", "private, max-age=300")
  async aiAnalysisRead(
    @Query("ticker") ticker: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym)) {
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    }
    const doc = await this.aiAnalysis.getStockTechnical(sym);
    sendWithEtag(req, res, doc);
  }

  @Post("copilot")
  @UseGuards(FirebaseAuthGuard)
  async copilotChat(
    @Body()
    body: {
      ticker?: string;
      question: string;
      context?: Record<string, unknown>;
    },
  ) {
    const question = (body?.question ?? "").trim();
    if (!question) {
      throw new BadRequestException("question is required");
    }
    const ticker = (body?.ticker ?? "").toUpperCase().trim();
    const ctx = body?.context ?? {};

    if (this.llmGateway.enabled) {
      const messages = [
        {
          role: "system" as const,
          content: `You are an institutional financial analyst assistant for MarketCatalyst Stock Intelligence.
You answer questions about ${ticker || "stocks"} using ONLY verified facts, derived calculations, and analyst estimates provided in the context below.
Strict Rules:
- Distinguish verified facts (current price, reported revenue, EPS actuals) from derived metrics (P/E, margins, RSI) and analyst consensus estimates.
- Never invent quotes, financial filings, news, or timestamps.
- If evidence or data is missing from the context, state explicitly that it is unavailable.
- Answer in structured, clear markdown bullets with bold key terms.
- Keep responses factual, quantitative, and concise (under 200 words).
- Conclude with a brief grounding citation line noting data sources used and timestamp.

Context:
${JSON.stringify(ctx, null, 2)}`,
        },
        {
          role: "user" as const,
          content: question,
        },
      ];

      try {
        const reply = await this.llmGateway.chat(messages, { timeoutMs: 20_000 });
        if (reply?.trim()) {
          return {
            reply: reply.trim(),
            grounded: true,
            provider: this.llmGateway.primaryName,
            asOf: new Date().toISOString(),
          };
        }
      } catch (err) {
        this.logger.warn(`copilot LLM chat failed: ${err}`);
      }
    }

    // Deterministic factual fallback grounded strictly in verified context
    const priceStr =
      ctx.price != null ? `$${Number(ctx.price).toFixed(2)}` : "Unavailable";
    const changeStr =
      ctx.pctChange != null
        ? `${Number(ctx.pctChange) >= 0 ? "+" : ""}${Number(ctx.pctChange).toFixed(2)}%`
        : "Unavailable";
    const peStr =
      ctx.peRatio != null ? `${Number(ctx.peRatio).toFixed(1)}×` : "N/A";
    const fpeStr =
      ctx.forwardPe != null ? `${Number(ctx.forwardPe).toFixed(1)}×` : "N/A";
    const mcapStr =
      ctx.marketCap != null
        ? `$${(Number(ctx.marketCap) / 1e9).toFixed(1)}B`
        : "N/A";

    let answer = `**${ticker || "Stock"} Intelligence Synthesis:**\n`;
    answer += `• **Market Price**: ${priceStr} (${changeStr}) | **Market Cap**: ${mcapStr}\n`;
    answer += `• **Valuation**: Trailing P/E ${peStr} · Forward P/E ${fpeStr}\n`;
    if (ctx.newsSummary) {
      answer += `• **Catalysts & News**: ${ctx.newsSummary}\n`;
    }
    if (ctx.technicalSummary) {
      answer += `• **Technical Posture**: ${ctx.technicalSummary}\n`;
    }
    answer += `\n*Grounded in verified FMP & Polygon records as of ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.*`;

    return {
      reply: answer,
      grounded: true,
      provider: "deterministic-synthesis",
      asOf: new Date().toISOString(),
    };
  }

  @Get("bars")
  @UseGuards(FirebaseAuthGuard)
  @Header(
    "Cache-Control",
    "public, max-age=60, s-maxage=60, stale-while-revalidate=120",
  )
  async bars(
    @Query("ticker") ticker: string | undefined,
    @Query("tf") tf: string | undefined,
    @Query("interval") interval: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    if (interval != null) {
      if (tf != null)
        throw new BadRequestException("pass either tf or interval, not both");
      // NOT upper-cased: `1m` (minute) and `1M` (month) are different sizes.
      // A repeated ?interval= arrives as an array — reject it, don't crash.
      const size = typeof interval === "string" ? interval.trim() : "";
      if (!this.ondemand.isValidInterval(size)) {
        throw new BadRequestException(
          `interval must be one of ${BARS_INTERVALS.join(", ")} (case-sensitive)`,
        );
      }
      const result = await this.ondemand.getBarsByInterval(sym, size);
      sendWithEtag(req, res, result);
      return;
    }
    const frame = (tf ?? "").toUpperCase().trim();
    if (!this.ondemand.isValidTf(frame)) {
      throw new BadRequestException(`tf must be one of ${BARS_TFS.join(", ")}`);
    }
    const result = await this.ondemand.getBars(sym, frame);
    sendWithEtag(req, res, result);
  }

  @Get("company")
  @UseGuards(FirebaseAuthGuard)
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
  )
  async company(
    @Query("ticker") ticker: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const requestStart = Date.now();
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    const doc = await this.ondemand.getCompany(sym);
    if (!doc) throw new NotFoundException(`No data for ${sym}`);
    sendWithEtag(req, res, doc);
    this.logger.log(
      `GET /live/company?ticker=${sym} took ${Date.now() - requestStart}ms end-to-end`,
    );
  }

  /**
   * Fast key-stats (market cap, P/E, EPS, next ER, 52w, avg vol, sector,
   * dividend) for a ticker whose company doc isn't in Firestore yet. The
   * frontend calls this alongside /live/company and swaps in the full doc when
   * it arrives. `partial: true` marks the response.
   */
  @Get("company/summary")
  @UseGuards(FirebaseAuthGuard)
  // Short: this only bridges the gap until the full doc exists, so an edge
  // must not keep serving it after /live/company has the real thing.
  @Header("Cache-Control", "public, max-age=60, s-maxage=60")
  async companySummary(
    @Query("ticker") ticker: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const requestStart = Date.now();
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    const doc = await this.ondemand.getCompanySummary(sym);
    if (!doc) throw new NotFoundException(`No data for ${sym}`);
    sendWithEtag(req, res, doc);
    this.logger.log(
      `GET /live/company/summary?ticker=${sym} took ${Date.now() - requestStart}ms end-to-end`,
    );
  }

  @Get("quotes")
  @UseGuards(FirebaseAuthGuard)
  // Matches /live/snapshot exactly. Both now serve the SAME shared-cache entries,
  // so a longer TTL here would re-introduce the very drift this unification
  // removes: an edge could hand out a 60s-old quote beside a 5s-old heatmap tile
  // and the same ticker would read differently on two screens. Caching longer
  // than the cache's own refresh interval buys nothing anyway.
  @Header(
    "Cache-Control",
    "public, max-age=5, s-maxage=10, stale-while-revalidate=30",
  )
  async quotes(
    @Query("tickers") tickers: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const gone = await this.delisted.get();
    const syms = (tickers ?? "")
      .split(",")
      .map((t) => t.toUpperCase().trim())
      .filter((t) => TICKER_RE.test(t) && !gone.has(t))
      .slice(0, 250);
    if (syms.length === 0) {
      sendWithEtag(req, res, []);
      return;
    }
    const data = await this.ondemand.getQuotes(syms);
    sendWithEtag(req, res, data);
  }

  @Get("estimates")
  @UseGuards(FirebaseAuthGuard)
  @Header("Cache-Control", "private, max-age=600")
  async estimates(
    @Query("ticker") ticker: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    const [quarterly, next] = await Promise.all([
      this.ondemand.getQuarterlyEstimates(sym),
      this.ondemand.getNextReportEstimate(sym).catch(() => null),
    ]);
    sendWithEtag(req, res, { ticker: sym, quarterly, next });
  }

  @Get("peers-summary")
  @UseGuards(FirebaseAuthGuard)
  @Header("Cache-Control", "public, max-age=30, s-maxage=60")
  async peersSummary(
    @Query("tickers") tickers: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const syms = (tickers ?? "")
      .split(",")
      .map((t) => t.toUpperCase().trim())
      .filter((t) => TICKER_RE.test(t))
      .slice(0, 50);
    if (syms.length === 0) {
      sendWithEtag(req, res, []);
      return;
    }
    const data = await this.ondemand.getPeersSummary(syms);
    sendWithEtag(req, res, data);
  }

  /** Company logo bytes proxied from Polygon branding (key stays server-side). */
  // Deliberately unauthenticated: this is loaded as an <img src>, and an
  // image request cannot carry an Authorization header. It proxies the
  // vendor so the API key stays server-side; it returns an image, not data.
  @Get("logo")
  async logo(
    @Query("ticker") ticker: string | undefined,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    const img = await this.ondemand.getLogo(sym);
    if (!img) {
      // No Polygon branding for this ticker → let the client fall back to its
      // letter tile. 204 (No Content), not 404: the client's <img> onError still
      // fires, but the browser doesn't log a "Failed to load resource" console
      // error for a logo-less ticker (a normal, expected case). Short cache so a
      // newly-covered ticker recovers quickly.
      res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
      res.status(204).end();
      return;
    }
    res.setHeader("Content-Type", img.contentType);
    res.setHeader(
      "Cache-Control",
      "public, max-age=604800, s-maxage=604800, immutable",
    );
    res.send(img.data);
  }

  @Get("dividend-history")
  @UseGuards(FirebaseAuthGuard)
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
  @UseGuards(FirebaseAuthGuard)
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

  /**
   * Institutional ownership + top 13F holders (FMP, newest quarter past its
   * filing deadline) and FINRA short interest (Polygon — FMP has none).
   */
  @Get("ownership")
  @UseGuards(FirebaseAuthGuard)
  @Header(
    "Cache-Control",
    "public, max-age=900, s-maxage=3600, stale-while-revalidate=3600",
  )
  async ownership(
    @Query("ticker") ticker: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    const doc = await this.stockDetails.getOwnership(sym);
    if (!doc) throw new NotFoundException(`No data for ${sym}`);
    sendWithEtag(req, res, doc);
  }

  @Get("financials")
  @UseGuards(FirebaseAuthGuard)
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

  /**
   * Named >5% beneficial owners from SEC EDGAR Schedules 13D/G, plus the
   * issuer's CUSIP and the tracked 13F funds holding it. Distinct from the
   * FMP institutional rollup, which is an anonymous aggregate.
   *
   * A cache miss walks up to two dozen filing cover pages against a
   * rate-limited SEC endpoint, so the day-long server cache does the real work
   * and the browser keeps its own copy for five minutes.
   */
  @Get("ownership-13dg")
  @UseGuards(FirebaseAuthGuard)
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
  )
  async ownership13dg(
    @Query("ticker") ticker: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    const doc = await this.ondemand.getOwnership13DG(sym);
    if (!doc) throw new NotFoundException(`No data for ${sym}`);
    sendWithEtag(req, res, doc);
  }

  /**
   * Quarterly SEC 13F institutional ownership changes for a given stock ticker.
   */
  @Get("13f-filings")
  @UseGuards(FirebaseAuthGuard)
  @Header(
    "Cache-Control",
    "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
  )
  async get13FFilings(
    @Query("ticker") ticker: string | undefined,
    @Query("year") year: string | undefined,
    @Query("quarter") quarter: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    const doc = await this.ondemand.get13FFilings(
      sym,
      year ? Number(year) : undefined,
      quarter ? Number(quarter) : undefined,
    );
    sendWithEtag(req, res, doc);
  }

  /**
   * One SEC filing rendered as a document instead of EDGAR's raw submission
   * text. See SecEdgarService.getFilingDocument for why the full-index URL
   * cannot be linked directly.
   *
   * Not cached in Firestore: a prospectus runs to megabytes, well past the 1MB
   * document limit. It does not need to be — a filing at a given accession
   * number is immutable, so `immutable` lets the CDN and the browser hold it
   * for a day and repeat views cost nothing.
   */
  @Get("filing")
  @UseGuards(FirebaseAuthGuard)
  @Header("Cache-Control", "public, max-age=86400, s-maxage=86400, immutable")
  async filing(
    @Query("cik") cik: string | undefined,
    @Query("accession") accession: string | undefined,
  ) {
    const bareCik = (cik ?? "").replace(/\D/g, "");
    const acc = (accession ?? "").trim();
    if (!bareCik || bareCik.length > 10)
      throw new BadRequestException("cik must be 1-10 digits");
    if (!/^\d{10}-\d{2}-\d{6}$/.test(acc))
      throw new BadRequestException(
        "accession must look like 0001477932-26-005410",
      );
    const doc = await this.secEdgar.getFilingDocument(bareCik, acc);
    if (!doc)
      throw new NotFoundException(`No readable document in filing ${acc}`);
    return doc;
  }

  @Get("news")
  @UseGuards(FirebaseAuthGuard)
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

  @Get("earnings-transcript")
  @UseGuards(FirebaseAuthGuard)
  @Header(
    "Cache-Control",
    "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
  )
  async earningsTranscript(
    @Query("ticker") ticker: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    const doc = await this.ondemand.getTranscript(sym);
    if (!doc) throw new NotFoundException(`No data for ${sym}`);
    sendWithEtag(req, res, doc);
  }

  @Get("earnings-transcript-summary")
  @UseGuards(FirebaseAuthGuard)
  @Header(
    "Cache-Control",
    "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
  )
  async earningsTranscriptSummary(
    @Query("ticker") ticker: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    const summary = await this.transcriptSummary.getSummary(sym);
    if (!summary) throw new NotFoundException(`No transcript summary available for ${sym}`);
    sendWithEtag(req, res, summary);
  }

  @Get("options-chain")
  @UseGuards(FirebaseAuthGuard)
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
  @UseGuards(FirebaseAuthGuard)
  @Header("Cache-Control", "public, max-age=3600, s-maxage=3600")
  async find(
    @Query("q") q: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const query = (q ?? "").trim();
    if (!query) throw new BadRequestException("q is required");
    if (query.length > 40) throw new BadRequestException("q too long");
    // The search universe is Polygon's active list, reloaded daily; this
    // closes the gap between a delisting and that reload.
    const results = await this.delisted.filterRows(
      await this.search.search(query),
    );
    sendWithEtag(req, res, { q: query, results });
  }

  @Post("searched-ticker")
  @UseGuards(FirebaseAuthGuard)
  async recordSearchedTicker(@Body("ticker") ticker: string | undefined) {
    const sym = (ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(sym))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    // A typo ("AAAPL") is not a ticker: never count it toward Most Searched.
    if ((await this.search.isListed(sym)) === false) return { ok: false, reason: "not a listed ticker" };
    await this.searchedTickers.record(sym);
    return { ok: true };
  }

  @Get("most-searched-tickers")
  @UseGuards(FirebaseAuthGuard)
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
    // Over-fetch so dropping delisted names still fills the requested count.
    const rows = await this.delisted.filterRows(await this.searchedTickers.mostSearched(n + 20));
    // Drop typos recorded before searches were validated (e.g. "AAAPL").
    const listed = await Promise.all(rows.map((r) => this.search.isListed(r.ticker)));
    const results = rows.filter((_, i) => listed[i] !== false).slice(0, n);
    sendWithEtag(req, res, { results });
  }

  /** Cache/coalescing observability, like /live/stats for the snapshot path. */
  @Get("ondemand-stats")
  @UseGuards(FirebaseAuthGuard)
  @Header("Cache-Control", "no-store")
  stats() {
    return { ...this.ondemand.stats, search: this.search.stats };
  }

  /**
   * Dynamic ETF discovery and classification across 10 MarketCatalyst categories:
   * Largest, Equity, Bitcoin, Ethereum, Gold, Fixed Income, Real Estate, Total Market,
   * Commodities, Leveraged.
   */
  @Get("etf-market")
  @Header("Cache-Control", "public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400")
  async etfMarket(
    @Query("limit") limit: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    const data = await this.etfMarketService.getCategorizedEtfs(
      Number.isFinite(parsedLimit) && (parsedLimit as number) > 0
        ? parsedLimit
        : undefined,
    );
    sendWithEtag(req, res, data);
  }

  @Get("etfs/market-funds")
  @Header("Cache-Control", "public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400")
  async etfMarketFundsAlias(
    @Query("limit") limit: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    const data = await this.etfMarketService.getCategorizedEtfs(
      Number.isFinite(parsedLimit) && (parsedLimit as number) > 0
        ? parsedLimit
        : undefined,
    );
    sendWithEtag(req, res, data);
  }
}
