import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { StreamTicketService } from "./stream-ticket.service";
import { UserSessionService } from "./user-session.service";

/**
 * Authenticates an SSE route from `?ticket=` (see StreamTicketService), since
 * EventSource cannot send headers. Re-checks the single-active-session rule
 * against the session the ticket was issued for, and attaches `req.uid` like
 * FirebaseAuthGuard does.
 */
@Injectable()
export class StreamTicketGuard implements CanActivate {
  constructor(
    private readonly tickets: StreamTicketService,
    private readonly sessions: UserSessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx
      .switchToHttp()
      .getRequest<{ query?: Record<string, unknown>; uid?: string }>();
    const claims = this.tickets.verify(req.query?.ticket);
    if (!claims) {
      throw new UnauthorizedException(
        "Missing, invalid or expired stream ticket.",
      );
    }
    await this.sessions.assertCurrent(claims.uid, claims.sid);
    req.uid = claims.uid;
    return true;
  }
}
