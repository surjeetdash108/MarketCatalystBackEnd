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
})
export class BlogsModule {}
