import { SetMetadata } from "@nestjs/common";

export const SKIP_SESSION_CHECK = "skipSessionCheck";

/**
 * Exempts a route from FirebaseAuthGuard's single-active-session check. Only
 * for the route that CREATES the session — it has none to present yet.
 */
export const SkipSessionCheck = () => SetMetadata(SKIP_SESSION_CHECK, true);
