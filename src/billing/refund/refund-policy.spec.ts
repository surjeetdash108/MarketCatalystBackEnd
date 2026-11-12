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
    // Lower plans happen at period end — no account credit is promised any more.
    expect(p.termsParagraph).toMatch(/takes effect at the end of your current billing period/);
    expect(p.termsParagraph).not.toMatch(/credited to your account|full refund/i);
  });
});
