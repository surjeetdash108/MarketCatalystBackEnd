import { randomBytes } from "crypto";
import type { AppClock } from "../../common/app-clock";
import type { FirebaseAdminService } from "../../common/firebase-admin.provider";
import type { BillingEventsService } from "../billing-events.service";
import type { EmailService } from "../email/email.service";
import type { PromoService } from "../promo/promo.service";

/**
 * Launch-day migration (decision i): every existing non-paying user gets
 * 30 days of Pro (backend-written TRIALING with an expiry; Free afterwards) and
 * a one-time, first-year promo code for the launch email.
 *
 * Idempotent: launch_offers/{uid} records what each user got; a re-run skips
 * them. Dry run by default — nothing is written unless apply is true.
 */
export interface LaunchMigrationOptions {
  apply: boolean;
  planId: string;
  trialDays: number;
  promoPercentOff: number;
  promoPrefix: string;
  /** Emails never migrated (staff). */
  excludeEmails: string[];
  sendEmails: boolean;
}

export interface LaunchMigrationResult {
  dryRun: boolean;
  scanned: number;
  granted: number;
  skippedPaying: number;
  skippedAlreadyMigrated: number;
  skippedStaff: number;
  codesCreated: number;
  emailsSent: number;
}

const DAY = 86_400_000;

export function assertNoPlaceholders(opts: Pick<LaunchMigrationOptions, "promoPrefix"> & { promoPercentOffRaw: string }): void {
  if (/PLACEHOLDER/i.test(opts.promoPrefix) || /PLACEHOLDER/i.test(opts.promoPercentOffRaw)) {
    throw new Error("LAUNCH_PROMO_PREFIX / LAUNCH_PROMO_PERCENT still hold placeholder values; set the real launch offer first (docs/PLACEHOLDERS.md).");
  }
}

export async function runLaunchMigration(
  deps: { firebase: FirebaseAdminService; events: BillingEventsService; promos: PromoService; emails: EmailService; clock: AppClock },
  opts: LaunchMigrationOptions,
): Promise<LaunchMigrationResult> {
  const db = deps.firebase.firestore;
  const r: LaunchMigrationResult = { dryRun: !opts.apply, scanned: 0, granted: 0, skippedPaying: 0, skippedAlreadyMigrated: 0, skippedStaff: 0, codesCreated: 0, emailsSent: 0 };
  const staff = new Set(opts.excludeEmails.map((e) => e.trim().toLowerCase()));
  const endsAt = new Date(deps.clock.now() + opts.trialDays * DAY).toISOString();
  const users = await db.collection("users").get();
  for (const doc of users.docs) {
    r.scanned++;
    const uid = doc.id;
    const email = typeof doc.data().email === "string" ? String(doc.data().email).trim().toLowerCase() : null;
    if (email && staff.has(email)) {
      r.skippedStaff++;
      continue;
    }
    if ((await db.collection("launch_offers").doc(uid).get()).exists) {
      r.skippedAlreadyMigrated++;
      continue;
    }
    const mirror = (await db.collection("subscriptions").doc(uid).get()).data();
    if (mirror && ["ACTIVE", "TRIALING", "PAST_DUE"].includes(String(mirror.status))) {
      r.skippedPaying++;
      continue;
    }
    if (!opts.apply) {
      r.granted++;
      r.codesCreated++;
      continue;
    }
    if ((await deps.events.applyLaunchTrial(uid, opts.planId, endsAt)) !== "granted") {
      r.skippedPaying++;
      continue;
    }
    r.granted++;
    const code = `${opts.promoPrefix}-${randomBytes(4).toString("hex").toUpperCase()}`;
    const promo = await deps.promos.create(
      { code, percentOff: opts.promoPercentOff, duration: "repeating", durationInMonths: 12, maxRedemptions: 1, firstTimeOnly: true, kind: "launch" },
      "launch-migration",
    );
    r.codesCreated++;
    await db.collection("launch_offers").doc(uid).set({ uid, promoId: promo.id, code: promo.code, trialPlanId: opts.planId, trialEndsAt: endsAt, migratedAt: deps.clock.nowIso() });
    if (opts.sendEmails && email) {
      await deps.emails.launchOffer(email, { code: promo.code, trialEndsAt: endsAt });
      r.emailsSent++;
    }
  }
  return r;
}
