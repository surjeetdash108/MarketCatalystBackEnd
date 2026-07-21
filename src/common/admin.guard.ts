import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirebaseAdminService } from './firebase-admin.provider';

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
 *     --no-allow-unauthenticated). Re-verifying would be redundant, so when
 *     `ADMIN_GUARD_TRUST_IAM` is on we accept it.
 *
 *     ⚠ If the service is ever made --allow-unauthenticated, that assumption
 *     breaks: anything could then present an arbitrary token. Set
 *     ADMIN_GUARD_TRUST_IAM=false at the same time, so ONLY a verified Firebase
 *     admin token is accepted.
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
      .get('ADMIN_EMAIL', 'admin@marketcatalyst.ai')
      .trim()
      .toLowerCase();
  }

  /** Whether a Cloud-Run-IAM-vetted Google token is accepted (see docblock). */
  private get trustIam(): boolean {
    return (
      String(this.config.get('ADMIN_GUARD_TRUST_IAM', 'true')).trim().toLowerCase() !== 'false'
    );
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers?.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (!token) {
      // No Authorization header. `gcloud run services proxy` authenticates at
      // the transport level and does NOT forward one, so this is the normal
      // shape of an ops/monitor request. With --no-allow-unauthenticated the
      // request could not have reached this process without passing Cloud Run
      // IAM, so in IAM mode it is already authorised.
      if (this.trustIam) return true;
      throw new UnauthorizedException(
        'Missing Authorization token. Admin endpoints require a Firebase admin ID token.',
      );
    }

    // ── Path 1: Firebase ID token (browser admin) ────────────────────────────
    try {
      const decoded = await this.firebase.auth.verifyIdToken(token);
      const email = (decoded.email ?? '').toLowerCase();
      if (email === this.adminEmail) return true;
      // A real, valid Firebase user who is NOT the admin — always refuse,
      // regardless of trustIam.
      this.logger.warn(`admin endpoint refused for non-admin user: ${email || decoded.uid}`);
      throw new ForbiddenException('Admin access required.');
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      // Not a Firebase token — fall through to path 2.
    }

    // ── Path 2: Google OIDC token already vetted by Cloud Run IAM ────────────
    if (this.trustIam) return true;

    throw new UnauthorizedException('Invalid or non-admin token.');
  }
}
