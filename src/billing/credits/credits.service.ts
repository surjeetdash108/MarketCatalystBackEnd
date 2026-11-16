import { Injectable } from "@nestjs/common";
import { AppClock } from "../../common/app-clock";
import { FirebaseAdminService } from "../../common/firebase-admin.provider";

/**
 * Market Catalyst credits: money a customer has with us that is never refunded
 * and never spent on its own — today, the unused value left over when a switch
 * to a higher plan happens now and the unused time is worth more than the new
 * charge (e.g. Pro annual → Elite monthly).
 *
 * credits/{uid}: { balance, currency, pending, history[] }, minor units, written
 * only by the backend. The customer chooses to use credits on a payment
 * (checkout, a switch, or "use on my next payment" in Manage Plan); that
 * reserves the amount as `pending` (applied at the provider as a one-time
 * discount), and it leaves the balance only once that payment succeeds.
 */
export interface CreditsDoc {
  uid: string;
  balance: number;
  currency: string;
  /** Reserved for a payment the customer chose to use credits on. */
  pending: { amount: number; subscriptionId: string | null; at: string } | null;
  history: Array<{
    at: string;
    amount: number;
    kind: "added" | "used" | "released";
    reason: string;
  }>;
}

const HISTORY_MAX = 50;

@Injectable()
export class CreditsService {
  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly clock: AppClock,
  ) {}

  private ref(uid: string) {
    return this.firebase.firestore.collection("credits").doc(uid);
  }

  private empty(uid: string): CreditsDoc {
    return { uid, balance: 0, currency: "USD", pending: null, history: [] };
  }

  async get(uid: string): Promise<CreditsDoc> {
    const d = (await this.ref(uid).get()).data() as CreditsDoc | undefined;
    return d ? { ...this.empty(uid), ...d } : this.empty(uid);
  }

  /** What can still be chosen for a payment (balance minus anything already reserved). */
  async available(uid: string): Promise<number> {
    const c = await this.get(uid);
    return Math.max(0, c.balance - (c.pending?.amount ?? 0));
  }

  private async update(
    uid: string,
    fn: (c: CreditsDoc) => CreditsDoc | null,
  ): Promise<CreditsDoc> {
    const ref = this.ref(uid);
    return this.firebase.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur = snap.exists
        ? { ...this.empty(uid), ...(snap.data() as CreditsDoc) }
        : this.empty(uid);
      const next = fn(cur);
      if (next)
        tx.set(ref, { ...next, history: next.history.slice(-HISTORY_MAX) });
      return next ?? cur;
    });
  }

  /** Adds credits (e.g. the unused value of a switch). Idempotent per `key`. */
  async add(
    uid: string,
    amount: number,
    reason: string,
    key: string,
  ): Promise<CreditsDoc> {
    if (!(amount > 0)) return this.get(uid);
    const marker = this.firebase.firestore
      .collection("credit_grants")
      .doc(key.replace(/[/.#[\]]/g, "_"));
    const fresh = await this.firebase.firestore.runTransaction(async (tx) => {
      if ((await tx.get(marker)).exists) return false;
      tx.set(marker, { uid, amount, reason, at: this.clock.nowIso() });
      return true;
    });
    if (!fresh) return this.get(uid);
    return this.update(uid, (c) => ({
      ...c,
      balance: c.balance + amount,
      history: [
        ...c.history,
        { at: this.clock.nowIso(), amount, kind: "added", reason },
      ],
    }));
  }

  /** Reserves up to `max` for a payment the customer chose to use credits on; returns the amount reserved. */
  async reserve(
    uid: string,
    max: number,
    subscriptionId: string | null,
  ): Promise<number> {
    let reserved = 0;
    await this.update(uid, (c) => {
      const free = Math.max(0, c.balance - (c.pending?.amount ?? 0));
      reserved = Math.max(0, Math.min(free, Math.floor(max)));
      if (reserved <= 0) return null;
      return {
        ...c,
        pending: {
          amount: (c.pending?.amount ?? 0) + reserved,
          subscriptionId: subscriptionId ?? c.pending?.subscriptionId ?? null,
          at: this.clock.nowIso(),
        },
      };
    });
    return reserved;
  }

  /** Points an open reservation at the subscription it will be spent on (checkout creates it after reserving). */
  async attachPending(uid: string, subscriptionId: string): Promise<void> {
    await this.update(uid, (c) =>
      c.pending ? { ...c, pending: { ...c.pending, subscriptionId } } : null,
    );
  }

  /** The reserved credits were spent on a paid invoice: they leave the balance. */
  async settle(
    uid: string,
    subscriptionId: string | null,
    spent: number,
    reason: string,
  ): Promise<number> {
    let used = 0;
    await this.update(uid, (c) => {
      if (!c.pending) return null;
      if (
        subscriptionId &&
        c.pending.subscriptionId &&
        c.pending.subscriptionId !== subscriptionId
      )
        return null;
      used = Math.max(0, Math.min(c.pending.amount, spent, c.balance));
      if (used <= 0) return null;
      const left = c.pending.amount - used;
      return {
        ...c,
        balance: c.balance - used,
        pending: left > 0 ? { ...c.pending, amount: left } : null,
        history: [
          ...c.history,
          { at: this.clock.nowIso(), amount: -used, kind: "used", reason },
        ],
      };
    });
    return used;
  }

  /** A reservation that won't be spent (payment failed, checkout abandoned): the credits are free again. */
  async release(uid: string, reason: string): Promise<void> {
    await this.update(uid, (c) =>
      c.pending
        ? {
            ...c,
            pending: null,
            history: [
              ...c.history,
              { at: this.clock.nowIso(), amount: 0, kind: "released", reason },
            ],
          }
        : null,
    );
  }
}
