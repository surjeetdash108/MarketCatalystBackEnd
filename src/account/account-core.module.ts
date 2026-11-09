import { Global, Module } from "@nestjs/common";
import { EmailVerificationService } from "./email-verification.service";

/** Account services other modules (billing, entitlements) depend on. */
@Global()
@Module({
  providers: [EmailVerificationService],
  exports: [EmailVerificationService],
})
export class AccountCoreModule {}
