import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { AppClock } from "../common/app-clock";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  BILLING_PROVIDER,
  type BillingProvider,
} from "../billing/provider/billing-provider";

/** Docs keyed by uid that belong only to the person. */
const DOCS_BY_UID = [
  "subscriptions",
  "customers",
  "email_verifications",
  "user_sessions",
  "referral_attributions",
  "launch_offers",
  "abandoned_checkouts",
] as const;

/** Collections whose docs carry the owner in a `uid` field. */
const DOCS_WITH_UID_FIELD = [
  "stock_comments",
  "feature_requests",
  "referral_codes",
  "checkout_sessions",
] as const;

export interface DeletionReport {
  uid: string;
  subscriptionsCancelled: number;
  docsDeleted: number;
  authDeleted: boolean;
}

/**
 * Deletes an account everywhere: ends any live subscription now (no refund),
 * removes the profile with its watchlists, portfolio and notifications
 * (users/{uid} and every subcollection), notes, feature requests, referral
 * code, billing mirrors, and finally the sign-in account.
 *
 * Kept on purpose: payment and subscription history (accounting/tax records),
 * referral reward records, and the hashed-email trial/signup claims (so a
 * deleted-and-recreated account can't restart the free trial).
 * deleted_accounts/{uid} is written first so late provider events for this
 * uid are ignored instead of re-creating its records.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly clock: AppClock,
    @Optional()
    @Inject(BILLING_PROVIDER)
    private readonly provider: BillingProvider | null = null,
  ) {}

  private get db() {
    return this.firebase.firestore;
  }

  async deleteAccount(uid: string, by: "self" | "admin"): Promise<DeletionReport> {
    const db = this.db;
    await db
      .collection("deleted_accounts")
      .doc(uid)
      .set({ uid, deletedAt: this.clock.nowIso(), by });

    let subscriptionsCancelled = 0;
    const customer = (await db.collection("customers").doc(uid).get()).data();
    if (customer?.customerId && this.provider?.cancelAllNow) {
      subscriptionsCancelled = await this.provider.cancelAllNow(
        String(customer.customerId),
      );
    }

    let docsDeleted = 0;
    const userRef = db.collection("users").doc(uid);
    if ((await userRef.get()).exists) docsDeleted++;
    // recursiveDelete also removes subcollections (watchlists, portfolios,
    // notifications), and works even when the parent doc itself is missing.
    await db.recursiveDelete(userRef);

    for (const col of DOCS_BY_UID) {
      const ref = db.collection(col).doc(uid);
      if ((await ref.get()).exists) {
        await ref.delete();
        docsDeleted++;
      }
    }
    for (const col of DOCS_WITH_UID_FIELD) {
      const snap = await db.collection(col).where("uid", "==", uid).get();
      for (const d of snap.docs) {
        await d.ref.delete();
        docsDeleted++;
      }
    }

    let authDeleted = false;
    try {
      await this.firebase.auth.deleteUser(uid);
      authDeleted = true;
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err as Error).message;
      if (!String(code).includes("user-not-found")) throw err;
    }
    this.logger.log(
      `account ${uid} deleted (${by}): ${subscriptionsCancelled} subscription(s) cancelled, ${docsDeleted} doc(s), auth=${authDeleted}`,
    );
    return { uid, subscriptionsCancelled, docsDeleted, authDeleted };
  }
}
