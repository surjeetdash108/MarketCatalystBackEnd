import {
  ConflictException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Optional,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { CurrentUser } from "../common/current-user.decorator";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { Public } from "../common/public.decorator";
import {
  lowestPlanFor,
  ENTITLEMENTS,
  PLAN_DEFINITIONS,
} from "../plans/plans.registry";
import { SubscriptionsService } from "../plans/subscriptions.service";
import { BillingAccessService } from "./billing-access.service";
import { BillingEventsService } from "./billing-events.service";
import { BillingService } from "./billing.service";
import {
  ChangePlanDto,
  CheckoutDto,
  CheckoutPreviewDto,
  ContactDto,
  PlanTargetDto,
  PromoPreviewDto,
} from "./billing.dto";
import { RetentionService } from "./retention/retention.service";
import { RefundService } from "./refund/refund.service";
import { PromoService } from "./promo/promo.service";
import { AuthToken, type AuthTokenInfo } from "../common/auth-token";
import { StaffAccessService } from "../account/staff-access.service";
import { isLifetimeElite } from "../plans/lifetime-elite";
import {
  CheckoutPreviewInterceptor,
  inCheckoutPreview,
} from "./checkout-preview";

function clientIp(req: Request): string | null {
  const fwd = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")[0]
    .trim();
  return fwd || req.ip || null;
}

/** Self-service billing for the signed-in user. */
@Controller("api/billing")
@UseGuards(FirebaseAuthGuard)
@UseInterceptors(CheckoutPreviewInterceptor)
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly retention: RetentionService,
    private readonly firebase: FirebaseAdminService,
    private readonly staff: StaffAccessService,
    private readonly refunds: RefundService,
    @Optional() private readonly access?: BillingAccessService,
  ) {}

  /**
   * Staff have full access and are never billed: no checkout, plan change or
   * retention — except in test mode or staff checkout preview, where staff
   * run the real flow in Stripe test mode.
   */
  private async refuseStaff(token: AuthTokenInfo | undefined): Promise<void> {
    const prov = this.access?.configuredProvider;
    if (inCheckoutPreview() || (prov && !prov.livemode)) return;
    if (await this.staff.isStaff(token)) {
      throw new ConflictException({
        statusCode: 409,
        code: "staff_access",
        message: "Staff accounts have full access and are never billed.",
      });
    }
    if (isLifetimeElite(token?.email)) {
      throw new ConflictException({
        statusCode: 409,
        code: "lifetime_elite",
        message: "Your account has complimentary lifetime Elite access and is never billed.",
      });
    }
  }

  private async email(uid: string): Promise<string | null> {
    try {
      return (await this.firebase.auth.getUser(uid)).email ?? null;
    } catch {
      return null;
    }
  }

  @Post("checkout")
  @HttpCode(200)
  async checkout(
    @CurrentUser() uid: string,
    @AuthToken() token: AuthTokenInfo | undefined,
    @Body() body: CheckoutDto,
    @Req() req: Request,
  ) {
    await this.refuseStaff(token);
    return this.billing.checkout(
      uid,
      await this.email(uid),
      body,
      clientIp(req),
    );
  }

  @Post("checkout/preview")
  @HttpCode(200)
  async checkoutPreview(
    @CurrentUser() uid: string,
    @AuthToken() token: AuthTokenInfo | undefined,
    @Body() body: CheckoutPreviewDto,
    @Req() req: Request,
  ) {
    await this.refuseStaff(token);
    try {
      const email = await this.email(uid);
      await this.firebase.firestore.collection("abandoned_checkouts").doc(uid).set(
        {
          uid,
          email,
          planId: body.planId,
          interval: body.interval,
          step: "Step 2: Checkout",
          at: new Date().toISOString(),
        },
        { merge: true },
      );
    } catch {
      /* non-blocking */
    }
    return this.billing.checkoutPreview(uid, clientIp(req), body);
  }

  @Get("checkout/:id")
  checkoutStatus(@CurrentUser() uid: string, @Param("id") id: string) {
    return this.billing.checkoutStatus(uid, id);
  }

  @Post("promo/preview")
  @HttpCode(200)
  promoPreview(
    @CurrentUser() uid: string,
    @Body() body: PromoPreviewDto,
    @Req() req: Request,
  ) {
    return this.billing.promoPreview(uid, clientIp(req), body);
  }

  @Post("change/preview")
  @HttpCode(200)
  async previewChange(
    @CurrentUser() uid: string,
    @AuthToken() token: AuthTokenInfo | undefined,
    @Body() body: PlanTargetDto,
  ) {
    await this.refuseStaff(token);
    return this.billing.previewChange(uid, body);
  }

  @Post("change")
  @HttpCode(200)
  async change(
    @CurrentUser() uid: string,
    @AuthToken() token: AuthTokenInfo | undefined,
    @Body() body: ChangePlanDto,
  ) {
    await this.refuseStaff(token);
    return this.billing.changePlan(uid, body);
  }

  @Post("change/keep")
  @HttpCode(200)
  keep(@CurrentUser() uid: string) {
    return this.billing.keepCurrentPlan(uid);
  }

  @Post("cancel")
  @HttpCode(200)
  cancel(@CurrentUser() uid: string) {
    return this.billing.cancel(uid);
  }

  @Post("resume")
  @HttpCode(200)
  resume(@CurrentUser() uid: string) {
    return this.billing.resume(uid);
  }

  @Get("retention")
  async retentionOffer(
    @CurrentUser() uid: string,
    @AuthToken() token: AuthTokenInfo | undefined,
  ) {
    if (await this.staff.isStaff(token))
      return { eligible: false, reason: "staff" };
    return this.retention.offerFor(uid);
  }

  @Post("retention/accept")
  @HttpCode(200)
  async acceptRetention(
    @CurrentUser() uid: string,
    @AuthToken() token: AuthTokenInfo | undefined,
  ) {
    await this.refuseStaff(token);
    return this.retention.accept(uid);
  }

  /** Refund policy check for the Manage Plan button (404 when refunds are off). */
  @Get("refund")
  refundEligibility(@CurrentUser() uid: string) {
    return this.refunds.eligibility(uid);
  }

  @Post("refund")
  @HttpCode(200)
  refund(@CurrentUser() uid: string) {
    return this.refunds.refund(uid, "user");
  }

  @Get("contact")
  contact(@CurrentUser() uid: string) {
    return this.billing.contact(uid);
  }

  @Post("contact")
  @HttpCode(200)
  updateContact(@CurrentUser() uid: string, @Body() body: ContactDto) {
    return this.billing.updateContact(uid, body);
  }

  @Get("summary")
  summary(@CurrentUser() uid: string, @AuthToken() token?: AuthTokenInfo) {
    if (isLifetimeElite(token?.email)) {
      return {
        subscriptionsLive: true,
        paidPlansAvailable: true,
        checkoutPreview: false,
        provider: "none",
        planId: "elite",
        planName: "Elite",
        status: "ACTIVE",
        interval: "annual",
        source: "lifetime",
        creditBalance: 0,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        renewsAt: null,
        endsAt: null,
        inGrace: false,
        graceEndsAt: null,
        scheduledChange: null,
        discount: null,
        nextCharge: null,
        hasBillingAccount: false,
      };
    }
    return this.billing.summary(uid);
  }

  @Get("invoices")
  async invoices(@CurrentUser() uid: string) {
    return { invoices: await this.billing.invoices(uid) };
  }

  @Get("invoices/:id/document")
  async invoiceDocument(
    @CurrentUser() uid: string,
    @Param("id") id: string,
    @Res() res: Response,
  ) {
    const doc = await this.billing.invoiceDocument(uid, id);
    if (doc.kind === "redirect") return res.json({ url: doc.url });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="invoice-${id}.html"`,
    );
    return res.send(doc.html);
  }

  @Get("history")
  async history(@CurrentUser() uid: string) {
    return { history: await this.billing.history(uid) };
  }

  @Post("portal")
  @HttpCode(200)
  portal(@CurrentUser() uid: string) {
    return this.billing.portal(uid);
  }
}

/**
 * Promo check on the signup page, before the account exists. Server-side,
 * one generic error for every rejection, and the same hourly per-IP budget as
 * signed-in checks. It only quotes: the code is applied (and re-validated) at
 * checkout.
 */
@Controller("api/billing")
export class SignupPromoController {
  constructor(private readonly promos: PromoService) {}

  @Public("signup page promo check, before sign-in; rate limited per IP")
  @Post("signup/promo")
  @HttpCode(200)
  check(@Body() body: PromoPreviewDto, @Req() req: Request) {
    return this.promos.preview({
      code: body.code,
      uid: null,
      planId: body.planId,
      interval: body.interval,
      ip: clientIp(req),
    });
  }
}

/** Provider webhooks. Authenticated by the provider signature over the raw body. */
@Controller("api/billing")
export class BillingWebhookController {
  constructor(private readonly events: BillingEventsService) {}

  @Public("provider webhook — authenticated by the signature over the raw body")
  @Post("webhook")
  @HttpCode(200)
  async webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers("stripe-signature") stripeSig?: string,
    @Headers("x-billing-signature") genericSig?: string,
  ) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const result = await this.events.receive(raw, stripeSig ?? genericSig);
    return { received: true, result };
  }
}

/** What the signed-in user's plan includes — the UI renders and gates from this. */
@Controller("api/me")
@UseGuards(FirebaseAuthGuard)
@UseInterceptors(CheckoutPreviewInterceptor)
export class MeEntitlementsController {
  constructor(
    private readonly access: BillingAccessService,
    private readonly subscriptions: SubscriptionsService,
    private readonly staff: StaffAccessService,
  ) {}

  @Get("entitlements")
  async entitlements(
    @CurrentUser() uid: string,
    @AuthToken() token?: AuthTokenInfo,
  ) {
    const live = await this.access.subscriptionsLive();
    if (isLifetimeElite(token?.email)) return this.lifetimeEliteEntitlements(live);
    const effective = await this.subscriptions.forUser(uid);
    if (await this.staff.isStaff(token)) {
      const base = this.staffEntitlements(live);
      return {
        ...base,
        subscriptionPlanId:
          effective.status === "ACTIVE" || effective.status === "TRIALING"
            ? effective.planId
            : null,
      };
    }
    const built = ENTITLEMENTS.filter((e) => !e.unbuilt && !e.staffOnly);
    // Flag off (or no provider): everyone keeps today's access to every built feature.
    const entitlements = Object.fromEntries(
      built.map((e) => [
        e.key,
        live ? effective.entitlements[e.key] === true : true,
      ]),
    );
    const plan = PLAN_DEFINITIONS.find((p) => p.id === effective.planId);
    return {
      subscriptionsEnabled: live,
      paidPlansAvailable: live,
      provider: this.access.providerName,
      subscriptionPlanId:
        effective.status === "ACTIVE" || effective.status === "TRIALING"
          ? effective.planId
          : null,
      planId: effective.planId,
      planName: effective.planName,
      status: effective.status,
      interval: effective.interval,
      cancelAtPeriodEnd: effective.cancelAtPeriodEnd,
      currentPeriodEnd: effective.expiryDate,
      inGrace: effective.inGrace,
      graceEndsAt: effective.graceEndsAt,
      entitlements,
      requiredPlan: Object.fromEntries(
        built.map((e) => [e.key, lowestPlanFor(e.key)?.id ?? null]),
      ),
      hidden: ENTITLEMENTS.filter((e) => e.unbuilt).map((e) => e.key),
      limits: live
        ? (plan?.limits ?? { watchlistTickers: null })
        : { watchlistTickers: null },
    };
  }

  /** Lifetime Elite: every built feature (Elite and above), no limits, never billed. */
  private lifetimeEliteEntitlements(live: boolean) {
    const built = ENTITLEMENTS.filter((e) => !e.unbuilt && !e.staffOnly);
    return {
      subscriptionsEnabled: live,
      paidPlansAvailable: live,
      checkoutPreview: false,
      providerConnected: this.access.providerName !== "none",
      provider: this.access.providerName,
      planId: "elite",
      planName: "Elite",
      status: "ACTIVE",
      interval: "annual",
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
      inGrace: false,
      graceEndsAt: null,
      entitlements: Object.fromEntries(built.map((e) => [e.key, true])),
      requiredPlan: Object.fromEntries(
        built.map((e) => [e.key, lowestPlanFor(e.key)?.id ?? null]),
      ),
      hidden: ENTITLEMENTS.filter((e) => e.unbuilt).map((e) => e.key),
      limits: { watchlistTickers: null },
    };
  }

  /** Staff: every built feature (Elite and above), no limits, never billed, never admin. */
  private staffEntitlements(live: boolean) {
    const built = ENTITLEMENTS.filter((e) => !e.unbuilt && !e.staffOnly);
    const preview = inCheckoutPreview();
    return {
      subscriptionsEnabled: live,
      // In the staff preview the checkout and plan picker open for this account
      // only; entitlements below stay staff (full access) either way.
      paidPlansAvailable: live || preview,
      checkoutPreview: preview && !live,
      providerConnected: this.access.providerName !== "none",
      provider: this.access.providerName,
      staff: true,
      planId: "staff",
      planName: "Staff",
      status: "STAFF",
      interval: null,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
      inGrace: false,
      graceEndsAt: null,
      entitlements: Object.fromEntries(built.map((e) => [e.key, true])),
      requiredPlan: Object.fromEntries(
        built.map((e) => [e.key, lowestPlanFor(e.key)?.id ?? null]),
      ),
      hidden: ENTITLEMENTS.filter((e) => e.unbuilt).map((e) => e.key),
      limits: { watchlistTickers: null },
    };
  }
}

/** Guards fake-only routes: 404 unless the fake provider is active. */
export function assertFake(access: BillingAccessService): void {
  if (access.providerName !== "fake") throw new NotFoundException();
}
