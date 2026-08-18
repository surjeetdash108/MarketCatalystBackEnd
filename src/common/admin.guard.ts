import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FirebaseAdminService } from "./firebase-admin.provider";

/**
 * Authorises the powerful admin endpoints (purge, feature-flag toggles,
 * retention, job triggers).
 *
 * TWO legitimate callers exist, and BOTH must keep working:
 *
 *  1. The admin in a browser — sends a FIREBASE ID token. Verified properly
 *     here; the email must match the single fixed admin account.
 *
 *  2. Cloud Scheduler (and `gcloud run services proxy`) — sends a GOOGLE OIDC
 *     token, not a Firebase one. Cloud Run's IAM has ALREADY verified that
 *     token's signature and checked the caller holds run.invoker BEFORE the
 *     request reaches this process (the service runs
 *     --no-allow-unauthenticated). Re-verifying would be redundant, so this
 *     path is accepted ONLY when `ADMIN_GUARD_TRUST_IAM` is EXPLICITLY "true".
 *
 *     ⚠ FAIL-CLOSED DEFAULT: path 2 is OFF unless the env var is explicitly
 *     "true" (see `trustIam`). A missing/unset value denies no-token requests.
 *     Enable it only on a service that genuinely runs
 *     --no-allow-unauthenticated behind Cloud Run IAM and needs the scheduler /
 *     proxy path. If the service is ever made --allow-unauthenticated, that
 *     assumption breaks: anything could then present an arbitrary token — leave
 *     ADMIN_GUARD_TRUST_IAM unset/false so ONLY a verified Firebase admin token
 *     is accepted.
 *
 * Guarding /sync/:job/run without path 2 would silently break every scheduled
 * sync — which is why this guard exists in this shape rather than a plain
 * "verify Firebase token" check.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly config: ConfigService,
  ) {}

  private get adminEmail(): string {
    return this.config
      .get("ADMIN_EMAIL", "admin@marketcatalyst.ai")
      .trim()
      .toLowerCase();
  }

  /**
   * Whether a Cloud-Run-IAM-vetted Google token — or an unauthenticated,
   * transport-authenticated `gcloud run services proxy` request that carries no
   * Authorization header at all — is trusted WITHOUT a Firebase admin token
   * (see docblock).
   *
   * FAIL-CLOSED: this is true ONLY when ADMIN_GUARD_TRUST_IAM is EXPLICITLY
   * "true". A missing / unset / blank / any-other value returns false, so a
   * no-token request is DENIED.
   *
   * Rationale for the default flip: the previous default was fail-OPEN (trusted
   * unless the value was literally "false"), so a deploy that simply forgot to
   * set ADMIN_GUARD_TRUST_IAM=false would silently re-open the hole where a
   * no-token request is admitted to the powerful admin endpoints. Defaulting to
   * false makes the CODE match the hardened prod env var (ADMIN_GUARD_TRUST_IAM
   * was patched to false on the live service), so the safe posture no longer
   * depends on remembering an env var at deploy time — a service that really
   * needs path 2 must OPT IN explicitly.
   */
  private get trustIam(): boolean {
    return (
      String(this.config.get("ADMIN_GUARD_TRUST_IAM", "false"))
        .trim()
        .toLowerCase() === "true"
    );
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers?.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

    if (!token) {
      // No Authorization header. `gcloud run services proxy` authenticates at
      // the transport level and does NOT forward one, so this is the normal
      // shape of an ops/monitor request. With --no-allow-unauthenticated the
      // request could not have reached this process without passing Cloud Run
      // IAM, so in IAM mode it is already authorised.
      if (this.trustIam) return true;
      throw new UnauthorizedException(
        "Missing Authorization token. Admin endpoints require a Firebase admin ID token.",
      );
    }

    // ── Path 1: Firebase ID token (browser admin) ────────────────────────────
    try {
      const decoded = await this.firebase.auth.verifyIdToken(token);
      const email = (decoded.email ?? "").toLowerCase();
      if (email === this.adminEmail) return true;
      // A real, valid Firebase user who is NOT the admin — always refuse,
      // regardless of trustIam.
      this.logger.warn(
        `admin endpoint refused for non-admin user: ${email || decoded.uid}`,
      );
      throw new ForbiddenException("Admin access required.");
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      // Not a Firebase token — fall through to path 2.
    }

    // ── Path 2: Google OIDC token already vetted by Cloud Run IAM ────────────
    if (this.trustIam) return true;

    throw new UnauthorizedException("Invalid or non-admin token.");
  }
}
