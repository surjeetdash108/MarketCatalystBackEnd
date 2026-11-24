import { Module } from "@nestjs/common";
import { BlogsModule } from "../blogs/blogs.module";
import { PulseModule } from "../pulse/pulse.module";
import { BlogWriterService } from "./blog-writer.service";
import {
  ContentPipelineAdminController,
  LiveFeedController,
} from "./content-pipeline.controller";
import { ContentPipelineService } from "./content-pipeline.service";
import { ContentQueueService } from "./content-queue.service";

/** Content pipeline (Blog / Pulse / Live Feed). FirebaseAdminService and the guards come from the @Global CommonModule. */
@Module({
  imports: [BlogsModule, PulseModule],
  controllers: [ContentPipelineAdminController, LiveFeedController],
  providers: [ContentPipelineService, BlogWriterService, ContentQueueService],
  exports: [ContentPipelineService],
})
export class ContentPipelineModule {}
