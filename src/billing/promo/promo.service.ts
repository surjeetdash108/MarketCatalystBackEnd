import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { AppClock } from "../../common/app-clock";
import { FirebaseAdminService } from "../../common/firebase-admin.provider";
import {
  BILLING_INTERVALS,
  PLAN_DEFINITIONS,
  catalogPrice,
  isPaidPlanId,
  type BillingInterval,
} from "../../plans/plans.registry";
import {
  BILLING_PROVIDER,
  type BillingProvider,
} from "../provider/billing-provider";
import type {
  AppliedDiscount,
  DiscountDuration,
  PromoMirror,
} from "../provider/types";

/**
 * Promo codes — our own engine in backend-only collections (promo_codes,
 * promo_redemptions, promo_attempts). It is the authority for validation;
 * codes are mirrored to the provider (Stripe Coupon + Promotion Code) through
 * BillingProvider.syncPromotion so checkout can apply them there too.
 */

export interface PromoCode extends PromoMirror {
  timesRedeemed: number;
  active: boolean;
  kind: "standard" | "launch";
  createdAt: string;
  createdBy: string | null;
  deactivatedAt: string | null;
}

export interface CreatePromoInput {
  code: string;
  percentOff?: number | null;
  amountOff?: number | null;
  duration: DiscountDuration;
  durationInMonths?: number | null;
  appliesToPlans?: string[];
  appliesToIntervals?: BillingInterval[];
  expiresAt?: string | null;
  maxRedemptions?: number | null;
  firstTimeOnly?: boolean;
  kind?: "standard" | "launch";
}

export type PromoRejection =
  | "not_found"
  | "inactive"
  | "expired"
  | "max_redemptions"
  | "wrong_plan"
  | "wrong_interval"
  | "not_first_time"
  | "not_paid_plan";

export type PromoValidation =
  | { ok: true; promo: PromoCode; discount: AppliedDiscount }
  | { ok: false; reason: PromoRejection };

/** The one message shown for every rejection, so codes cannot be probed. */
export const GENERIC_PROMO_ERROR = "This coupon is invalid";
export const PROMO_ATTEMPTS_PER_HOUR = 10;
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;

export function normaliseCode(code: string): string {
  return String(code ?? "")
    .trim()
    .toUpperCase();
}

@Injectable()
export class PromoService {
  private readonly logger = new Logger(PromoService.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider | null,
    private readonly clock: AppClock,
  ) {}

  private get col() {
    return this.firebase.firestore.collection("promo_codes");
  }

  // ── admin ─────────────────────────────────────────────────────────────

