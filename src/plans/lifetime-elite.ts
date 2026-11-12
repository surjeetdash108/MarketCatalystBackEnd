/**
 * Accounts granted full access and lifetime Elite subscription.
 * Add or remove emails from this list as needed.
 */
export const LIFETIME_ELITE_EMAILS: readonly string[] = [
  "likhith105@gmail.com",
  "hallesanjay2003@gmail.com",
  "sanjayhalle@inc108.com",
  "sandeep@conyxit.com",
  "voorasandeep@gmail.com",
  "sandeepvoora@yahoo.com",
  "arvind@inc108.com",
  "arvind.blgr@gmail.com",
  "vinaychitti@gmail.com",
  "kumar.sivasankaran12@gmail.com",
  "vinay@conyxit.com",
  "sravya@conyxit.com",
  "andy.microinfo@gmail.com",
];

const LIFETIME_ELITE_SET = new Set(
  LIFETIME_ELITE_EMAILS.map((e) => e.trim().toLowerCase()).filter(Boolean),
);

export function isLifetimeElite(email: string | null | undefined): boolean {
  if (!email) return false;
  return LIFETIME_ELITE_SET.has(email.trim().toLowerCase());
}
