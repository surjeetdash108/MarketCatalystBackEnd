import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../common/admin.guard';
import { ApiHealthService } from './api-health.service';

/**
 * Admin API-health surface. Behind AdminGuard, so only the admin (with a
 * verified Firebase token, since the public live service runs
 * ADMIN_GUARD_TRUST_IAM=false) can enumerate and probe the API.
 */
@UseGuards(AdminGuard)
@Controller('admin')
export class ApiHealthController {
  constructor(private readonly health: ApiHealthService) {}

  // Path is 'apihealth' (no hyphen), NOT 'api-health': the hyphenated path was
  // poisoned in Firebase Hosting's edge cache with SPA HTML before its rewrite
  // existed, and there is no CLI purge — a fresh path sidesteps the stale cache.
  @Get('apihealth')
  async apiHealth() {
    return this.health.check();
  }
}
