import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../common/current-user.decorator";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { SkipSessionCheck } from "../common/skip-session-check.decorator";
import { UserSessionService } from "../common/user-session.service";

const SESSION_ID_RE = /^[A-Za-z0-9-]{16,64}$/;

/**
 * Called by the UI right after a login. Whichever device claims last is the
 * only one whose requests FirebaseAuthGuard will accept from then on.
 */
@Controller("api/session")
export class SessionController {
  constructor(private readonly sessions: UserSessionService) {}

  @Post("claim")
  @HttpCode(204)
  @SkipSessionCheck()
  @UseGuards(FirebaseAuthGuard)
  async claim(@CurrentUser() uid: string, @Body() body: { sessionId?: unknown }): Promise<void> {
    const sessionId = body?.sessionId;
    if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
      throw new BadRequestException("sessionId must be a 16-64 character id.");
    }
    await this.sessions.claim(uid, sessionId);
  }
}
