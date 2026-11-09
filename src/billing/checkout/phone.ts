/**
 * Mobile number in E.164 (+<country code><number>, max 15 digits). No
 * verification. NANP (+1: US, Canada…) numbers must be a valid 10-digit
 * number: area code and exchange can't start with 0 or 1.
 */
const E164 = /^\+[1-9]\d{7,14}$/;
const NANP = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

export function normaliseE164(raw: string): string | null {
  const s = String(raw ?? "").replace(/[\s().-]/g, "");
  if (!E164.test(s)) return null;
  if (s.startsWith("+1") && !NANP.test(s)) return null;
  return s;
}

/** "+1••••••4567" — everything but the last 4 digits hidden. */
export function maskPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const tail = e164.slice(-4);
  const cc = e164.startsWith("+1")
    ? "+1"
    : e164.slice(0, Math.min(3, e164.length - 4));
  return `${cc}${"•".repeat(Math.max(0, e164.length - cc.length - 4))}${tail}`;
}
