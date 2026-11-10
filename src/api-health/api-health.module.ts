import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { ApiHealthController } from "./api-health.controller";
import { ApiHealthService } from "./api-health.service";
import { JobsAdminService } from "./jobs-admin.service";
import { ScreenApiService } from "./screen-api.service";

/**
 * DiscoveryModule gives ApiHealthService the DiscoveryService + MetadataScanner
 * it uses to enumerate registered routes. Mounted in both roles so the admin
 * console (served by the public live service) can reach GET /admin/api-health.
 *
 * It also carries the admin Jobs tab (JobsAdminService: inventory and "run
 * now") and the API Docs tab (ScreenApiService). They live here, not in
 * SyncModule, because the console is served by the live role, which does not
 * load SyncModule.
 */
@Module({
  imports: [DiscoveryModule],
  controllers: [ApiHealthController],
  providers: [ApiHealthService, JobsAdminService, ScreenApiService],
})
export class ApiHealthModule {}
