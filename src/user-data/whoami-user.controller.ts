import { Controller, Get, UseGuards } from "@nestjs/common";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";

/**
 * Phase-0 proof that a Firebase ID token round-trips end to end: UI attaches
 * the token, backend verifies it and hands back the uid it decoded. Once
 * WatchlistController/PortfolioController/etc. land in this module and are
 * verified working, this route can be deleted — it exists only to de-risk the
 * auth plumbing before anything real depends on it.
 */
@Controller("api")
export class WhoamiUserController {
  @Get("whoami-user")
  @UseGuards(FirebaseAuthGuard)
  whoami(@CurrentUser() uid: string) {
    return { uid };
  }
}
