import { Module } from "@nestjs/common";
import { AccountController } from "./account.controller";
import { AdminStaffController } from "./admin-staff.controller";

@Module({ controllers: [AccountController, AdminStaffController] })
export class AccountModule {}
