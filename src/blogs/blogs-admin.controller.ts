import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { AdminGuard } from "../common/admin.guard";
import { BlogsAdminService } from "./blogs-admin.service";
import type { BlogAdminBody } from "./blogs-admin.service";

/**
 * Admin CRUD for the public `blogs` collection, behind AdminGuard (verified
 * Firebase admin token, or Cloud-Run-IAM-vetted request — see AdminGuard).
 * Mirrors ApiHealthController's `@Controller("api/admin")` shape. The console's
 * blog board drives these; every write lands in the same collection the public
 * site (marketcatalyst.ai/posts) renders from.
 */
@UseGuards(AdminGuard)
@Controller("api/admin")
export class BlogsAdminController {
  constructor(private readonly blogs: BlogsAdminService) {}

  @Get("blogs")
  async list() {
    return { blogs: await this.blogs.list() };
  }

  @Post("blogs")
  async create(@Body() body: BlogAdminBody) {
    return this.blogs.create(body ?? {});
  }

  @Patch("blogs/:id")
  async update(@Param("id") id: string, @Body() body: BlogAdminBody) {
    return this.blogs.update(id, body ?? {});
  }

  @Delete("blogs/:id")
  async remove(@Param("id") id: string) {
    return this.blogs.remove(id);
  }
}
