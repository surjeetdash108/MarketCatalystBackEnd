import { Module } from "@nestjs/common";
import { PlansModule } from "../plans/plans.module";
import { EmailLifecycleService } from "./email-lifecycle.service";
import { EmailPublicController } from "./email-public.controller";

/** Account and lifecycle emails, one-click links, password reset. */
@Module({
  imports: [PlansModule],
  controllers: [EmailPublicController],
  providers: [EmailLifecycleService],
  exports: [EmailLifecycleService],
})
export class EmailLifecycleModule {}
