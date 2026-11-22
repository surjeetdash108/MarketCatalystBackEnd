/**
 * Wipes ONE user's subscription and billing records but keeps the account
 * (sign-in, profile, watchlists, portfolio). The users-doc billing projection
 * is reset to no plan; optionally the profile's createdAt is rewritten.
 *
 * Only Stripe TEST-mode records (livemode:false) are deleted. If a live
 * payment or subscription is found the script stops without writing: live
 * history is an accounting record and goes through the normal admin flow.
 *
 * Cancel the subscription in Stripe first (otherwise its next webhook
 * re-creates the mirror), then:
 *
 *   # dry run (default): lists what would change, writes nothing
 *   npx ts-node --transpile-only scripts/purge-user-billing.ts \
 *     --project=<id> --database=mc-regional --uid=<uid> \
 *     [--created-at=2026-11-10T12:00:00.000Z] [--auth=gcloud]
 *   # write
 *   ... --apply                         # emulator / staging
 *   ... --apply --confirm-production    # production
 */
import { scriptAuthFrom, scriptFirestore } from "./lib/script-firestore";
import { DEFAULT_PRODUCTION_PROJECT_IDS } from "../src/common/environment";
import { BILLING_COLLECTIONS } from "../src/billing/billing-events.service";
import { isTestRecord } from "../src/billing/livemode";
import { RESET_PROJECTION } from "../src/billing/test-mode-purge";

const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n: string) => process.argv.includes(`--${n}`);

/** Docs keyed by uid. */
const BY_UID = [
  BILLING_COLLECTIONS.subscriptions,
  BILLING_COLLECTIONS.customers,
  "abandoned_checkouts",
] as const;

/** Collections whose docs point at the user by uid or customerId field. */
const BY_FIELD = [
  BILLING_COLLECTIONS.payments,
  BILLING_COLLECTIONS.events,
  BILLING_COLLECTIONS.processed,
  BILLING_COLLECTIONS.checkouts,
  BILLING_COLLECTIONS.promoRedemptions,
] as const;

async function main() {
  const project = arg("project");
  const database = arg("database") ?? "(default)";
  const uid = arg("uid");
  const createdAt = arg("created-at");
  if (!project) throw new Error("--project is required");
  if (!uid || !/^[A-Za-z0-9_-]{1,128}$/.test(uid))
    throw new Error("--uid is required");
  if (createdAt && Number.isNaN(Date.parse(createdAt)))
    throw new Error(`--created-at is not a date: ${createdAt}`);
  const apply = flag("apply") && !flag("dry-run");
  const prodIds = (
    process.env.PRODUCTION_PROJECT_IDS ?? DEFAULT_PRODUCTION_PROJECT_IDS
  )
    .split(",")
    .map((s) => s.trim());
  if (apply && prodIds.includes(project) && !flag("confirm-production"))
    throw new Error(
      `${project} is production: add --confirm-production to apply.`,
    );

  const db = scriptFirestore(project, database, scriptAuthFrom(process.argv));
  const userRef = db.collection("users").doc(uid);
  const user = await userRef.get();
  if (!user.exists) throw new Error(`users/${uid} not found in ${database}`);

  const customer = (
    await db.collection(BILLING_COLLECTIONS.customers).doc(uid).get()
  ).data();
  const customerId = customer?.customerId ? String(customer.customerId) : null;

  const toDelete: Array<{ col: string; id: string }> = [];
  const live: string[] = [];
  const consider = (col: string, id: string, data: unknown) => {
    // abandoned_checkouts carry no livemode: they are reminders, not records.
    if (col === "abandoned_checkouts" || isTestRecord(data))
      toDelete.push({ col, id });
    else live.push(`${col}/${id}`);
  };

  for (const col of BY_UID) {
    const d = await db.collection(col).doc(uid).get();
    if (d.exists) consider(col, uid, d.data());
  }
  for (const col of BY_FIELD) {
    const snap = await db.collection(col).get();
    for (const d of snap.docs) {
      const x = d.data() as { uid?: unknown; customerId?: unknown };
      if (x.uid === uid || (customerId && x.customerId === customerId))
        consider(col, d.id, x);
    }
  }
  if (live.length)
    throw new Error(
      `live billing records found, nothing written:\n  ${live.join("\n  ")}`,
    );

  const userUpdate = {
    ...RESET_PROJECTION,
    ...(createdAt ? { createdAt: new Date(createdAt).toISOString() } : {}),
  };

  console.log(
    `${apply ? "APPLYING" : "DRY RUN"} — ${project}/${database} — users/${uid}`,
  );
  for (const w of toDelete) console.log(`  delete ${w.col}/${w.id}`);
  console.log(`  update users/${uid} ${JSON.stringify(userUpdate)}`);
  if (!apply) return;

  const batch = db.batch();
  for (const w of toDelete) batch.delete(db.collection(w.col).doc(w.id));
  batch.update(userRef, userUpdate);
  await batch.commit();
  console.log(`done: ${toDelete.length} doc(s) deleted, profile reset`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
