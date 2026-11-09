import { Controller, Headers, HttpCode, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../common/current-user.decorator";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { StreamTicketService } from "../common/stream-ticket.service";

/** Issues the short-lived ticket a browser EventSource presents on /live/*stream. */
@Controller("api")
@UseGuards(FirebaseAuthGuard)
export class StreamTicketController {
  constructor(private readonly tickets: StreamTicketService) {}

  @Post("stream-ticket")
  @HttpCode(200)
  issue(
    @CurrentUser() uid: string,
    @Headers("x-session-id") sessionId?: string,
  ): { ticket: string; expiresAt: string } {
    return this.tickets.issue(uid, sessionId);
  }
}
