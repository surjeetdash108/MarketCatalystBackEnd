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
import { MediaAdminService } from "./media-admin.service";

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
  constructor(
    private readonly blogs: BlogsAdminService,
    private readonly media: MediaAdminService,
  ) {}

  @Get("blogs")
  async list() {
    return { blogs: await this.blogs.list() };
  }

  /**
   * The shared blog design on its own.
   *
   * Declared BEFORE any parameterised `blogs/:x` route so "theme" is not
   * swallowed as an id. Every html row already carries this, so the console
   * needs it separately only for the editor's Design row — which otherwise can
   * describe a freshly loaded file and nothing else.
   */
  @Get("blogs/theme")
  async theme() {
    return this.blogs.theme();
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

  /* ── image library ──────────────────────────────────────────────────────
     Writes the same `media` collection the Website's admin uses, so one
     gallery serves both consoles. */

  @Get("media")
  async listMedia() {
    return { media: await this.media.list() };
  }

  @Post("media")
  async uploadMedia(@Body() body: { dataUri?: string; filename?: string }) {
    return this.media.upload(String(body?.dataUri ?? ""), String(body?.filename ?? "upload"));
  }

  @Delete("media/:id")
  async removeMedia(@Param("id") id: string) {
    return this.media.remove(id);
  }
}
