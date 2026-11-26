import { refundPolicy } from "./refund-policy";
import { subscriptionTerms } from "./subscription-terms";
import { TRIAL_DAYS } from "../../plans/plans.registry";

describe("subscription terms (W-26): one text for Home, checkout and Terms §12", () => {
  const t = subscriptionTerms(TRIAL_DAYS);

  it("is the owner's decision: a 7-day trial and no refunds", () => {
    expect(TRIAL_DAYS).toBe(7);
    expect(refundPolicy().enabled).toBe(false);
    expect(t.purchaseLine).toBe(
      "Every new account gets a 7-day free trial from sign-up; a plan you buy during it starts when the trial ends. Plans renew automatically until you cancel. " +
        refundPolicy().checkoutLine,
    );
  });

  it("§12 states the trial, renewal, cancellation and refund terms Home sells", () => {
    const s12 = t.termsParagraphs.join(" ");
    expect(s12).toContain("7-day free trial, counted from sign-up");
    expect(s12).toContain(
      "starts, and you are first charged, when the trial ends",
    );
    expect(s12).toContain(
      "after the trial, it starts, and you are charged, immediately",
    );
    expect(s12).toContain("access to the Service ends when the trial ends");
    expect(s12).toContain("renews automatically");
    expect(s12).toContain(refundPolicy().termsParagraph);
    expect(s12).not.toMatch(/launching soon/i);
  });

  it("drops the trial sentences when there is no trial", () => {
    const none = subscriptionTerms(0);
    expect(none.trialLine).toBe("");
    expect(none.purchaseLine.startsWith("Plans renew automatically")).toBe(
      true,
    );
    expect(none.termsParagraphs.join(" ")).not.toMatch(/trial/i);
  });
});
