import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import type { AuthTokenInfo } from "../common/auth-token";
import { isLifetimeElite } from "../plans/lifetime-elite";

/**
 * Staff full access. WHO is staff lives only in Firestore config/staff_access
 * ({ emails: string[] }, lowercased, exact match) — never in app code. Firestore
 * rules deny every client read/write of config/*; the admin console edits the
 * list through the API (audited by AdminAuditInterceptor).
 *
 * Staff requires a VERIFIED email (Google sign-in, or a verified email/password
 * account). Staff is NOT admin: it never grants the admin console.
 */
export const STAFF_DOC = "config/staff_access";
const CACHE_MS = 30_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseStaffEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class StaffAccessService {
  private readonly logger = new Logger(StaffAccessService.name);
  private cache: { at: number; emails: Set<string> } | null = null;

  constructor(private readonly firebase: FirebaseAdminService) {}

  async list(): Promise<string[]> {
    return [...(await this.set())].sort();
  }

  private async set(): Promise<Set<string>> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS)
      return this.cache.emails;
    let emails = new Set<string>();
    try {
      const raw = (await this.firebase.firestore.doc(STAFF_DOC).get()).data()
        ?.emails;
      if (Array.isArray(raw))
        emails = new Set(
          raw
            .filter((e): e is string => typeof e === "string")
            .map(normaliseStaffEmail),
        );
    } catch (err) {
      // Fail closed: no read, no staff.
      this.logger.warn(`staff list read failed: ${(err as Error).message}`);
      return this.cache?.emails ?? new Set();
    }
    this.cache = { at: Date.now(), emails };
    return emails;
  }

  /** Listed email AND verified. */
  async isStaff(
    token: Pick<AuthTokenInfo, "email" | "emailVerified"> | null | undefined,
  ): Promise<boolean> {
    if (!token?.email || token.emailVerified !== true) return false;
    return (await this.set()).has(normaliseStaffEmail(token.email));
  }

  /** Same rule from the Auth record (for code paths without the request token). */
  async isStaffUid(uid: string): Promise<boolean> {
    try {
      const u = await this.firebase.auth.getUser(uid);
      return this.isStaff({
        email: u.email ?? null,
        emailVerified: u.emailVerified === true,
      });
    } catch {
      return false;
    }
  }

  async isListed(email: string | null | undefined): Promise<boolean> {
    return !!email && (await this.set()).has(normaliseStaffEmail(email));
  }

  /**
   * Sets or clears the `staff` custom claim from the Auth record (verified email
   * on the list → true), keeping every other claim (plan, admin…).
   */
  async syncClaim(uid: string): Promise<{ staff: boolean; changed: boolean }> {
    const u = await this.firebase.auth.getUser(uid);
    const staff = await this.isStaff({
      email: u.email ?? null,
      emailVerified: u.emailVerified === true,
    });
    const lifetime = isLifetimeElite(u.email);
    const claims = {
      ...((u.customClaims as Record<string, unknown> | undefined) ?? {}),
    };
    let changed = false;
    if (lifetime) {
      if (claims.plan !== "elite") {
        claims.plan = "elite";
        changed = true;
      }
      if (claims.staff !== true) {
        claims.staff = true;
        changed = true;
      }
    } else {
      if ((claims.staff === true) !== staff) {
        if (staff) claims.staff = true;
        else delete claims.staff;
        changed = true;
      }
    }
    if (changed) {
      await this.firebase.auth.setCustomUserClaims(uid, claims);
    }
    return { staff: staff || lifetime, changed };
  }

  async add(email: string): Promise<string[]> {
    const e = normaliseStaffEmail(email ?? "");
    if (!EMAIL.test(e))
      throw new BadRequestException({
        statusCode: 400,
        code: "invalid_email",
        message: "Enter a valid email address.",
      });
    return this.update((s) => s.add(e));
  }

  async remove(email: string): Promise<string[]> {
    const e = normaliseStaffEmail(email ?? "");
    return this.update((s) => s.delete(e));
  }

  private async update(mutate: (s: Set<string>) => void): Promise<string[]> {
    const ref = this.firebase.firestore.doc(STAFF_DOC);
    const next = await this.firebase.firestore.runTransaction(async (tx) => {
      const raw = (await tx.get(ref)).data()?.emails;
      const s = new Set<string>(
        Array.isArray(raw)
          ? raw.map((x: string) => normaliseStaffEmail(String(x)))
          : [],
      );
      mutate(s);
      const emails = [...s].sort();
      tx.set(ref, { emails, updatedAt: new Date().toISOString() });
      return emails;
    });
    this.cache = null;
    return next;
  }
}
