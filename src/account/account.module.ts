import { Module } from "@nestjs/common";
import { EmailLifecycleModule } from "../email/email-lifecycle.module";
import { AccountDeletionService } from "./account-deletion.service";
import { AccountController } from "./account.controller";
import {
  AdminStaffController,
  AdminUsersController,
} from "./admin-staff.controller";

@Module({
  imports: [EmailLifecycleModule],
  controllers: [AccountController, AdminStaffController, AdminUsersController],
  providers: [AccountDeletionService],
})
export class AccountModule {}
