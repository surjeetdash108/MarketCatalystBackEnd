import { Controller, Get, Header } from "@nestjs/common";
import { LandingTapeService, type LandingTape } from "./landing-tape.service";

/**
 * Public, anonymous market figures for the marketing site's hero.
 *
 * Unauthenticated on purpose — the landing page has no signed-in user — so the
 * payload is limited to the four hero figures and the marquee's symbol + move.
 * Everything else the platform serves stays behind FirebaseAuthGuard.
 *
 * Called server-to-server by the website's /api/market/tape route, which is
 * what the browser talks to; this origin is not in the CORS allowlist for the
 * marketing site and does not need to be.
 */
@Controller("public")
export class LandingTapeController {
  constructor(private readonly landing: LandingTapeService) {}

  /** GET /public/landing-tape */
  @Get("landing-tape")
  @Header(
    "Cache-Control",
    "public, max-age=30, s-maxage=60, stale-while-revalidate=300",
  )
  get(): Promise<LandingTape> {
    return this.landing.get();
  }
}
