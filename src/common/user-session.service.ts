import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { FirebaseAdminService } from "./firebase-admin.provider";

/** Body code the UI keys on to sign the superseded device out. */
export const SESSION_SUPERSEDED = "SESSION_SUPERSEDED";

/**
 * One active login per user. Every login claims a fresh session id, stored at
 * `user_sessions/{uid}`; a request whose `X-Session-Id` is not the stored one
 * belongs to a device that has since been replaced and is refused. The newest
 * login wins, so a user who forgets to sign out (or loses a device) is never
 * locked out.
 *
 * Deliberately NOT keyed on IP: mobile networks and VPNs change IP mid-session
 * (kicking a legitimate user) while two devices on one Wi-Fi share one.
 *
 * Firebase's own revokeRefreshTokens(uid) can't do this — it revokes the new
 * login's tokens along with the old ones.
 */
@Injectable()
export class UserSessionService {
  private readonly logger = new Logger(UserSessionService.name);

  /**
   * Per-instance read cache so a guarded request doesn't cost a Firestore read.
   * The cost is that another Cloud Run instance can honour a superseded session
   * for up to TTL after the claim landed elsewhere.
   */
  private static readonly CACHE_TTL_MS = 10_000;
  private static readonly CACHE_MAX_ENTRIES = 10_000;
  private readonly cache = new Map<string, { sessionId: string | null; expires: number }>();

  constructor(private readonly firebase: FirebaseAdminService) {}

  private doc(uid: string) {
    return this.firebase.firestore.collection("user_sessions").doc(uid);
  }

  /** Makes `sessionId` the user's only valid session, superseding any other. */
  async claim(uid: string, sessionId: string): Promise<void> {
    await this.doc(uid).set({ sessionId, claimedAt: new Date() });
    this.remember(uid, sessionId);
  }

  /**
   * Throws 401 SESSION_SUPERSEDED unless `sessionId` is the user's current
   * session. A user with no stored session yet (not claimed since this shipped)
   * is let through. A store outage fails open: this is an anti-sharing policy,
   * not the auth boundary — the ID token already is — so Firestore hiccups must
   * not take the whole API down.
   */
  async assertCurrent(uid: string, sessionId: string | undefined): Promise<void> {
    let current: string | null;
    try {
      current = await this.currentSessionId(uid);
    } catch (err) {
      this.logger.warn(`session lookup failed for ${uid}, allowing: ${(err as Error).message}`);
      return;
    }
    if (current === null || current === sessionId) return;

    throw new UnauthorizedException({
      code: SESSION_SUPERSEDED,
      message: "This account was signed in on another device.",
    });
  }

  private async currentSessionId(uid: string): Promise<string | null> {
    const hit = this.cache.get(uid);
    if (hit && hit.expires > Date.now()) return hit.sessionId;

    const snap = await this.doc(uid).get();
    const sessionId = snap.exists ? ((snap.get("sessionId") as string | undefined) ?? null) : null;
    this.remember(uid, sessionId);
    return sessionId;
  }

  private remember(uid: string, sessionId: string | null): void {
    if (this.cache.size >= UserSessionService.CACHE_MAX_ENTRIES) {
      const now = Date.now();
      for (const [key, entry] of this.cache) {
        if (entry.expires <= now) this.cache.delete(key);
      }
      if (this.cache.size >= UserSessionService.CACHE_MAX_ENTRIES) this.cache.clear();
    }
    this.cache.set(uid, { sessionId, expires: Date.now() + UserSessionService.CACHE_TTL_MS });
  }
}
