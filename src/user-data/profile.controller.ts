import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../common/current-user.decorator";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { DEFAULT_PLAN_ID } from "../plans/plans.registry";
import { InvestorProfilePatchDto, pickProfileFields } from "./profile.dto";

/** Firestore Timestamps (from docs written before this migration) and ISO strings alike → ISO string. */
function toIso(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof (v as { toDate?: unknown }).toDate === "function") {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return undefined;
}

/**
 * Plan fields a brand-new profile starts with. Set by the server only — the
 * client cannot send them (they are not in InvestorProfilePatchDto), and the
 * Stripe webhook is the only writer once a user pays.
 */
const NEW_USER_PLAN_FIELDS = {
  tier: DEFAULT_PLAN_ID,
  currentPlan: DEFAULT_PLAN_ID,
  subscriptionStatus: "NONE",
} as const;

/**
 * Per-user investor profile at `users/{uid}`.
 *
 * Only investor-profile fields are accepted from the request. Identity
 * (`uid`, `email`), plan/subscription, Stripe and feature-flag fields are
 * server-owned: `uid` comes from the verified token, `email` from the Firebase
 * Auth account, plan fields are defaulted on first write and otherwise never
 * touched here.
 */
@Controller("api")
@UseGuards(FirebaseAuthGuard)
export class ProfileController {
  constructor(private readonly firebase: FirebaseAdminService) {}

  private ref(uid: string) {
    return this.firebase.firestore.collection("users").doc(uid);
  }

  @Get("profile")
  async get(
    @CurrentUser() uid: string,
  ): Promise<Record<string, unknown> | null> {
    const snap = await this.ref(uid).get();
    if (!snap.exists) return null;
    const { createdAt, updatedAt, ...rest } = snap.data() ?? {};
    return {
      ...rest,
      createdAt: toIso(createdAt) ?? null,
      updatedAt: toIso(updatedAt) ?? null,
    };
  }

  @Patch("profile")
  async update(
    @CurrentUser() uid: string,
    @Body() body: InvestorProfilePatchDto,
  ): Promise<Record<string, unknown> | null> {
    const patch = pickProfileFields(body as Record<string, unknown>);
    const ref = this.ref(uid);
    const now = new Date().toISOString();
    const snap = await ref.get();

    if (!snap.exists) {
      const email = await this.authEmail(uid);
      await ref.set({
        ...patch,
        ...NEW_USER_PLAN_FIELDS,
        uid,
        ...(email ? { email } : {}),
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await ref.update({ ...patch, updatedAt: now });
    }
    return this.get(uid);
  }

  /** The verified account's email; null when Auth has none (e.g. phone sign-in). */
  private async authEmail(uid: string): Promise<string | null> {
    try {
      const user = await this.firebase.auth.getUser(uid);
      return user.email ? user.email.trim().toLowerCase() : null;
    } catch {
      return null;
    }
  }
}
