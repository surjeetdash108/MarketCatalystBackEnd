import { Module } from "@nestjs/common";
import { BlogsAdminController } from "./blogs-admin.controller";
import { BlogsAdminService } from "./blogs-admin.service";

/**
 * Admin blog CRUD over the public `blogs` collection. FirebaseAdminService and
 * AdminGuard come from the @Global CommonModule, so nothing extra to import.
 */
@Module({
  controllers: [BlogsAdminController],
  providers: [BlogsAdminService],
  // Exported for the daily recap job, which publishes through the same service
  // the console does rather than writing `blogs` and Storage by hand — slug
  // allocation, ranking and the source-document upload all live in one place.
  exports: [BlogsAdminService],
})
export class BlogsModule {}
