import { refundPolicy } from "./refund-policy";

describe("billing policy: no refunds; cancel anytime and keep the plan to the end of the paid period", () => {
  it("refunds are off everywhere the copy appears", () => {
    const p = refundPolicy();
    expect(p).toMatchObject({ enabled: false, windowDays: 0 });
    for (const line of [p.checkoutLine, p.managePlanLine]) {
      expect(line).toMatch(/^No refunds\./);
      expect(line).toMatch(/until the end of the period you've paid for/);
    }
    expect(p.termsParagraph).toMatch(/^Payments are non-refundable/);
    expect(p.termsParagraph).toMatch(/is not renewed after that/);
    // A lower plan: the current plan continues to period end, then the new plan is charged.
    expect(p.termsParagraph).toMatch(/your current plan continues until the end of your current billing period and your next charge is for the new plan/);
    // Unused value on a switch to a higher plan: Market Catalyst credits, never refunded or auto-applied.
    expect(p.termsParagraph).toMatch(/kept as Market Catalyst credits\. Credits are not refundable and are never applied automatically/);
    expect(p.termsParagraph).not.toMatch(/credited to your account|full refund/i);
  });
});
