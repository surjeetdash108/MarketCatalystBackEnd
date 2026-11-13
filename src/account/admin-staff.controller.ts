import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { IsEmail } from "class-validator";
import { AdminGuard } from "../common/admin.guard";
import { AccountDeletionService } from "./account-deletion.service";
import { StaffAccessService } from "./staff-access.service";

export class StaffEmailDto {
  @IsEmail()
  email!: string;
}

/** Admin console: the staff allowlist (config/staff_access). Writes are audited by AdminAuditInterceptor. */
@Controller("api/admin/staff-access")
@UseGuards(AdminGuard)
export class AdminStaffController {
  constructor(private readonly staff: StaffAccessService) {}

  @Get()
  async list() {
    return { emails: await this.staff.list() };
  }

  @Post()
  async add(@Body() body: StaffEmailDto) {
    return { emails: await this.staff.add(body.email) };
  }

  @Delete(":email")
  async remove(@Param("email") email: string) {
    return { emails: await this.staff.remove(email) };
  }
}

/** Admin console: delete a user everywhere (sign-in, data, live subscription). Audited by AdminAuditInterceptor. */
@Controller("api/admin/users")
@UseGuards(AdminGuard)
export class AdminUsersController {
  constructor(private readonly deletion: AccountDeletionService) {}

  @Delete(":uid")
  async remove(@Param("uid") uid: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid))
      throw new BadRequestException({ statusCode: 400, code: "bad_uid", message: "Invalid user id." });
    return this.deletion.deleteAccount(uid, "admin");
  }
}
