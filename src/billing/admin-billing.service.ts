import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AppClock } from "../common/app-clock";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import {
  catalogPrice,
  planById,
  type BillingInterval,
} from "../plans/plans.registry";
import {
  SubscriptionsService,
  type SubscriptionMirror,
} from "../plans/subscriptions.service";
import { EmailService } from "./email/email.service";

/**
 * Admin read-models over the billing collections. Revenue and MRR come only
 * from payments (the event handler's record of money received); plan and
 * status come from the subscriptions mirror, never from user documents.
 */

export interface SubscriberRow {
  uid: string;
  name: string | null;
  email: string | null;
  planId: string;
  planName: string;
  interval: string | null;
  status: string;
  source: string | null;
  startedAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  promoCode: string | null;
  retentionUsed: boolean;
  mrrMinor: number;
}

export interface SubscriberFilter {
  q?: string;
  plan?: string;
  status?: string;
  interval?: string;
  cancelAtPeriodEnd?: string;
  promo?: string;
}

const DAY = 86_400_000;

function periodEnd(iso: unknown): number {
  if (typeof iso !== "string" || !iso) return NaN;
  return Date.parse(iso.length === 10 ? `${iso}T23:59:59Z` : iso);
}

/** MRR per user from SUCCESS payments covering `now` (annual ÷ 12), minor units. */
export function mrrByUser(
  payments: Array<Record<string, unknown>>,
  now: number,
): Map<string, number> {
  const latest = new Map<string, Record<string, unknown>>();
  for (const p of payments) {
    const uid = typeof p.userId === "string" ? p.userId : null;
    if (
      !uid ||
      p.paymentStatus !== "SUCCESS" ||
      p.billingReason === "subscription_update"
    )
      continue;
    const end = periodEnd(p.subscriptionExpiryDate);
    if (!Number.isFinite(end) || end < now) continue;
    const prev = latest.get(uid);
    if (!prev || String(p.paymentDate ?? "") > String(prev.paymentDate ?? ""))
      latest.set(uid, p);
  }
  const out = new Map<string, number>();
  for (const [uid, p] of latest) {
    // Use the catalog price for the paid plan/interval: a discounted first
    // invoice is real revenue but not the recurring amount.
    const interval = String(p.billingCycle ?? "monthly") as BillingInterval;
    const amount = typeof p.amount === "number" ? p.amount : 0;
    out.set(uid, interval === "annual" ? Math.round(amount / 12) : amount);
  }
  return out;
}

export function toCsv(rows: SubscriberRow[]): string {
  const cols: Array<keyof SubscriberRow> = [
    "uid",
    "name",
    "email",
    "planId",
    "interval",
    "status",
    "startedAt",
    "currentPeriodEnd",
    "cancelAtPeriodEnd",
    "promoCode",
    "retentionUsed",
    "mrrMinor",
  ];
  const cell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (
    [
      cols.join(","),
      ...rows.map((r) => cols.map((c) => cell(r[c])).join(",")),
    ].join("\n") + "\n"
  );
}

