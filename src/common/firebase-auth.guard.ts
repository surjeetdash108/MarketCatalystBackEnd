import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { FirebaseAdminService } from './firebase-admin.provider';

/**
 * Authorises any signed-in Firebase user (not just the admin account — see
 * AdminGuard for that narrower case). Verifies the bearer token and attaches
 * the decoded uid to the request as `req.uid`, read by the `@CurrentUser()`
 * decorator.
 *
 * Per-user endpoints (watchlist, portfolio, settings, profile, notifications,
 * stock notes) must ALWAYS scope Firestore reads/writes to this verified uid
 * — never to a uid supplied in a path/body param — or a user could read or
 * overwrite another user's data just by changing the URL.
 */
@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(FirebaseAuthGuard.name);

  constructor(private readonly firebase: FirebaseAdminService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers?.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (!token) {
      throw new UnauthorizedException('Missing Authorization: Bearer <Firebase ID token>.');
    }

    try {
      const decoded = await this.firebase.auth.verifyIdToken(token);
      req.uid = decoded.uid;
      return true;
    } catch (err) {
      this.logger.warn(`rejected invalid ID token: ${(err as Error).message}`);
      throw new UnauthorizedException('Invalid or expired ID token.');
    }
  }
}
