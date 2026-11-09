import { createHash } from "crypto";

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Canonical form of an email address for "once per email, ever" checks:
 * lower-case and trimmed; any "+tag" removed from the local part; for Gmail
 * (gmail.com / googlemail.com) dots removed and the domain unified, since
 * Gmail delivers all those variants to the same inbox.
 */
export function normaliseEmail(email: string): string {
  const e = String(email ?? "")
    .trim()
    .toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

/** sha256 of the normalised address — the retention_offers document id. */
export function emailHash(email: string): string {
  return createHash("sha256").update(normaliseEmail(email)).digest("hex");
}