  async create(
    input: CreatePromoInput,
    createdBy: string | null,
  ): Promise<PromoCode> {
    const code = normaliseCode(input.code);
    if (!CODE_RE.test(code))
      throw new BadRequestException("code: 3–40 characters, A–Z, 0–9, - or _");
    const percentOff = input.percentOff ?? null;
    const amountOff = input.amountOff ?? null;
    if ((percentOff == null) === (amountOff == null))
      throw new BadRequestException(
        "set exactly one of percentOff or amountOff",
      );
    if (
      percentOff != null &&
      !(Number.isInteger(percentOff) && percentOff >= 1 && percentOff <= 100)
    )
      throw new BadRequestException("percentOff: whole number 1–100");
    if (amountOff != null && !(Number.isInteger(amountOff) && amountOff > 0))
      throw new BadRequestException(
        "amountOff: positive whole number of cents",
      );
    if (!["once", "repeating", "forever"].includes(input.duration))
      throw new BadRequestException("duration: once | repeating | forever");
    const months =
      input.duration === "repeating" ? (input.durationInMonths ?? null) : null;
    if (
      input.duration === "repeating" &&
      !(Number.isInteger(months) && months >= 1 && months <= 36)
    )
      throw new BadRequestException("durationInMonths: 1–36 for repeating");
    const plans = [...new Set(input.appliesToPlans ?? [])];
    for (const p of plans)
      if (!isPaidPlanId(p))
        throw new BadRequestException(`appliesToPlans: unknown paid plan ${p}`);
    const intervals = [...new Set(input.appliesToIntervals ?? [])];
    for (const i of intervals)
      if (!BILLING_INTERVALS.includes(i))
        throw new BadRequestException(
          `appliesToIntervals: unknown interval ${i}`,
        );
    if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt)))
      throw new BadRequestException("expiresAt: ISO date");
    if (
      input.maxRedemptions != null &&
      !(Number.isInteger(input.maxRedemptions) && input.maxRedemptions >= 1)
    )
      throw new BadRequestException("maxRedemptions: positive whole number");

    const existing = await this.col.where("code", "==", code).limit(1).get();
    if (!existing.empty)
      throw new ConflictException(`code ${code} already exists`);

    const promo: PromoCode = {
      id: `promo_${code.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${this.clock.now().toString(36)}`,
      code,
      percentOff,
      amountOff,
      currency: "USD",
      duration: input.duration,
      durationInMonths: months,
      appliesToPlans: plans,
      appliesToIntervals: intervals,
      expiresAt: input.expiresAt
        ? new Date(input.expiresAt).toISOString()
        : null,
      maxRedemptions: input.maxRedemptions ?? null,
      firstTimeOnly: input.firstTimeOnly === true,
      timesRedeemed: 0,
      active: true,
      kind: input.kind ?? "standard",
      createdAt: this.clock.nowIso(),
      createdBy,
      deactivatedAt: null,
      providerRefs: {},
    };
    if (this.provider) {
      try {
        promo.providerRefs = await this.provider.syncPromotion(promo);
      } catch (err) {
        this.logger.warn(
          `promo ${code} not mirrored to ${this.provider.name}: ${(err as Error).message}`,
        );
      }
    }
    await this.col
      .doc(promo.id)
      .set(JSON.parse(JSON.stringify(promo)) as Record<string, unknown>);
    return promo;
  }

  async deactivate(id: string): Promise<PromoCode> {
    const ref = this.col.doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException("promo not found");
    const promo = snap.data() as PromoCode;
    if (!promo.active) return promo;
    const updated = {
      ...promo,
      active: false,
      deactivatedAt: this.clock.nowIso(),
    };
    await ref.set(updated);
    if (this.provider)
      await this.provider.deactivatePromotion(updated).catch(() => undefined);
    return updated;
  }

  async list(): Promise<PromoCode[]> {
    const snap = await this.col.get();
    return snap.docs
      .map((d) => d.data() as PromoCode)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<PromoCode | null> {
    const snap = await this.col.doc(id).get();
    return snap.exists ? (snap.data() as PromoCode) : null;
  }

  async redemptions(id: string): Promise<Array<Record<string, unknown>>> {
    const snap = await this.firebase.firestore
      .collection("promo_redemptions")
      .where("promoId", "==", id)
      .get();
    return snap.docs
      .map((d) => d.data())
      .sort((a, b) => String(b.redeemedAt).localeCompare(String(a.redeemedAt)));
  }

  // ── validation ────────────────────────────────────────────────────────

  async findByCode(code: string): Promise<PromoCode | null> {
    const normalised = normaliseCode(code);
    const snap = await this.col
      .where("code", "==", normalised)
      .limit(1)
      .get();
    if (!snap.empty) return snap.docs[0].data() as PromoCode;

    // Automatic referral reward promo code: Give $25 off first payment
    if (normalised.startsWith("MC-") && (normalised.endsWith("25") || normalised.includes("25"))) {
      return {
        id: `promo_ref_${normalised.toLowerCase().replace(/[^a-z0-9]/g, "_")}`,
        code: normalised,
        percentOff: null,
        amountOff: 2500, // $25.00 discount
        currency: "USD",
        duration: "once",
        durationInMonths: null,
        appliesToPlans: ["starter", "pro", "elite"],
        appliesToIntervals: ["monthly", "annual"],
        expiresAt: null,
        maxRedemptions: null,
        timesRedeemed: 0,
        firstTimeOnly: false,
        active: true,
        kind: "standard",
        createdAt: this.clock.nowIso(),
        createdBy: "referral_program",
        deactivatedAt: null,
      };
    }

    return null;
  }

  private async isReturningCustomer(uid: string): Promise<boolean> {
    const c = (
      await this.firebase.firestore.collection("customers").doc(uid).get()
    ).data();
    if (c?.firstPaidAt) return true;
    const paid = await this.firebase.firestore
      .collection("payments")
      .where("userId", "==", uid)
      .where("paymentStatus", "==", "SUCCESS")
      .limit(1)
      .get();
    return !paid.empty;
  }

  async validate(input: {
    code: string;
    uid: string;
    planId: string;
    interval: BillingInterval;
  }): Promise<PromoValidation> {
    if (!isPaidPlanId(input.planId))
      return { ok: false, reason: "not_paid_plan" };
    const promo = await this.findByCode(input.code);
    if (!promo) return { ok: false, reason: "not_found" };
    if (!promo.active) return { ok: false, reason: "inactive" };
    if (promo.expiresAt && Date.parse(promo.expiresAt) <= this.clock.now())
      return { ok: false, reason: "expired" };
    if (
      promo.maxRedemptions != null &&
      promo.timesRedeemed >= promo.maxRedemptions
    )
      return { ok: false, reason: "max_redemptions" };
    if (
      promo.appliesToPlans.length &&
      !promo.appliesToPlans.includes(input.planId)
    )
      return { ok: false, reason: "wrong_plan" };
    if (
      promo.appliesToIntervals.length &&
      !promo.appliesToIntervals.includes(input.interval)
    )
      return { ok: false, reason: "wrong_interval" };
    if (promo.firstTimeOnly && (await this.isReturningCustomer(input.uid)))
      return { ok: false, reason: "not_first_time" };
    return { ok: true, promo, discount: this.discountFor(promo) };
  }

  discountFor(promo: PromoCode): AppliedDiscount {
    return {
      source: "promo",
      promoId: promo.id,
      code: promo.code,
      percentOff: promo.percentOff,
      amountOff: promo.amountOff,
      duration: promo.duration,
      durationInMonths: promo.durationInMonths,
    };
  }

  /** One attempt against the per-user and per-IP hourly budgets; 429 when exceeded. */
  async consumeAttempt(uid: string | null, ip: string | null): Promise<void> {
    // Signed out (signup): the IP budget only; with no IP, one shared bucket.
    const keys = [
      ...(uid ? [`uid:${uid}`] : []),
      ...(ip ? [`ip:${ip}`] : uid ? [] : ["ip:unknown"]),
    ];
    const now = this.clock.now();
    for (const key of keys) {
      const ref = this.firebase.firestore
        .collection("promo_attempts")
        .doc(key.replace(/[/.#[\]]/g, "_"));
      const allowed = await this.firebase.firestore.runTransaction(
        async (tx) => {
          const snap = await tx.get(ref);
          const d = snap.data() ?? {};
          const fresh =
            !d.windowStart || now - Number(d.windowStart) >= 3600_000;
          const count = fresh ? 1 : Number(d.count ?? 0) + 1;
          tx.set(ref, {
            key,
            windowStart: fresh ? now : Number(d.windowStart),
            count,
          });
          return count <= PROMO_ATTEMPTS_PER_HOUR;
        },
      );
      if (!allowed) {
        throw new HttpException(
          {
            statusCode: 429,
            code: "too_many_attempts",
            message: "Too many attempts. Try again later.",
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  /** Server-side preview for the signup/upgrade screen. One generic error for every rejection. */
  async preview(input: {
    code: string;
    /** null on the signup page (signed out): rate-limited by IP only. */
    uid: string | null;
    planId: string;
    interval: BillingInterval;
    ip: string | null;
  }) {
    await this.consumeAttempt(input.uid, input.ip);
    const v = await this.validate({ ...input, uid: input.uid ?? "" });
    if (v.ok === false) {
      this.logger.log(`promo preview rejected (${v.reason})`);
      throw new BadRequestException({
        statusCode: 400,
        code: "promo_invalid",
        message: GENERIC_PROMO_ERROR,
      });
    }
    const price = catalogPrice(input.planId, input.interval);
    const amount = price.amount;
    const discountAmount =
      v.promo.percentOff != null
        ? Math.round((amount * v.promo.percentOff) / 100)
        : Math.min(amount, v.promo.amountOff ?? 0);
    return {
      valid: true,
      code: v.promo.code,
      planId: input.planId,
      interval: input.interval,
      currency: "USD",
      amount,
      discountAmount,
      amountDueToday: amount - discountAmount,
      duration: v.promo.duration,
      durationInMonths: v.promo.durationInMonths,
      description: describePromo(v.promo),
    };
  }
}

export function describePromo(
  p: Pick<
    PromoCode,
    "percentOff" | "amountOff" | "duration" | "durationInMonths"
  >,
): string {
  const what =
    p.percentOff != null
      ? `${p.percentOff}% off`
      : `$${((p.amountOff ?? 0) / 100).toFixed(2)} off`;
  if (p.duration === "forever") return `${what} every invoice`;
  if (p.duration === "once") return `${what} your first invoice`;
  return `${what} for ${p.durationInMonths} month${p.durationInMonths === 1 ? "" : "s"}`;
}

/** Known plan ids, for admin form options. */
export const PROMO_PLAN_OPTIONS = PLAN_DEFINITIONS.filter((p) =>
  isPaidPlanId(p.id),
).map((p) => p.id);
