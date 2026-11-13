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
 *   - A friend who signs up from the link is attributed to the referrer
 *     (referral_attributions/{friendUid}, first code wins) — only as a
 *     first-time customer, never with their own code. Typing the code at
 *     checkout attributes the same way. There is no discount: the friend
 *     pays the full price the first time.
 *   - When the friend's first real charge succeeds (above $0, not a free
 *     trial), BOTH get account credit (Stripe customer balance, used on their
 *     next invoices): the friend REFERRAL_FRIEND_CREDIT, the referrer
 *     REFERRAL_REWARD while they still have an active plan. Once per friend
 *     (referral_rewards/{friendUid}); the credit calls are idempotent.
 */
export const REFERRAL_REWARD = 2500;
export const REFERRAL_FRIEND_CREDIT = 2500;
/** @deprecated The friend now gets credit after paying, not a discount. */
export const REFERRAL_FRIEND_DISCOUNT = REFERRAL_FRIEND_CREDIT;
export const REFERRAL_CURRENCY = "USD";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type ReferralCodeResult =
  | {
      eligible: true;
      code: string;
      reward: number;
      /** Always 0: the friend pays full price, then gets friendCredit. */
      friendDiscount: number;
      friendCredit: number;
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

export type ClaimOutcome =
  | "claimed"
  | "already_claimed"
  | "invalid"
  | "self_referral"
  | "not_first_time";

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
      friendDiscount: 0,
      friendCredit: REFERRAL_FRIEND_CREDIT,
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
   * Attribute a new user to whoever referred them (signup from the link, or
   * the code typed at checkout). First code wins; the same code again is fine.
   */
  async claim(friendUid: string, code: string): Promise<ClaimOutcome> {
    const ref = await this.lookup(code);
    if (!ref) return "invalid";
    if (!friendUid || ref.uid === friendUid) return "self_referral";
    const attrRef = this.db.collection("referral_attributions").doc(friendUid);
    const prior = (await attrRef.get()).data();
    if (prior) return prior.code === ref.code ? "already_claimed" : "invalid";
    const [cust, sub] = await Promise.all([
      this.db.collection("customers").doc(friendUid).get(),
      this.db.collection("subscriptions").doc(friendUid).get(),
    ]);
    // New customers only: never paid and never had a subscription.
    if (cust.data()?.firstPaidAt || sub.exists) return "not_first_time";
    const created = await this.db.runTransaction(async (tx) => {
      if ((await tx.get(attrRef)).exists) return false;
      tx.set(attrRef, {
        friendUid,
        referrerUid: ref.uid,
        code: ref.code,
        at: this.clock.nowIso(),
      });
      return true;
    });
    return created ? "claimed" : "already_claimed";
  }

  /** The code this user was referred with, if any. */
  async attributedCode(friendUid: string): Promise<string | null> {
    const d = (await this.db.collection("referral_attributions").doc(friendUid).get()).data();
    return d?.code ? String(d.code) : null;
  }

  /** Credit a member's billing account; false when they have none (in this mode). */
  private async credit(
    uid: string,
    amount: number,
    description: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const c = (await this.db.collection("customers").doc(uid).get()).data();
    const sameMode =
      c?.livemode === undefined || c.livemode === this.provider?.livemode;
    if (!c?.customerId || !sameMode || !this.provider?.addCustomerCredit)
      return false;
    await this.provider.addCustomerCredit({
      customerId: String(c.customerId),
      amount,
      currency: REFERRAL_CURRENCY,
      description,
      idempotencyKey,
    });
    return true;
  }

  /**
   * Called by the event handler on the friend's first successful charge above
   * $0. Credits the friend and the referrer once each; safe to call again
   * (retried webhook). The referral comes from the attribution made at
   * signup, else from a code used at checkout.
   */
  async rewardForFirstPayment(
    friendUid: string,
    promoCode: string | null | undefined,
  ): Promise<RewardOutcome> {
    const code = (await this.attributedCode(friendUid)) ?? promoCode;
    if (!code) return "no_referral";
    const ref = await this.lookup(code);
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
      friendAmount: REFERRAL_FRIEND_CREDIT,
      currency: REFERRAL_CURRENCY,
      at: this.clock.nowIso(),
      ...(this.provider ? { livemode: this.provider.livemode } : {}),
    };
    // Claim first: a concurrent delivery of the same event sees "pending" and
    // repeats the same idempotent credit calls, never a second credit.
    await rewardRef.set({ ...base, status: "pending" });
    const friendCredited = await this.credit(
      friendUid,
      REFERRAL_FRIEND_CREDIT,
      `Referral credit: thanks for joining with code ${ref.code}`,
      `referral-friend-${friendUid}`,
    );
    let status: RewardOutcome;
    if (!(await this.referrerActive(ref.uid))) status = "referrer_inactive";
    else
      status = (await this.credit(
        ref.uid,
        REFERRAL_REWARD,
        `Referral credit: a friend subscribed with your code ${ref.code}`,
        `referral-${friendUid}`,
      ))
        ? "credited"
        : "referrer_no_billing_account";
    await rewardRef.set({
      ...base,
      status,
      friendStatus: friendCredited ? "credited" : "no_billing_account",
      creditedAt: this.clock.nowIso(),
    });
    this.logger.log(
      `referral for friend ${friendUid}: referrer ${status}, friend ${friendCredited ? "credited" : "not credited"}`,
    );
    return status;
  }
}
