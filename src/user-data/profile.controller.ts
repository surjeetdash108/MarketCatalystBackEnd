import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../common/current-user.decorator";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { setWithCreatedAt } from "../common/firestore-batch.util";

interface InvestorProfilePatch {
  profile_image?: string;
  name?: string;
  email?: string;
  mobileNumber?: string;
  age?: string;
  incomeRange?: string;
  investmentExperience?: string;
  investmentGoals?: string;
  riskTolerance?: string;
  investmentHorizon?: string;
  currentPortfolioValue?: string;
  preferredAssetClasses?: string[];
}

/** Firestore Timestamps (from docs written before this migration) and ISO strings alike → ISO string. */
function toIso(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof (v as { toDate?: unknown }).toDate === "function") {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return undefined;
}

/**
 * Per-user investor profile at `users/{uid}` — replaces profile-edit-form.tsx's
 * direct `setDoc` and firebase-listener.tsx's app-wide one-time `getDoc` on
 * auth state change. Firebase Auth's own `displayName` (updated via the
 * client SDK's `updateProfile()`) is untouched — that's Auth, not Firestore,
 * and stays client-side per the migration's original scope.
 */
@Controller("api")
@UseGuards(FirebaseAuthGuard)
export class ProfileController {
  constructor(private readonly firebase: FirebaseAdminService) {}

  private ref(uid: string) {
    return this.firebase.firestore.doc(`users/${uid}`);
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
    @Body() body: InvestorProfilePatch,
  ): Promise<Record<string, unknown> | null> {
    await setWithCreatedAt(this.firebase.firestore, this.ref(uid), {
      ...body,
      updatedAt: new Date().toISOString(),
    });
    return this.get(uid);
  }
}
