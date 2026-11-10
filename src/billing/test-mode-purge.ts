import type { Firestore } from "firebase-admin/firestore";
import { BILLING_COLLECTIONS } from "./billing-events.service";
import { isTestRecord } from "./livemode";

/**
 * Removes Stripe test-mode billing records (livemode:false) — the staff
 * checkout preview's customers, subscriptions, payments, events, checkout
 * sessions, processed-event markers and promo redemptions. Live records (and
 * records without the field) are never touched.
 *
 * For each user whose subscription mirror is removed, the users-doc billing
 * projection is reset to Free so the purged plan doesn't linger there (a
 * staff account keeps full access through the staff allowlist regardless).
 *
 * Dry run by default: reports what it would delete and writes nothing.
 */
export const TEST_MODE_COLLECTIONS = [
  BILLING_COLLECTIONS.subscriptions,
  BILLING_COLLECTIONS.customers,
  BILLING_COLLECTIONS.payments,
  BILLING_COLLECTIONS.events,
  BILLING_COLLECTIONS.processed,
  BILLING_COLLECTIONS.checkouts,
  BILLING_COLLECTIONS.promoRedemptions,
] as const;

export interface PurgeResult {
  dryRun: boolean;
  /** collection → doc ids that are (or would be) deleted. */
  deleted: Record<string, string[]>;
  /** users whose billing projection is (or would be) reset to Free. */
  usersReset: string[];
}

const RESET_PROJECTION = {
  currentPlan: "free",
  subscriptionStatus: null,
  subscriptionInterval: null,
  subscriptionStartDate: null,
  subscriptionExpiryDate: null,
  cancelAtPeriodEnd: false,
  pastDueSince: null,
};

export async function purgeTestModeBilling(
  db: Firestore,
  opts: { dryRun: boolean },
): Promise<PurgeResult> {
  const deleted: Record<string, string[]> = {};
  for (const col of TEST_MODE_COLLECTIONS) {
    const snap = await db.collection(col).get();
    deleted[col] = snap.docs
      .filter((d) => isTestRecord(d.data()))
      .map((d) => d.id);
  }
  // Only existing users docs, and only the projection fields (update = field
  // mask; never a whole-doc replace).
  const usersReset: string[] = [];
  for (const uid of deleted[BILLING_COLLECTIONS.subscriptions])
    if ((await db.collection("users").doc(uid).get()).exists)
      usersReset.push(uid);
  if (!opts.dryRun) {
    const refs = [
      ...Object.entries(deleted).flatMap(([col, ids]) =>
        ids.map((id) => ({
          kind: "delete" as const,
          ref: db.collection(col).doc(id),
        })),
      ),
      ...usersReset.map((uid) => ({
        kind: "reset" as const,
        ref: db.collection("users").doc(uid),
      })),
    ];
    // Firestore commits at most 500 writes at a time.
    for (let i = 0; i < refs.length; i += 400) {
      const batch = db.batch();
      for (const w of refs.slice(i, i + 400)) {
        if (w.kind === "delete") batch.delete(w.ref);
        else batch.update(w.ref, RESET_PROJECTION);
      }
      await batch.commit();
    }
  }
  return { dryRun: opts.dryRun, deleted, usersReset };
}
