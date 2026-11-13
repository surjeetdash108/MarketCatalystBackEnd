/**
 * Wires the real billing services together over FakeFirestore, a frozen
 * AppClock and FakeBillingProvider, with an in-memory Firebase Auth stand-in.
 * Test support only.
 */
import type { ConfigService } from "@nestjs/config";
import { AppClock } from "../../src/common/app-clock";
import type { FirebaseAdminService } from "../../src/common/firebase-admin.provider";
import { PlansService } from "../../src/plans/plans.service";
import { SubscriptionsService } from "../../src/plans/subscriptions.service";
import {
  catalogPrice,
  type BillingInterval,
} from "../../src/plans/plans.registry";
import { ConsoleEmailSender } from "../../src/billing/email/email-sender";
import { EmailService } from "../../src/billing/email/email.service";
import { BillingEventsService } from "../../src/billing/billing-events.service";
import {
  FakeBillingProvider,
  type FakeCardBehavior,
} from "../../src/billing/provider/fake/fake-billing.provider";
import type { PriceRef } from "../../src/billing/provider/types";
import { FakeFirestore } from "./fake-firestore";

export const T0 = Date.parse("2026-11-10T12:00:00Z");
export const DAY = 86_400_000;

export class FakeAuth {
  readonly users = new Map<
    string,
    {
      uid: string;
      email: string | null;
      customClaims: Record<string, unknown>;
      emailVerified?: boolean;
      provider?: string;
      metadata?: { creationTime?: string };
    }
  >();
  add(
    uid: string,
    email: string | null,
    opts: { emailVerified?: boolean; provider?: string } = {},
  ) {
    this.users.set(uid, {
      uid,
      email,
      customClaims: {},
      emailVerified: opts.emailVerified ?? true,
      provider: opts.provider ?? "password",
    });
  }
  updateUser(uid: string, patch: { emailVerified?: boolean; email?: string }) {
    const u = this.users.get(uid);
    if (!u) return Promise.reject(new Error("auth/user-not-found"));
    Object.assign(u, patch);
    return Promise.resolve(u);
  }
  getUser(uid: string) {
    const u = this.users.get(uid);
    return u
      ? Promise.resolve(u)
      : Promise.reject(new Error("auth/user-not-found"));
  }
  deleteUser(uid: string) {
    if (!this.users.delete(uid)) return Promise.reject(Object.assign(new Error("auth/user-not-found"), { code: "auth/user-not-found" }));
    return Promise.resolve();
  }
  setCustomUserClaims(uid: string, claims: Record<string, unknown>) {
    const u = this.users.get(uid);
    if (!u) return Promise.reject(new Error("auth/user-not-found"));
    u.customClaims = { ...claims };
    return Promise.resolve();
  }
  claim(uid: string): unknown {
    return this.users.get(uid)?.customClaims.plan;
  }
}

export function configOf(
  env: Record<string, string | undefined> = {},
): ConfigService {
  return {
    get: (k: string, d?: unknown) => env[k] ?? d,
  } as unknown as ConfigService;
}

export function priceRef(planId: string, interval: BillingInterval): PriceRef {
  const p = catalogPrice(planId, interval);
  return {
    planId,
    interval,
    amount: p.amount,
    currency: "USD",
    lookupKey: p.lookupKey,
  };
}

export function billingHarness(env: Record<string, string | undefined> = {}) {
  const fs = new FakeFirestore();
  const auth = new FakeAuth();
  const firebase = { firestore: fs, auth } as unknown as FirebaseAdminService;
  const clock = new AppClock();
  const config = configOf({ APP_URL: "http://app.test", ...env });
  const provider = new FakeBillingProvider(firebase, clock, {
    appUrl: "http://app.test",
  });
  clock.freeze(T0);
  const plans = new PlansService(firebase);
  const subscriptions = new SubscriptionsService(firebase, plans, clock);
  const sender = new ConsoleEmailSender();
  const emails = new EmailService(sender, config);
  const events = new BillingEventsService(
    firebase,
    provider,
    subscriptions,
    emails,
    clock,
  );
  events.onModuleInit();

  /** Buys a plan through the fake hosted checkout (no app checkout endpoint involved). */
  async function buy(
    uid: string,
    planId: string,
    interval: BillingInterval,
    card: FakeCardBehavior = "success",
    email = `${uid}@example.com`,
  ) {
    if (!auth.users.has(uid)) auth.add(uid, email);
    const { customerId } = await provider.createCustomer({ uid, email });
    const session = await provider.createCheckout({
      uid,
      customerId,
      price: priceRef(planId, interval),
      discount: null,
      successUrl:
        "http://app.test/billing/success?session={CHECKOUT_SESSION_ID}",
      cancelUrl: "http://app.test/manage-plan",
      idempotencyKey: `${uid}-${planId}-${interval}-${clock.now()}`,
    });
    const done = await provider.completeCheckout(session.id, card);
    return { customerId, session, done, subscriptionId: done.subscriptionId };
  }

  return {
    fs,
    auth,
    firebase,
    clock,
    config,
    provider,
    plans,
    subscriptions,
    sender,
    emails,
    events,
    buy,
    tags: () => sender.outbox.map((m) => m.tag),
  };
}
