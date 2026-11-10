import { BadRequestException, Controller, Get, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../common/current-user.decorator";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { AiAnalysisService } from "../live/ai-analysis.service";

/** Firestore ids are opaque, but keep them boring — this one is concatenated
 *  into a doc id, so refuse anything with a path separator or wildcard. */
const LIST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Cumulative ("basket-level") AI reads — the summary at the top of the
 * portfolio and watchlist screens. Distinct from `/live/ai-analysis`, which is
 * the read for ONE stock: these synthesise across every member, reusing each
 * member's own cached per-stock read where one is fresh.
 *
 * Both routes are scoped to the verified `uid` from FirebaseAuthGuard and never
 * accept a user id from the client — same rule as the rest of user-data. The
 * caller can only ever summarise their own basket.
 */
@Controller("api/ai")
@UseGuards(FirebaseAuthGuard)
export class AiUserController {
  constructor(private readonly ai: AiAnalysisService) {}

  @Get("portfolio")
  async portfolio(@CurrentUser() uid: string): Promise<Record<string, unknown>> {
    return this.ai.getPortfolioSummary(uid);
  }

  /** One watchlist at a time — whichever list the user is looking at. */
  @Get("watchlist")
  async watchlist(
    @CurrentUser() uid: string,
    @Query("listId") listId?: string,
  ): Promise<Record<string, unknown>> {
    const id = (listId ?? "").trim();
    if (!LIST_ID_RE.test(id)) {
      throw new BadRequestException("listId is required");
    }
    return this.ai.getWatchlistSummary(uid, id);
  }
}
