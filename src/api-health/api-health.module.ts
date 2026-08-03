import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ApiHealthController } from './api-health.controller';
import { ApiHealthService } from './api-health.service';

/**
 * DiscoveryModule gives ApiHealthService the DiscoveryService + MetadataScanner
 * it uses to enumerate registered routes. Mounted in both roles so the admin
 * console (served by the public live service) can reach GET /admin/api-health.
 */
@Module({
  imports: [DiscoveryModule],
  controllers: [ApiHealthController],
  providers: [ApiHealthService],
})
export class ApiHealthModule {}
