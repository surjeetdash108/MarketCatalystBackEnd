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

  @Get('api-health')
  async apiHealth() {
    return this.health.check();
  }
}
