import { configOf } from "../../../test/support/billing-harness";
import { ConsoleEmailSender, maskEmail } from "./email-sender";
import { EmailService, longDate, money } from "./email.service";

describe("EmailService", () => {
  const setup = () => {
    const sender = new ConsoleEmailSender();
    return {
      sender,
      emails: new EmailService(
        sender,
        configOf({ APP_URL: "http://app.test" }),
      ),
    };
  };
  const END = "2026-12-10T12:00:00.000Z";

  it("sends every email in the doc's Emails table through the sender", async () => {
    const { sender, emails } = setup();
    const to = "user@example.com";
    await emails.welcome(to, {
      planId: "pro",
      interval: "monthly",
      amount: 5900,
      currency: "USD",
      renewsAt: END,
    });
    await emails.upgrade(to, {
      fromPlanId: "starter",
      planId: "pro",
      interval: "monthly",
      charged: 1000,
      currency: "USD",
      renewsAt: END,
    });
    await emails.downgradeScheduled(to, {
      fromPlanId: "elite",
      planId: "starter",
      interval: "monthly",
      effectiveAt: END,
    });
    await emails.cancellation(to, { planId: "pro", endsAt: END });
    await emails.retentionAccepted(to, {
      planId: "pro",
      description: "50% off your next 2 invoices",
      appliesFrom: END,
    });
    await emails.paymentFailed(to, {
      planId: "pro",
      amount: 5900,
      currency: "USD",
      graceEndsAt: END,
    });
    await emails.renewalReminder(to, {
      planId: "pro",
      interval: "annual",
      amount: 56640,
      currency: "USD",
      renewsAt: END,
    });
    await emails.priceChange(to, {
      planId: "pro",
      interval: "monthly",
      oldAmount: 5900,
      newAmount: 6900,
      currency: "USD",
      effectiveAt: END,
    });
    expect(sender.outbox.map((m) => m.tag)).toEqual([
      "welcome",
      "upgrade",
      "downgrade_scheduled",
      "cancellation",
      "retention_accepted",
      "payment_failed",
      "renewal_reminder",
      "price_change",
    ]);
    expect(sender.outbox[3].text).toContain(
      "You keep full access until 10 December 2026",
    );
    expect(sender.outbox[6].text).toContain("$566.40");
  });

  it("uses placeholder sender identity until configured", async () => {
    const { sender, emails } = setup();
    await emails.planEnded("u@example.com", { planId: "pro" });
    expect(sender.outbox[0].from).toBe(
      "MarketCatalyst [PLACEHOLDER] <noreply@example.com>",
    );
    expect(sender.outbox[0].replyTo).toBe("support@example.com");
  });

  it("skips silently without a recipient and never logs a full address", async () => {
    const { sender, emails } = setup();
    await emails.welcome(null, {
      planId: "pro",
      interval: "monthly",
      amount: 1,
      currency: "USD",
      renewsAt: END,
    });
    expect(sender.outbox).toEqual([]);
    expect(maskEmail("jane.doe@example.com")).toBe("j***@example.com");
  });

  it("formats money and dates", () => {
    expect(money(179100)).toBe("$1,791.00");
    expect(longDate(END)).toBe("10 December 2026");
  });

  it("never mentions 'Free plan' in any sent email text or subject", async () => {
    const { sender, emails } = setup();
    const to = "user@example.com";
    await emails.welcome(to, { planId: "pro", interval: "monthly", amount: 5900, currency: "USD", renewsAt: END });
    await emails.upgrade(to, { fromPlanId: "starter", planId: "pro", interval: "monthly", charged: 1000, currency: "USD", renewsAt: END });
    await emails.downgradeScheduled(to, { fromPlanId: "elite", planId: "starter", interval: "monthly", effectiveAt: END });
    await emails.cancellation(to, { planId: "pro", endsAt: END });
    await emails.retentionAccepted(to, { planId: "pro", description: "50% off", appliesFrom: END });
    await emails.paymentFailed(to, { planId: "pro", amount: 5900, currency: "USD", graceEndsAt: END });
    await emails.renewalReminder(to, { planId: "pro", interval: "annual", amount: 56640, currency: "USD", renewsAt: END });
    await emails.priceChange(to, { planId: "pro", interval: "monthly", oldAmount: 5900, newAmount: 6900, currency: "USD", effectiveAt: END });
    await emails.planEnded(to, { planId: "pro" });
    await emails.receipt(to, { planId: "pro", amount: 5900, currency: "USD", invoiceNumber: "INV-1" });
    for (const msg of sender.outbox) {
      expect(msg.text.toLowerCase()).not.toContain("free plan");
      expect(msg.subject.toLowerCase()).not.toContain("free plan");
    }
  });
});
