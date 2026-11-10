import { AsyncLocalStorage } from "async_hooks";
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { StaffAccessService } from "../account/staff-access.service";
import type { AuthTokenInfo } from "../common/auth-token";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";

/**
 * Staff-only checkout preview. With CHECKOUT_PREVIEW on (admin console toggle,
 * default off), verified staff-allowlist accounts can use /checkout and the
 * Manage Plan picker end to end while SUBSCRIPTIONS_ENABLED stays off for
 * everyone else. Nothing about gating changes: staff keep full access, other
 * users keep "launching soon".
 *
 * The decision is made once per request (flag && verified staff) and carried
 * in AsyncLocalStorage, so BillingAccessService can honour it deep inside the
 * billing services without threading a token everywhere.
 */
export const CHECKOUT_PREVIEW_FLAG = "CHECKOUT_PREVIEW";

const store = new AsyncLocalStorage<{ preview: boolean }>();

/** True inside a request that is allowed to use the staff checkout preview. */
export function inCheckoutPreview(): boolean {
  return store.getStore()?.preview === true;
}

export function runInCheckoutPreview<T>(preview: boolean, fn: () => T): T {
  return store.run({ preview }, fn);
}

@Injectable()
export class CheckoutPreviewService {
  constructor(
    private readonly flags: FeatureFlagsService,
    private readonly staff: StaffAccessService,
  ) {}

  flagOn(): Promise<boolean> {
    return this.flags.isEnabled(CHECKOUT_PREVIEW_FLAG);
  }

  async allowedFor(token: AuthTokenInfo | undefined): Promise<boolean> {
    return (await this.flagOn()) && (await this.staff.isStaff(token));
  }
}

/** Runs the handler inside the preview scope when the caller qualifies. */
@Injectable()
export class CheckoutPreviewInterceptor implements NestInterceptor {
  constructor(private readonly preview: CheckoutPreviewService) {}

  async intercept(
    ctx: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest<{ authToken?: AuthTokenInfo }>();
    const allowed = await this.preview.allowedFor(req.authToken);
    return new Observable((sub) =>
      runInCheckoutPreview(allowed, () => next.handle().subscribe(sub)),
    );
  }
}
