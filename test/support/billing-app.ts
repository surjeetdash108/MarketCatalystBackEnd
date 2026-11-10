import { CheckoutPreviewService } from "../../src/billing/checkout-preview";
/**
 * A Nest app with the real billing controllers and services over
 * FakeFirestore + FakeBillingProvider + a frozen AppClock. Auth is replaced by
 * headers: `x-test-uid` (signed-in user) and `x-test-admin` (admin email).
 * Test support only.
 */
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AdminGuard } from "../../src/common/admin.guard";
import { AdminAuditInterceptor } from "../../src/common/admin-audit.interceptor";
import { AppClock } from "../../src/common/app-clock";
import { FirebaseAdminService } from "../../src/common/firebase-admin.provider";
import { FirebaseAuthGuard } from "../../src/common/firebase-auth.guard";
import { SyncRegistry } from "../../src/common/sync-registry.service";
import { createGlobalValidationPipe } from "../../src/common/validation";
import { FeatureFlagsService } from "../../src/feature-flags/feature-flags.service";
import { PlansService } from "../../src/plans/plans.service";
import { SubscriptionsService } from "../../src/plans/subscriptions.service";
import { AdminBillingController } from "../../src/billing/admin-billing.controller";
import { AdminBillingService } from "../../src/billing/admin-billing.service";
import { BillingAccessService } from "../../src/billing/billing-access.service";
import { BillingEventsService } from "../../src/billing/billing-events.service";
import {
  BillingController,
  BillingWebhookController,
  MeEntitlementsController,
} from "../../src/billing/billing.controller";
import { BillingService } from "../../src/billing/billing.service";
import {
  ConsoleEmailSender,
  EMAIL_SENDER,
} from "../../src/billing/email/email-sender";
import { EmailService } from "../../src/billing/email/email.service";
import { FakeBillingController } from "../../src/billing/fake-billing.controller";
import { PromoService } from "../../src/billing/promo/promo.service";
import { BILLING_PROVIDER } from "../../src/billing/provider/billing-provider";
import { FakeBillingProvider } from "../../src/billing/provider/fake/fake-billing.provider";
import { BillingReconcileJob } from "../../src/billing/reconcile.job";
import { RetentionService } from "../../src/billing/retention/retention.service";
import { FakeAuth, T0, configOf } from "./billing-harness";
import type { AuthTokenInfo } from "../../src/common/auth-token";
import { CONSENT_VERSION } from "../../src/billing/checkout/consent";
import {
  REFUND_WINDOW,
  RefundService,
} from "../../src/billing/refund/refund.service";
import { EmailVerificationService } from "../../src/account/email-verification.service";
import { StaffAccessService } from "../../src/account/staff-access.service";
import { AdminStaffController } from "../../src/account/admin-staff.controller";
import { AccountController } from "../../src/account/account.controller";
import { FakeFirestore } from "./fake-firestore";

/** Test auth: `x-test-uid` header; the token info mirrors the FakeAuth record (as a fresh ID token would). */
let currentAuth: FakeAuth | null = null;
class HeaderAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string>;
      uid?: string;
      authToken?: AuthTokenInfo;
    }>();
    const uid = req.headers["x-test-uid"];
    if (!uid) return false;
    req.uid = uid;
    const u = currentAuth?.users.get(uid);
    req.authToken = {
      uid,
      email: u?.email ?? null,
      emailVerified: u?.emailVerified === true,
      claims: { ...(u?.customClaims ?? {}) },
      signInProvider: u?.provider ?? "password",
    };
    return true;
  }
}

class HeaderAdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; adminActor?: string }>();
    if (!req.headers["x-test-admin"]) return false;
    req.adminActor = req.headers["x-test-admin"];
    return true;
  }
}

/** A complete checkout v2 body (consent, phone, billing address in Oregon (no sales tax)). */
export function checkoutBody(
  planId: string,
  interval: "monthly" | "annual",
  over: Record<string, unknown> = {},
) {
  return {
    planId,
    interval,
    consent: { accepted: true, version: CONSENT_VERSION },
    phone: "+15125550147",
    marketingOptIn: false,
    billing: {
      name: "Test Buyer",
      address: {
        line1: "1 Main St",
        line2: null,
        city: "Portland",
        state: "OR",
        postalCode: "97201",
        country: "US",
      },
    },
    ...over,
  };
}

export interface BillingAppOptions {
  env?: Record<string, string | undefined>;
  /** false = no provider configured. */
  provider?: boolean;
  /** Test-only override of REFUND_WINDOW_DAYS (0 = refunds off). */
  refundWindowDays?: number;
  /** true = the provider runs in test mode (records carry livemode:false). */
  testMode?: boolean;
}

