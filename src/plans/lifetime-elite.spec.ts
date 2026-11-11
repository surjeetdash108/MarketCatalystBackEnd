import { isLifetimeElite, LIFETIME_ELITE_EMAILS } from "./lifetime-elite";

describe("lifetime-elite allowlist", () => {
  it("recognises all configured emails case-insensitively and with whitespace trimmed", () => {
    for (const email of LIFETIME_ELITE_EMAILS) {
      expect(isLifetimeElite(email)).toBe(true);
      expect(isLifetimeElite(email.toUpperCase())).toBe(true);
      expect(isLifetimeElite(`  ${email}  `)).toBe(true);
    }
  });

  it("rejects unknown or invalid emails", () => {
    expect(isLifetimeElite("random@example.com")).toBe(false);
    expect(isLifetimeElite("")).toBe(false);
    expect(isLifetimeElite(null)).toBe(false);
    expect(isLifetimeElite(undefined)).toBe(false);
  });
});
