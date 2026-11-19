import { createHmac, timingSafeEqual } from "crypto";

/**
 * Signed one-click links in emails (unsubscribe, "Secure my account"):
 * base64url(uid.purpose.issuedAt).hmac — no login needed, can't be forged
 * or reused for another account or purpose. Secret: EMAIL_LINK_SECRET.
 */
export type LinkPurpose = "unsubscribe" | "secure";

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const mac = (secret: string, payload: string) =>
  createHmac("sha256", secret).update(payload).digest("base64url");

export function signLinkToken(
  secret: string,
  uid: string,
  purpose: LinkPurpose,
  now = Date.now(),
): string {
  const payload = b64(`${uid}.${purpose}.${now}`);
  return `${payload}.${mac(secret, payload)}`;
}

/** The uid when the token is genuine, for `purpose`, and younger than `maxAgeMs`; else null. */
export function verifyLinkToken(
  secret: string,
  token: string,
  purpose: LinkPurpose,
  maxAgeMs: number,
  now = Date.now(),
): string | null {
  const [payload, sig] = String(token ?? "").split(".");
  if (!payload || !sig || !secret) return null;
  const want = Buffer.from(mac(secret, payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const [uid, p, at] = unb64(payload).split(".");
  if (!uid || p !== purpose) return null;
  const t = Number(at);
  if (!Number.isFinite(t) || now - t > maxAgeMs || t - now > 60_000)
    return null;
  return uid;
}
