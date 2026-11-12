import { planById } from "../plans/plans.registry";

/**
 * Plain-language plan history: one entry per change or payment, newest first,
 * each with an exact timestamp. Built from subscription_events (plan changes,
 * written by the event handler) and payments (charges, credits, refunds).
 */
export interface HistoryEntry {
  /** ISO timestamp of when it happened. */
  at: string;
  kind: "plan" | "payment" | "credit" | "refund" | "trial" | "cancel" | "discount" | "status";
  type: string;
  title: string;
  detail: string | null;
  /** Minor units; positive = charged, negative = credited/refunded. */
  amount: number | null;
  currency: string | null;
  planId: string | null;
  invoiceId: string | null;
}

type Rec = Record<string, unknown>;
const name = (id: unknown) => planById(String(id ?? ""))?.name ?? (id ? String(id) : "a plan");
const cadence = (i: unknown) => (i === "annual" ? "Annual" : i === "monthly" ? "Monthly" : "");
const withCadence = (planId: unknown, interval: unknown) =>
  cadence(interval) ? `${name(planId)} (${cadence(interval)})` : name(planId);
const day = (iso: unknown) =>
  typeof iso === "string" && iso
    ? new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
    : null;

export function describeEvent(e: Rec): HistoryEntry {
  const from = (e.from ?? null) as Rec | null;
  const to = (e.to ?? null) as Rec | null;
  const base = {
    at: String(e.at ?? ""),
    type: String(e.type ?? "event"),
    amount: null,
    currency: null,
    invoiceId: null,
    planId: (to?.planId as string) ?? (from?.planId as string) ?? null,
  };
  switch (e.type) {
    case "subscribed":
      return to?.status === "TRIALING"
        ? { ...base, kind: "trial", title: `Started a free trial of ${withCadence(to?.planId, to?.interval)}`, detail: "Nothing charged today; the first charge is when the trial ends." }
        : { ...base, kind: "plan", title: `Subscribed to ${withCadence(to?.planId, to?.interval)}`, detail: null };
    case "plan_changed":
      return {
        ...base,
        kind: "plan",
        title: `Changed plan: ${withCadence(from?.planId, from?.interval)} → ${withCadence(to?.planId, to?.interval)}`,
        detail: null,
      };
    case "downgrade_scheduled":
      return {
        ...base,
        kind: "plan",
        title: `Scheduled a change to ${withCadence(to?.planId, to?.interval)}`,
        detail: day(to?.effectiveAt) ? `Takes effect on ${day(to?.effectiveAt)}.` : null,
      };
    case "downgrade_cancelled":
      return { ...base, kind: "plan", title: "Cancelled the scheduled plan change", detail: `Staying on the current plan.` };
    case "cancel_scheduled":
      return { ...base, kind: "cancel", title: "Cancelled the subscription", detail: day(to?.endsAt) ? `Access continues until ${day(to?.endsAt)}.` : null };
    case "resumed":
      return { ...base, kind: "plan", title: "Resumed the subscription", detail: day(to?.renewsAt) ? `Renews on ${day(to?.renewsAt)}.` : null };
    case "discount_applied": {
      const d = to as Rec | null;
      const what = d?.percentOff != null ? `${d.percentOff}% off` : "A discount";
      const src = d?.source === "retention" ? "retention offer" : d?.code ? `code ${String(d.code)}` : "promo";
      return { ...base, kind: "discount", title: `${what} applied (${src})`, detail: null };
    }
    case "launch_trial":
      return { ...base, kind: "trial", title: `${name(to?.planId)} access granted at launch`, detail: day(to?.endsAt) ? `Until ${day(to?.endsAt)}.` : null };
    case "status_changed": {
      const s = String(to ?? e.to ?? "");
      const f = String(from ?? e.from ?? "");
      const title =
        f === "TRIALING" && s === "ACTIVE"
          ? "Free trial ended — plan active"
          : s === "PAST_DUE"
            ? "Payment failed — update your card"
            : s === "ACTIVE" && f === "PAST_DUE"
              ? "Payment recovered — plan active"
              : s === "CANCELLED" || s === "EXPIRED"
                ? "Plan ended"
                : `Status: ${s.toLowerCase().replace(/_/g, " ")}`;
      return { ...base, kind: "status", title, detail: null };
    }
    default:
      return { ...base, kind: "status", title: String(e.type ?? "Update").replace(/_/g, " "), detail: null };
  }
}

/** Payments → entries: the charge, any credit to the account, and any refund. */
export function describePayment(p: Rec): HistoryEntry[] {
  const at = String(p.paymentDate ?? p.updatedAt ?? "");
  const currency = String(p.currency ?? "USD");
  const base = { at, currency, planId: (p.planId as string) ?? null, invoiceId: (p.paymentId as string) ?? null };
  const out: HistoryEntry[] = [];
  const lines = Array.isArray(p.lines) ? (p.lines as Rec[]) : [];
  const credit = lines.filter((l) => l.description === "Credit to your account balance").reduce((a, l) => a + Number(l.amount ?? 0), 0);
  const amount = Number(p.amount ?? 0);
  const plan = withCadence(p.planId, p.billingCycle);
  if (p.paymentStatus === "FAILED")
    out.push({ ...base, kind: "payment", type: "payment_failed", title: `Payment failed for ${plan}`, detail: null, amount: Number(p.amount ?? 0) });
  else if (amount > 0)
    out.push({
      ...base,
      kind: "payment",
      type: "payment",
      title: p.billingReason === "subscription_update" ? `Charged for the change to ${plan}` : p.billingReason === "subscription_cycle" ? `Renewal of ${plan}` : `Payment for ${plan}`,
      detail: Number(p.creditApplied ?? 0) > 0 ? `Account credit used: ${(Number(p.creditApplied) / 100).toFixed(2)} ${currency}` : null,
      amount,
    });
  else if (Number(p.creditApplied ?? 0) > 0)
    out.push({ ...base, kind: "payment", type: "payment", title: `Renewal of ${plan} paid with account credit`, detail: null, amount: 0 });
  if (credit > 0)
    out.push({ ...base, kind: "credit", type: "credit", title: `Credit to your account (change to ${plan})`, detail: "Used automatically on your next invoice(s); not refunded to your card.", amount: -credit });
  if (Number(p.amountRefunded ?? 0) > 0)
    out.push({ ...base, at: String(p.refundedAt ?? at), kind: "refund", type: "refund", title: `Refunded ${plan}`, detail: null, amount: -Number(p.amountRefunded) });
  return out;
}

export function buildTimeline(events: Rec[], payments: Rec[]): HistoryEntry[] {
  return [...events.map(describeEvent), ...payments.flatMap(describePayment)]
    .filter((e) => e.at)
    .sort((a, b) => b.at.localeCompare(a.at));
}
