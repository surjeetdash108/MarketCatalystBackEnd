import { randomInt } from "crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { AppClock } from "../../common/app-clock";
import { FirebaseAdminService } from "../../common/firebase-admin.provider";
import { SubscriptionsService } from "../../plans/subscriptions.service";
import {
  BILLING_PROVIDER,
  type BillingProvider,
} from "../provider/billing-provider";

/**
 * Refer a friend.
 *
 *   - Only a member with an active plan (paid or trialing; Lifetime Elite)
 *     gets a referral code/link. The code is random (referral_codes/{CODE}),
 *     never derived from the uid.
 *   - The friend gets REFERRAL_FRIEND_DISCOUNT off their first payment, once,
 *     only as a first-time customer, never with their own code.
 *   - The referrer gets REFERRAL_REWARD as account credit (Stripe customer
 *     balance, used on their next invoices) only when the friend actually
 *     pays — the first successful charge above $0, not a free trial — and only
 *     while the referrer still has an active plan. Once per friend
 *     (referral_rewards/{friendUid}); the credit call is idempotent.
 */
export const REFERRAL_REWARD = 2500;
export const REFERRAL_FRIEND_DISCOUNT = 2500;
export const REFERRAL_CURRENCY = "USD";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type ReferralCodeResult =
  | {
      eligible: true;
      code: string;
      reward: number;
      friendDiscount: number;
      currency: string;
    }
  | { eligible: false; reason: "no_active_plan" };

export type RewardOutcome =
  | "credited"
  | "duplicate"
  | "no_referral"
  | "self_referral"
  | "referrer_inactive"
  | "referrer_no_billing_account";

export const normaliseReferralCode = (code: string) =>
  String(code ?? "").trim().toUpperCase();

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly subscriptions: SubscriptionsService,
    private readonly clock: AppClock,
    @Optional()
    @Inject(BILLING_PROVIDER)
    private readonly provider: BillingProvider | null = null,
  ) {}

  private get db() {
    return this.firebase.firestore;
  }

  /** Active plan = a paid or trialing plan that is currently entitled (Lifetime Elite included). */
  async referrerActive(uid: string): Promise<boolean> {
    const e = await this.subscriptions.forUser(uid);
    return e.entitled && (e.status === "ACTIVE" || e.status === "TRIALING");
  }

  /** The member's referral code, created on first request — only with an active plan. */
  async codeFor(uid: string): Promise<ReferralCodeResult> {
    if (!(await this.referrerActive(uid)))
      return { eligible: false, reason: "no_active_plan" };
    const existing = await this.db
      .collection("referral_codes")
      .where("uid", "==", uid)
      .limit(1)
      .get();
    let code = existing.empty ? null : String(existing.docs[0].id);
    for (let attempt = 0; !code && attempt < 5; attempt++) {
      const candidate =
        "MC-" +
        Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
      const ref = this.db.collection("referral_codes").doc(candidate);
      const created = await this.db.runTransaction(async (tx) => {
        if ((await tx.get(ref)).exists) return false;
        tx.set(ref, { code: candidate, uid, createdAt: this.clock.nowIso() });
        return true;
      });
      if (created) code = candidate;
    }
    if (!code) throw new Error("could not allocate a referral code");
    return {
      eligible: true,
      code,
      reward: REFERRAL_REWARD,
      friendDiscount: REFERRAL_FRIEND_DISCOUNT,
      currency: REFERRAL_CURRENCY,
    };
  }

  /** The referrer behind a code, or null. */
  async lookup(code: string): Promise<{ code: string; uid: string } | null> {
    const c = normaliseReferralCode(code);
    if (!/^MC-[A-Z0-9]{4,16}$/.test(c)) return null;
    const snap = await this.db.collection("referral_codes").doc(c).get();
    const uid = snap.exists ? (snap.data()?.uid as string | undefined) : undefined;
    return uid ? { code: c, uid } : null;
  }

  /**
   * Called by the event handler on the friend's first successful charge above
   * $0. Credits the referrer once; safe to call again (retried webhook).
   */
  async rewardForFirstPayment(
    friendUid: string,
    promoCode: string | null | undefined,
  ): Promise<RewardOutcome> {
    if (!promoCode) return "no_referral";
    const ref = await this.lookup(promoCode);
    if (!ref) return "no_referral";
    if (ref.uid === friendUid) return "self_referral";
    const rewardRef = this.db.collection("referral_rewards").doc(friendUid);
    const prior = (await rewardRef.get()).data();
    if (prior && prior.status !== "pending") return "duplicate";
    const base = {
      friendUid,
      referrerUid: ref.uid,
      code: ref.code,
      amount: REFERRAL_REWARD,
      currency: REFERRAL_CURRENCY,
      at: this.clock.nowIso(),
      ...(this.provider ? { livemode: this.provider.livemode } : {}),
    };
    if (!(await this.referrerActive(ref.uid))) {
      await rewardRef.set({ ...base, status: "referrer_inactive" });
      return "referrer_inactive";
    }
    const c = (await this.db.collection("customers").doc(ref.uid).get()).data();
    const sameMode =
      c?.livemode === undefined || c.livemode === this.provider?.livemode;
    if (!c?.customerId || !sameMode || !this.provider?.addCustomerCredit) {
      await rewardRef.set({ ...base, status: "referrer_no_billing_account" });
      return "referrer_no_billing_account";
    }
    // Claim first: a concurrent delivery of the same event sees "pending" and
    // repeats the same idempotent credit call, never a second credit.
    await rewardRef.set({ ...base, status: "pending" });
    await this.provider.addCustomerCredit({
      customerId: String(c.customerId),
      amount: REFERRAL_REWARD,
      currency: REFERRAL_CURRENCY,
      description: `Referral credit: a friend subscribed with your code ${ref.code}`,
      idempotencyKey: `referral-${friendUid}`,
    });
    await rewardRef.set(
      { status: "credited", creditedAt: this.clock.nowIso() },
      { merge: true },
    );
    this.logger.log(`referral credit for ${ref.uid} (friend ${friendUid})`);
    return "credited";
  }
}
