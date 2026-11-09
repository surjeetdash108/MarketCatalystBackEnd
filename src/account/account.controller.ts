import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { IsString, Matches } from "class-validator";
import { clientIp } from "../common/client-ip";
import { CurrentUser } from "../common/current-user.decorator";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { EmailVerificationService } from "./email-verification.service";
import { StaffAccessService } from "./staff-access.service";

export class VerifyCodeDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: "code must be 6 digits" })
  code!: string;
}

@Controller("api/account")
@UseGuards(FirebaseAuthGuard)
export class AccountController {
  constructor(
    private readonly verification: EmailVerificationService,
    private readonly staff: StaffAccessService,
  ) {}

  /**
   * Called by the app after sign-in and on token refresh: sets/clears the
   * `staff` custom claim. refreshToken=true → the client must fetch a fresh ID
   * token so Firestore rules see the change.
   */
  @Post("sync-claims")
  @HttpCode(200)
  async syncClaims(@CurrentUser() uid: string) {
    const r = await this.staff.syncClaim(uid);
    return { staff: r.staff, refreshToken: r.changed };
  }

  @Get("email-verification")
  status(@CurrentUser() uid: string) {
    return this.verification.status(uid);
  }

  @Post("email-verification/send")
  @HttpCode(200)
  send(@CurrentUser() uid: string, @Req() req: Request) {
    return this.verification.send(uid, clientIp(req));
  }

  @Post("email-verification/verify")
  @HttpCode(200)
  verify(@CurrentUser() uid: string, @Body() body: VerifyCodeDto) {
    return this.verification.verify(uid, body.code);
  }
}