export async function billingApp(opts: BillingAppOptions = {}) {
  const fs = new FakeFirestore();
  const auth = new FakeAuth();
  currentAuth = auth;
  const firebase = { firestore: fs, auth } as unknown as FirebaseAdminService;
  const clock = new AppClock();
  const env = {
    APP_URL: "http://app.test",
    FIREBASE_PROJECT_ID: "demo-billing",
    ...(opts.env ?? {}),
  };
  const config = configOf(env);
  const provider =
    opts.provider === false
      ? null
      : new FakeBillingProvider(firebase, clock, {
          appUrl: "http://app.test",
          livemode: opts.testMode !== true,
        });
  if (provider) clock.freeze(T0);
  const sender = new ConsoleEmailSender();

  const moduleRef = await Test.createTestingModule({
    controllers: [
      BillingController,
      BillingWebhookController,
      MeEntitlementsController,
      FakeBillingController,
      AdminBillingController,
      AccountController,
      AdminStaffController,
    ],
    providers: [
      { provide: FirebaseAdminService, useValue: firebase },
      { provide: ConfigService, useValue: config },
      { provide: AppClock, useValue: clock },
      { provide: BILLING_PROVIDER, useValue: provider },
      { provide: EMAIL_SENDER, useValue: sender },
      { provide: FirebaseAuthGuard, useClass: HeaderAuthGuard },
      { provide: AdminGuard, useClass: HeaderAdminGuard },
      { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor },
      SyncRegistry,
      FeatureFlagsService,
      BillingAccessService,
      EmailService,
      PlansService,
      SubscriptionsService,
      BillingEventsService,
      BillingService,
      PromoService,
      RetentionService,
      AdminBillingService,
      BillingReconcileJob,
      EmailVerificationService,
      StaffAccessService,
      RefundService,
      CheckoutPreviewService,
      ...(opts.refundWindowDays !== undefined
        ? [{ provide: REFUND_WINDOW, useValue: opts.refundWindowDays }]
        : []),
    ],
  })
    .overrideGuard(FirebaseAuthGuard)
    .useClass(HeaderAuthGuard)
    .overrideGuard(AdminGuard)
    .useClass(HeaderAdminGuard)
    .compile();

  const app: INestApplication = moduleRef.createNestApplication();
  app.useGlobalPipes(createGlobalValidationPipe());
  await app.init();
  const server = app.getHttpServer();

  const as = (uid: string) => ({
    get: (url: string) => request(server).get(url).set("x-test-uid", uid),
    post: (url: string, body?: object) =>
      request(server)
        .post(url)
        .set("x-test-uid", uid)
        .send(body ?? {}),
  });
  const admin = {
    get: (url: string) =>
      request(server).get(url).set("x-test-admin", "admin@example.com"),
    post: (url: string, body?: object) =>
      request(server)
        .post(url)
        .set("x-test-admin", "admin@example.com")
        .send(body ?? {}),
    delete: (url: string) =>
      request(server).delete(url).set("x-test-admin", "admin@example.com"),
  };

  /** Signs up a user (auth record + email) the way the app would. */
  function user(
    uid: string,
    email = `${uid}@example.com`,
    opts: { emailVerified?: boolean; provider?: string } = {},
  ) {
    auth.add(uid, email, opts);
    return as(uid);
  }

  /** Full paid signup through the app API and the fake hosted checkout. */
  async function subscribe(
    uid: string,
    planId: string,
    interval: "monthly" | "annual",
    card = "success",
    promoCode?: string,
    email?: string,
  ) {
    const u = auth.users.has(uid) ? as(uid) : user(uid, email);
    const co = await u.post("/api/billing/checkout", {
      ...checkoutBody(planId, interval),
      ...(promoCode ? { promoCode } : {}),
    });
    if (co.status !== 200) return { checkout: co, complete: null, u };
    const complete = await u.post(
      `/api/billing/fake/checkout/${co.body.sessionId}/complete`,
      { card },
    );
    return { checkout: co, complete, u };
  }

  async function advanceDays(days: number) {
    return admin.post("/api/billing/fake/clock/advance", { days });
  }

  return {
    app,
    server,
    fs,
    auth,
    clock,
    provider: provider as FakeBillingProvider,
    sender,
    flags: moduleRef.get(FeatureFlagsService),
    events: moduleRef.get(BillingEventsService),
    reconcile: moduleRef.get(BillingReconcileJob),
    as,
    user,
    admin,
    subscribe,
    advanceDays,
    tags: () => sender.outbox.map((m) => m.tag),
    close: () => app.close(),
  };
}
