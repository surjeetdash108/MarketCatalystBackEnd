import { BadRequestException, Body, Controller, Get, Header, Param, Post, UseGuards } from '@nestjs/common';
import { FeatureFlagsService } from './feature-flags.service';
import { FEATURE_FLAG_KEYS } from './feature-flags.registry';

/**
 * Feature-flag API.
 *
 * GET  /feature-flags        resolved flags (public; the UI reads this OR the
 *                            Firestore doc directly for live updates)
 * GET  /feature-flags/map    flat { FF_X: true } map
 * POST /feature-flags/seed   create/backfill the Firestore doc from defaults
 * POST /feature-flags/:key   { "value": true | false | null } runtime toggle
 *
 * Toggles are unauthenticated here because the whole service sits behind Cloud
 * Run IAM (--no-allow-unauthenticated). If ever exposed publicly, gate the
 * mutating routes behind an admin check first.
 */
import { AdminGuard } from '../common/admin.guard';

@Controller('feature-flags')
@UseGuards(AdminGuard)
export class FeatureFlagsController {
  constructor(private readonly flags: FeatureFlagsService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=5, s-maxage=15')
  async all() {
    return { flags: await this.flags.getAll() };
  }

  @Get('map')
  @Header('Cache-Control', 'public, max-age=5, s-maxage=15')
  async map() {
    return await this.flags.getMap();
  }

  @Post('seed')
  async seed() {
    return await this.flags.seed();
  }

  @Post(':key')
  async set(
    @Param('key') key: string,
    @Body() body: { value?: boolean | null },
  ) {
    if (!FEATURE_FLAG_KEYS.has(key)) {
      throw new BadRequestException(`unknown flag: ${key}`);
    }
    const value = body?.value ?? null;
    if (value !== null && typeof value !== 'boolean') {
      throw new BadRequestException('value must be true, false, or null');
    }
    await this.flags.setOverride(key, value);
    return { key, value, ok: true };
  }
}
