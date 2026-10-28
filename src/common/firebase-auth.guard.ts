import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { FirebaseAdminService } from "./firebase-admin.provider";
import { SKIP_SESSION_CHECK } from "./skip-session-check.decorator";
import { UserSessionService } from "./user-session.service";

/**
 * Authorises any signed-in Firebase user (not just the admin account — see
 * AdminGuard for that narrower case). Verifies the bearer token and attaches
 * the decoded uid to the request as `req.uid`, read by the `@CurrentUser()`
 * decorator.
 *
 * Also enforces one active login per user: the `X-Session-Id` header must be
 * the session the user's latest login claimed (see UserSessionService).
 *
 * Per-user endpoints (watchlist, portfolio, settings, profile, notifications,
 * stock notes) must ALWAYS scope Firestore reads/writes to this verified uid
 * — never to a uid supplied in a path/body param — or a user could read or
 * overwrite another user's data just by changing the URL.
 */
@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(FirebaseAuthGuard.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly sessions: UserSessionService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers?.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

    if (!token) {
      throw new UnauthorizedException(
        "Missing Authorization: Bearer <Firebase ID token>.",
      );
    }

    let uid: string;
    try {
      uid = (await this.firebase.auth.verifyIdToken(token)).uid;
    } catch (err) {
      this.logger.warn(`rejected invalid ID token: ${(err as Error).message}`);
      throw new UnauthorizedException("Invalid or expired ID token.");
    }

    const skipSession = this.reflector.getAllAndOverride<boolean>(SKIP_SESSION_CHECK, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!skipSession) {
      await this.sessions.assertCurrent(uid, req.headers?.["x-session-id"]);
    }

    req.uid = uid;
    return true;
  }
}
