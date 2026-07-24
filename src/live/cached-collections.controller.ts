import { BadRequestException, Controller, Get, Header, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CachedCollectionsService } from './cached-collections.service';

/**
 * GET /live/collections?names=companies,market_indices,…
 *
 * Serves the SHARED, slow-changing Firestore collections from one server-side
 * cache so per-user Firestore reads collapse to per-instance reads. Same
 * caching contract as /live/snapshot: browser + edge cache + ETag → 304.
 */
const NAME_RE = /^[a-z_]{1,40}$/;
const MAX_NAMES = 24;

@Controller('live')
export class CachedCollectionsController {
  constructor(private readonly cached: CachedCollectionsService) {}

  @Get('collections')
  @Header('Cache-Control', 'public, max-age=120, s-maxage=300, stale-while-revalidate=600')
  async collections(
    @Query('names') names: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const list = (names ?? '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);

    if (list.length === 0) throw new BadRequestException('names is required');
    if (list.length > MAX_NAMES) {
      throw new BadRequestException(`at most ${MAX_NAMES} collections per request`);
    }
    const bad = list.find((n) => !NAME_RE.test(n) || !this.cached.isAllowed(n));
    if (bad) throw new BadRequestException(`collection not cacheable: ${bad}`);

    const data = await this.cached.get(list);
    const etag = this.cached.etagFor(data);

    if (req.headers['if-none-match'] === etag) {
      res.status(304).setHeader('ETag', etag).end();
      return;
    }
    res.setHeader('ETag', etag);
    res.json(data);
  }
}
