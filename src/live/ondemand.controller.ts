import { BadRequestException, Controller, Get, Header, NotFoundException, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash } from 'crypto';
import { OnDemandService, BarsTf, BARS_TFS } from './ondemand.service';
import { TickerSearchService } from './ticker-search.service';

/**
 * On-demand data endpoints (see ondemand.service.ts for the caching design).
 *
 *   GET /live/bars?ticker=AAPL&tf=1Y   → bars, cache-aside via stock_bars
 *   GET /live/company?ticker=AAPL      → profile+price, cache-aside via companies
 *   GET /live/search?q=apple           → in-memory universe search (no Firestore)
 *
 * Responses carry Cache-Control + ETag so each BROWSER also caches: a repeat
 * view inside the max-age costs zero requests, and a 304 costs no body.
 */

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

function etagFor(obj: unknown): string {
  return `"${createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 20)}"`;
}

function sendWithEtag(req: Request, res: Response, body: unknown): void {
  const tag = etagFor(body);
  res.setHeader('ETag', tag);
  if (req.headers['if-none-match'] === tag) {
    res.status(304).end();
    return;
  }
  res.json(body);
}

@Controller('live')
export class OnDemandController {
  constructor(
    private readonly ondemand: OnDemandService,
    private readonly search: TickerSearchService,
  ) {}

  @Get('bars')
  @Header('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=120')
  async bars(
    @Query('ticker') ticker: string | undefined,
    @Query('tf') tf: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? '').toUpperCase().trim();
    if (!TICKER_RE.test(sym)) throw new BadRequestException('ticker must be 1-10 chars, A-Z0-9.-');
    const frame = (tf ?? '').toUpperCase().trim();
    if (!this.ondemand.isValidTf(frame)) {
      throw new BadRequestException(`tf must be one of ${BARS_TFS.join(', ')}`);
    }
    const result = await this.ondemand.getBars(sym, frame as BarsTf);
    sendWithEtag(req, res, result);
  }

  @Get('company')
  @Header('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=600')
  async company(
    @Query('ticker') ticker: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sym = (ticker ?? '').toUpperCase().trim();
    if (!TICKER_RE.test(sym)) throw new BadRequestException('ticker must be 1-10 chars, A-Z0-9.-');
    const doc = await this.ondemand.getCompany(sym);
    if (!doc) throw new NotFoundException(`No data for ${sym}`);
    sendWithEtag(req, res, doc);
  }

  @Get('search')
  @Header('Cache-Control', 'public, max-age=3600, s-maxage=3600')
  async find(
    @Query('q') q: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const query = (q ?? '').trim();
    if (!query) throw new BadRequestException('q is required');
    if (query.length > 40) throw new BadRequestException('q too long');
    const results = await this.search.search(query);
    sendWithEtag(req, res, { q: query, results });
  }

  /** Cache/coalescing observability, like /live/stats for the snapshot path. */
  @Get('ondemand-stats')
  @Header('Cache-Control', 'no-store')
  stats() {
    return { ...this.ondemand.stats, search: this.search.stats };
  }
}
