/**
 * Classifies a `users/{uid}` document for the pre-launch plan-field audit:
 * does it carry plan, subscription, Stripe or feature-flag state that nothing
 * legitimate has written yet? Before M0, any signed-in user could write these
 * fields themselves (PATCH /api/profile and the users/{uid} rules), so every
 * hit must be reviewed before billing goes live.
 *
 * Pure function — used by scripts/audit-plan-fields.ts (read-only) and tested
 * in plan-field-audit.spec.ts.
 */
export interface PlanFieldFinding {
  uid: string;
  email: string | null;
  fields: Record<string, unknown>;
}

const DEFAULTS: Record<string, unknown> = {
  tier: "free",
  currentPlan: "free",
  subscriptionStatus: "NONE",
};

const AUDITED = [
  "tier",
  "currentPlan",
  "subscriptionStatus",
  "subscriptionStartDate",
  "subscriptionExpiryDate",
  "featureFlags",
  "stripeCustomerId",
  "stripeSubId",
] as const;

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (typeof v === "object" && Object.keys(v).length === 0) return true;
  return false;
}

/** Non-default plan-related fields on the doc, or null when there are none. */
export function auditUserDoc(
  uid: string,
  data: Record<string, unknown>,
): PlanFieldFinding | null {
  const fields: Record<string, unknown> = {};
  for (const k of AUDITED) {
    const v = data[k];
    if (isEmptyValue(v)) continue;
    if (k in DEFAULTS && v === DEFAULTS[k]) continue;
    fields[k] = v;
  }
  if (Object.keys(fields).length === 0) return null;
  const email = typeof data.email === "string" ? data.email : null;
  return { uid, email, fields };
}
