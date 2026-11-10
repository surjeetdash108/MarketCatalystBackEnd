import { maskPhone, normaliseE164 } from "./phone";

describe("mobile number (E.164)", () => {
  it.each([
    ["+1 (512) 555-0147", "+15125550147"],
    ["+44 7911 123456", "+447911123456"],
    ["+919876543210", "+919876543210"],
  ])("accepts %s → %s", (raw, e164) => expect(normaliseE164(raw)).toBe(e164));
  it.each([
    "5125550147",
    "+1 012 555 0147",
    "+1 512 155 0147",
    "+1 512 555 014",
    "+0123456789",
    "+1234567890123456",
    "abc",
  ])("rejects %s", (raw) => expect(normaliseE164(raw)).toBeNull());
  it("masks all but the last 4 digits", () => {
    expect(maskPhone("+15125550147")).toBe("+1••••••0147");
    expect(maskPhone("+447911123456")).toBe("+44••••••3456");
    expect(maskPhone(null)).toBeNull();
  });
});
