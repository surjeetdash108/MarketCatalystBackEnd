import { Global, Module } from "@nestjs/common";
import { EmailVerificationService } from "./email-verification.service";
import { StaffAccessService } from "./staff-access.service";

/** Account services other modules (billing, entitlements) depend on. */
@Global()
@Module({
  providers: [EmailVerificationService, StaffAccessService],
  exports: [EmailVerificationService, StaffAccessService],
})
export class AccountCoreModule {}