@Injectable()
export class AdminBillingService {
  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly subscriptions: SubscriptionsService,
    private readonly emails: EmailService,
    private readonly clock: AppClock,
  ) {}

  private async all(
    col: string,
    limit = 5000,
  ): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
    const snap = await this.firebase.firestore
      .collection(col)
      .limit(limit)
      .get();
    return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  }

  async subscribers(filter: SubscriberFilter = {}): Promise<SubscriberRow[]> {
    const [users, mirrors, payments, retention] = await Promise.all([
      this.all("users"),
      this.all("subscriptions"),
      this.all("payments"),
      this.all("retention_offers"),
    ]);
    const mirrorBy = new Map(
      mirrors.map((m) => [
        m.id,
        m.data as unknown as SubscriptionMirror & Record<string, unknown>,
      ]),
    );
    const mrr = mrrByUser(
      payments.map((p) => p.data),
      this.clock.now(),
    );
    const retainedUids = new Set(retention.map((r) => String(r.data.uid)));
    const uids = new Set([
      ...users.map((u) => u.id),
      ...mirrors.map((m) => m.id),
    ]);
    const userBy = new Map(users.map((u) => [u.id, u.data]));
    const rows: SubscriberRow[] = [];
    for (const uid of uids) {
      const u = userBy.get(uid) ?? {};
      const m = mirrorBy.get(uid) ?? null;
      const eff = await this.subscriptions.resolve(uid, u, m);
      rows.push({
        uid,
        name: (u.name as string) ?? null,
        email: (u.email as string) ?? null,
        planId: eff.planId,
        planName: eff.planName,
        interval: m?.interval ?? null,
        status: eff.status,
        source: m?.source ?? null,
        startedAt: m?.startedAt ?? null,
        currentPeriodEnd: m?.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: m?.cancelAtPeriodEnd === true,
        promoCode: (m?.promoCode as string) ?? null,
        retentionUsed: retainedUids.has(uid),
        mrrMinor: mrr.get(uid) ?? 0,
      });
    }
    const q = (filter.q ?? "").trim().toLowerCase();
    return rows
      .filter(
        (r) =>
          !q ||
          `${r.name ?? ""} ${r.email ?? ""} ${r.uid}`.toLowerCase().includes(q),
      )
      .filter((r) => !filter.plan || r.planId === filter.plan)
      .filter((r) => !filter.status || r.status === filter.status.toUpperCase())
      .filter((r) => !filter.interval || r.interval === filter.interval)
      .filter(
        (r) =>
          filter.cancelAtPeriodEnd == null ||
          String(r.cancelAtPeriodEnd) === filter.cancelAtPeriodEnd,
      )
      .filter(
        (r) =>
          !filter.promo ||
          (r.promoCode ?? "").toUpperCase() === filter.promo.toUpperCase(),
      )
      .sort(
        (a, b) =>
          b.mrrMinor - a.mrrMinor ||
          String(a.email).localeCompare(String(b.email)),
      );
  }

  async subscriber(uid: string) {
    const row = (await this.subscribers()).find((r) => r.uid === uid);
    if (!row) throw new NotFoundException("subscriber not found");
    const [payments, history, effective, mirror] = await Promise.all([
      this.firebase.firestore
        .collection("payments")
        .where("userId", "==", uid)
        .get(),
      this.firebase.firestore
        .collection("subscription_events")
        .where("uid", "==", uid)
        .get(),
      this.subscriptions.forUser(uid),
      this.firebase.firestore.collection("subscriptions").doc(uid).get(),
    ]);
    return {
      ...row,
      mirror: mirror.exists ? mirror.data() : null,
      invoices: payments.docs
        .map((d) => d.data())
        .sort((a, b) =>
          String(b.paymentDate).localeCompare(String(a.paymentDate)),
        ),
      history: history.docs
        .map((d) => d.data())
        .sort((a, b) => String(b.at).localeCompare(String(a.at))),
      entitlements: effective.entitlements,
    };
  }

  async audit(limit = 200) {
    const snap = await this.firebase.firestore
      .collection("admin_audit")
      .orderBy("at", "desc")
      .limit(Math.min(Math.max(limit, 1), 1000))
      .get();
    return snap.docs.map((d) => d.data());
  }

  /** Sends the 30-day price-change notice (Terms §12) to everyone on that plan/interval. */
  async priceChangeNotice(input: {
    planId: string;
    interval: BillingInterval;
    newAmount: number;
    effectiveAt: string;
  }) {
    const current = catalogPrice(input.planId, input.interval);
    if (!current) throw new BadRequestException("unknown paid plan/interval");
    const effective = Date.parse(input.effectiveAt);
    if (!(effective >= this.clock.now() + 30 * DAY))
      throw new BadRequestException(
        "effectiveAt must be at least 30 days from now (Terms §12)",
      );
    const recipients = (
      await this.subscribers({ plan: input.planId, interval: input.interval })
    ).filter(
      (r) => ["ACTIVE", "TRIALING", "PAST_DUE"].includes(r.status) && r.email,
    );
    for (const r of recipients) {
      await this.emails.priceChange(r.email, {
        planId: input.planId,
        interval: input.interval,
        oldAmount: current.amount,
        newAmount: input.newAmount,
        currency: planById(input.planId).currency,
        effectiveAt: new Date(effective).toISOString(),
      });
    }
    return { sent: recipients.length };
  }
}
