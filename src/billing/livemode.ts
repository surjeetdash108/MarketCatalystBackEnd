/**
 * Test-mode billing records (Stripe test keys, the fake provider) carry
 * livemode:false. They never count toward MRR, revenue or subscriber counts,
 * show a "Test" badge in admin, and can be purged (scripts/purge-test-billing.ts).
 * Records without the field predate it and are live.
 */
export function isTestRecord(x: unknown): boolean {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { livemode?: unknown }).livemode === false
  );
}
