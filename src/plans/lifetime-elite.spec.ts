import { readFileSync } from "fs";
import { join } from "path";
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
    // Removed from the list on 2026-11-13 (owner's request).
    expect(isLifetimeElite("likhith@conyxit.com")).toBe(false);
    expect(isLifetimeElite("")).toBe(false);
    expect(isLifetimeElite(null)).toBe(false);
    expect(isLifetimeElite(undefined)).toBe(false);
  });

  it("includes andy.microinfo@gmail.com", () => {
    expect(isLifetimeElite("andy.microinfo@gmail.com")).toBe(true);
  });

  it("the UI's copy of the list is identical (same addresses, same order)", () => {
    const ui = readFileSync(join(__dirname, "../../../MarketCatalystUI/app/iq/billing/lifetime-elite.ts"), "utf8");
    const block = ui.slice(ui.indexOf("LIFETIME_ELITE_EMAILS"), ui.indexOf("];", ui.indexOf("LIFETIME_ELITE_EMAILS")));
    expect([...block.matchAll(/"([^"]+@[^"]+)"/g)].map((m) => m[1])).toEqual([...LIFETIME_ELITE_EMAILS]);
  });
});
