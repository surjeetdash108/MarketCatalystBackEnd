import { Module } from "@nestjs/common";
import {
  FeedbackAdminController,
  FeedbackController,
} from "./feedback.controller";
import { FeedbackService } from "./feedback.service";

/** In-app user feedback. FirebaseAdminService and the guards come from the @Global CommonModule. */
@Module({
  controllers: [FeedbackController, FeedbackAdminController],
  providers: [FeedbackService],
})
export class FeedbackModule {}
