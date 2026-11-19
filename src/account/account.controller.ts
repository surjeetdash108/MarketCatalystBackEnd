import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import type { UserRecord } from "firebase-admin/auth";
import { IsString, Matches } from "class-validator";
import { clientIp } from "../common/client-ip";
import { CurrentUser } from "../common/current-user.decorator";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { AccountDeletionService } from "./account-deletion.service";
import { EmailVerificationService } from "./email-verification.service";
import { StaffAccessService } from "./staff-access.service";
import { EmailLifecycleService } from "../email/email-lifecycle.service";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { EmailService } from "../billing/email/email.service";

export class VerifyCodeDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: "code must be 6 digits" })
  code!: string;
}

export class DeleteAccountDto {
  @IsString()
  confirm!: string;
}

@Controller("api/account")
@UseGuards(FirebaseAuthGuard)
export class AccountController {
  constructor(
    private readonly verification: EmailVerificationService,
    private readonly staff: StaffAccessService,
    private readonly deletion: AccountDeletionService,
    private readonly lifecycle: EmailLifecycleService,
    private readonly firebase: FirebaseAdminService,
    private readonly emails: EmailService,
  ) {}

  /**
   * Delete my account: cancels any subscription now (no refund) and removes
   * all my data and my sign-in. The body must say confirm: "DELETE".
   */
  @Delete()
  @HttpCode(200)
  async deleteMe(@CurrentUser() uid: string, @Body() body: DeleteAccountDto) {
    if (body?.confirm !== "DELETE")
      throw new BadRequestException({
        statusCode: 400,
        code: "confirm_required",
        message: "Type DELETE to confirm.",
      });
    // Captured before the sign-in record is gone, for the confirmation email.
    const who = (await this.firebase.auth
      .getUser(uid)
      .catch(() => null)) as UserRecord | null;
    const r = await this.deletion.deleteAccount(uid, "self");
    if (who?.email) {
      void this.emails.accountDeleted(who.email, {
        firstName: (who.displayName ?? "").trim().split(/\s+/)[0] || "there",
        deletedAt: new Date().toISOString(),
      });
    }
    return { deleted: true, subscriptionsCancelled: r.subscriptionsCancelled };
  }

  /**
   * Called by the app after sign-in and on token refresh: sets/clears the
   * `staff` custom claim. refreshToken=true → the client must fetch a fresh ID
   * token so Firestore rules see the change.
   */
  @Post("sync-claims")
  @HttpCode(200)
  async syncClaims(@CurrentUser() uid: string, @Req() req: Request) {
    // Sign-in / token refresh: a new device gets the new sign-in alert.
    void this.lifecycle.recordSignIn(
      uid,
      clientIp(req),
      req.headers["user-agent"] ?? null,
    );
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
  async verify(@CurrentUser() uid: string, @Body() body: VerifyCodeDto) {
    const r = await this.verification.verify(uid, body.code);
    void this.lifecycle.onVerified(uid); // Welcome, then Trial started
    return r;
  }

  /** Promotional email preference (Settings). Account, billing and security mail always go. */
  @Get("email-prefs")
  emailPrefs(@CurrentUser() uid: string) {
    return this.lifecycle.emailPrefs(uid);
  }

  @Post("email-prefs")
  @HttpCode(200)
  setEmailPrefs(
    @CurrentUser() uid: string,
    @Body() body: { marketing?: unknown },
  ) {
    return this.lifecycle.setEmailPrefs(uid, body?.marketing === true);
  }
}
