import { insideWindow, refundPolicy } from "./refund-policy";
import { REFUND_WINDOW_DAYS } from "./refund-policy.config";

describe("refund policy (one switch)", () => {
  it("defaults to a 14-day window", () => {
    expect(REFUND_WINDOW_DAYS).toBe(14);
    expect(refundPolicy()).toMatchObject({ enabled: true, windowDays: 14 });
  });

  it("every piece of copy follows the window", () => {
    const p = refundPolicy(14);
    for (const s of [p.checkoutLine, p.termsParagraph, p.managePlanLine])
      expect(s).toContain("14 days");
    expect(p.termsParagraph).toMatch(/once per person/);
    expect(p.termsParagraph).toMatch(
      /Monthly renewal charges are not refundable/,
    );
    expect(refundPolicy(7).checkoutLine).toContain("7 days");
    expect(refundPolicy(1).checkoutLine).toContain("1 day ");
  });

  it("0 turns refunds off everywhere with the 'no partial periods' line", () => {
    const p = refundPolicy(0);
    expect(p.enabled).toBe(false);
    for (const s of [p.checkoutLine, p.termsParagraph, p.managePlanLine]) {
      expect(s).toMatch(/^No refunds for partial billing periods/);
      expect(s).not.toMatch(/\d+ day/);
    }
  });

  it("window boundary", () => {
    const paid = Date.parse("2026-11-01T00:00:00Z");
    expect(insideWindow(paid, paid + 14 * 86_400_000, 14)).toBe(true);
    expect(insideWindow(paid, paid + 14 * 86_400_000 + 1, 14)).toBe(false);
    expect(insideWindow(paid, paid, 0)).toBe(false);
  });
});
