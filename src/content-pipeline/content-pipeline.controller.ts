import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  Patch,
  Delete,
} from "@nestjs/common";
import { AdminGuard } from "../common/admin.guard";
import { AllowEditor } from "../common/editor-access.decorator";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { ContentPipelineService } from "./content-pipeline.service";

/** Admin console → Content pipeline: submit, track, preview, approve, send back, retry. */
@AllowEditor()
@UseGuards(AdminGuard)
@Controller("api/admin/content")
export class ContentPipelineAdminController {
  constructor(private readonly pipeline: ContentPipelineService) {}

  @Post()
  async submit(
    @Body() body: unknown,
    @Req() req: { adminEmail?: string; adminActor?: string },
  ) {
    return this.pipeline.submit(
      body,
      req.adminActor ?? req.adminEmail ?? "admin",
    );
  }

  @Get()
  async list(@Query("limit") limit?: string) {
    return this.pipeline.list(limit ? Number(limit) || 200 : 200);
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return this.pipeline.get(id);
  }

  @Post(":id/approve")
  async approve(@Param("id") id: string) {
    return { item: await this.pipeline.approve(id) };
  }

  @Post(":id/send-back")
  async sendBack(@Param("id") id: string, @Body() body: { note?: unknown }) {
    return { item: await this.pipeline.sendBack(id, body?.note) };
  }

  @Patch(":id")
  async edit(@Param("id") id: string, @Body() body: unknown) {
    return this.pipeline.edit(id, body);
  }

  @Delete(":id")
  async remove(@Param("id") id: string) {
    return this.pipeline.remove(id);
  }

  @Post(":id/retry")
  async retry(@Param("id") id: string) {
    return { item: await this.pipeline.retry(id) };
  }
}

/** Live Feed → Intraday commentary: MarketCatalyst's own posts, newest first. */
@UseGuards(FirebaseAuthGuard)
@Controller("api")
export class LiveFeedController {
  constructor(private readonly pipeline: ContentPipelineService) {}

  @Get("live-feed")
  async list(@Query("limit") limit?: string) {
    return this.pipeline.liveFeed(limit ? Number(limit) || 50 : 50);
  }
}
