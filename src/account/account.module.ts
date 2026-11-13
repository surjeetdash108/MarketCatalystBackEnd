import { Module } from "@nestjs/common";
import { AccountDeletionService } from "./account-deletion.service";
import { AccountController } from "./account.controller";
import { AdminStaffController, AdminUsersController } from "./admin-staff.controller";

@Module({
  controllers: [AccountController, AdminStaffController, AdminUsersController],
  providers: [AccountDeletionService],
})
export class AccountModule {}
