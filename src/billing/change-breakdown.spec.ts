import { StripeBillingProvider } from "./provider/stripe/stripe-billing.provider";
import { BillingService, changeBreakdown, paidForPeriod } from "./billing.service";
import type Stripe from "stripe";

describe("Change breakdown Stripe reconciliation", () => {
  describe("changeBreakdown reconciliation identity", () => {
    it("1. credit covering the whole charge ($0.93 / $57.59 / -$39 / credit -$19.52 / $0)", () => {
      // Starter -> Pro monthly with customer account credit balance covering the proration charge.
      const preview = {
        lines: [
          { amount: -3807, proration: true },
          { amount: 5759, proration: true },
        ],
        currentPeriodStart: "2026-11-01T00:00:00.000Z",
        currentPeriodEnd: "2026-12-01T00:00:00.000Z",
        prorationDate: Date.parse("2026-11-11T00:00:00.000Z"),
        amountDueNow: 0,
        creditToBalance: 0,
        discount: 0,
        tax: 0,
        creditUsed: 1952,
        alreadyPaid: 3900,
        unusedCredit: 3807,
        newPlanCharge: 5759,
      };

      const bd = changeBreakdown(
        preview,
        { from: "Starter", to: "Pro" },
        preview.alreadyPaid,
      );

      expect(bd.usedOnCurrent).toBe(93); // $0.93
      expect(bd.newPlanCharge).toBe(5759); // $57.59
      expect(bd.alreadyPaid).toBe(3900); // $39.00
      expect(bd.discount).toBe(0);
      expect(bd.tax).toBe(0);
      expect(bd.creditUsed).toBe(1952); // $19.52
      expect(bd.chargedNow).toBe(0); // $0

      // Reconciles to the exact cent:
      // usedOnCurrent + newPlanCharge − alreadyPaid − discount + tax − creditUsed = chargedNow
      const calculated =
        bd.usedOnCurrent +
        bd.newPlanCharge -
        bd.alreadyPaid -
        bd.discount +
        bd.tax -
        bd.creditUsed;
      expect(calculated).toBe(bd.chargedNow);
      expect(calculated).toBe(0);
    });

    it("2. tax added to the upgrade invoice", () => {
      // Starter -> Pro with tax (e.g. Texas 8.25%)
      const preview = {
        lines: [
          { amount: -2600, proration: true },
          { amount: 3933, proration: true },
        ],
        currentPeriodStart: "2026-11-01T00:00:00.000Z",
        currentPeriodEnd: "2026-12-01T00:00:00.000Z",
        prorationDate: Date.parse("2026-11-11T00:00:00.000Z"),
        amountDueNow: 1443, // 1333 net + 110 tax
        creditToBalance: 0,
        discount: 0,
        tax: 110,
        creditUsed: 0,
        alreadyPaid: 3900,
        unusedCredit: 2600,
        newPlanCharge: 3933,
      };

      const bd = changeBreakdown(
        preview,
        { from: "Starter", to: "Pro" },
        preview.alreadyPaid,
      );

      expect(bd.usedOnCurrent).toBe(1300);
      expect(bd.newPlanCharge).toBe(3933);
      expect(bd.alreadyPaid).toBe(3900);
      expect(bd.discount).toBe(0);
      expect(bd.tax).toBe(110);
      expect(bd.creditUsed).toBe(0);
      expect(bd.chargedNow).toBe(1443);

      const calculated =
        bd.usedOnCurrent +
        bd.newPlanCharge -
        bd.alreadyPaid -
        bd.discount +
        bd.tax -
        bd.creditUsed;
      expect(calculated).toBe(bd.chargedNow);
      expect(calculated).toBe(1443);
    });

    it("3. a once-only promo paid on the first invoice (already paid reflects actual paid, not list price)", () => {
      // Customer paid $29 instead of $39 due to a once-only $10 promo on Starter
      const preview = {
        lines: [
          { amount: -1933, proration: true },
          { amount: 3933, proration: true },
        ],
        currentPeriodStart: "2026-11-01T00:00:00.000Z",
        currentPeriodEnd: "2026-12-01T00:00:00.000Z",
        prorationDate: Date.parse("2026-11-11T00:00:00.000Z"),
        amountDueNow: 2000,
        creditToBalance: 0,
        discount: 0,
        tax: 0,
        creditUsed: 0,
        alreadyPaid: 2900, // Actual amount paid from past invoice
        unusedCredit: 1933,
        newPlanCharge: 3933,
      };

      const bd = changeBreakdown(
        preview,
        { from: "Starter", to: "Pro" },
        preview.alreadyPaid,
      );

      expect(bd.alreadyPaid).toBe(2900);
      expect(bd.usedOnCurrent).toBe(967); // 2900 - 1933
      expect(bd.newPlanCharge).toBe(3933);
      expect(bd.chargedNow).toBe(2000);

      const calculated =
        bd.usedOnCurrent +
        bd.newPlanCharge -
        bd.alreadyPaid -
        bd.discount +
        bd.tax -
        bd.creditUsed;
      expect(calculated).toBe(bd.chargedNow);
      expect(calculated).toBe(2000);
    });

    it("4. mid-trial upgrade: no breakdown, first charge on trial end", () => {
      // Free trial has status "TRIALING", so paidForPeriod is 0 and breakdown is null
      expect(paidForPeriod({ amount: 3900, status: "TRIALING" })).toBe(0);

      // In BillingService.previewChange, when status === "TRIALING", breakdown is null
      // and trialEndsAt is set to currentPeriodEnd
      const trialSub = {
        planId: "starter",
        interval: "monthly",
        status: "TRIALING",
        currentPeriodEnd: "2026-11-20T00:00:00.000Z",
      };
      const breakdown =
        trialSub.status === "TRIALING"
          ? null
          : changeBreakdown(
              {
                lines: [],
                currentPeriodStart: "2026-11-13T00:00:00.000Z",
                currentPeriodEnd: trialSub.currentPeriodEnd,
                prorationDate: Date.now(),
                amountDueNow: 0,
                creditToBalance: 0,
              },
              { from: "Starter", to: "Pro" },
              0,
            );

      expect(breakdown).toBeNull();
    });

    it("5. downgrade to credit: negative total is credited to account balance", () => {
      // Pro ($59) -> Starter ($39), 20 of 30 days left
      const preview = {
        lines: [
          { amount: -3933, proration: true },
          { amount: 2600, proration: true },
        ],
        currentPeriodStart: "2026-11-01T00:00:00.000Z",
        currentPeriodEnd: "2026-12-01T00:00:00.000Z",
        prorationDate: Date.parse("2026-11-11T00:00:00.000Z"),
        amountDueNow: 0,
        creditToBalance: 1333,
        discount: 0,
        tax: 0,
        creditUsed: 0,
        alreadyPaid: 5900,
        unusedCredit: 3933,
        newPlanCharge: 2600,
      };

      const bd = changeBreakdown(
        preview,
        { from: "Pro", to: "Starter" },
        preview.alreadyPaid,
      );

      expect(bd.usedOnCurrent).toBe(1967); // 5900 - 3933
      expect(bd.newPlanCharge).toBe(2600);
      expect(bd.alreadyPaid).toBe(5900);
      expect(bd.chargedNow).toBe(0);
      expect(bd.creditToBalance).toBe(1333);

      const calculated =
        bd.usedOnCurrent +
        bd.newPlanCharge -
        bd.alreadyPaid -
        bd.discount +
        bd.tax -
        bd.creditUsed;
      // For downgrades: the negative total is the credit to account balance
      expect(calculated).toBe(-bd.creditToBalance);
      expect(calculated).toBe(-1333);
    });
  });

  describe("StripeBillingProvider previewChange extraction with mocked Stripe", () => {
    it("extracts lines, discounts, taxes, creditUsed, and alreadyPaid from Stripe", async () => {
      const mockStripe = {
        subscriptions: {
          retrieve: jest.fn().mockResolvedValue({
            id: "sub_123",
            customer: "cus_123",
            status: "active",
            created: 1762819200,
            current_period_start: 1762819200,
            current_period_end: 1765454400,
            items: {
              data: [
                {
                  id: "si_123",
                  price: {
                    id: "price_starter",
                    lookup_key: "starter_monthly",
                    currency: "usd",
                    unit_amount: 3900,
                  },
                  current_period_start: 1762819200,
                  current_period_end: 1765454400,
                },
              ],
            },
            metadata: {},
          }),
        },
        invoices: {
          createPreview: jest.fn().mockResolvedValue({
            currency: "usd",
            subtotal: 1952,
            total: 1952,
            amount_due: 0, // fully covered by credit
            starting_balance: -1952,
            ending_balance: 0,
            total_discount_amounts: [],
            total_taxes: [],
            lines: {
              data: [
                {
                  description: "Unused time on Starter",
                  amount: -3807,
                  proration: true,
                  period: { start: 1762862400, end: 1765454400 },
                },
                {
                  description: "Remaining time on Pro",
                  amount: 5759,
                  proration: true,
                  period: { start: 1762862400, end: 1765454400 },
                },
              ],
            },
          }),
          list: jest.fn().mockResolvedValue({
            data: [
              {
                id: "in_prev",
                status: "paid",
                total: 3900,
                amount_paid: 3900,
                total_taxes: [],
                // The renewal line for the current price and period: what was paid for Starter.
                lines: {
                  data: [
                    {
                      amount: 3900,
                      period: { start: 1762819200, end: 1765454400 },
                      pricing: { price_details: { price: "price_starter" } },
                    },
                  ],
                },
              },
            ],
          }),
        },
      } as unknown as Stripe;

      const mockConfig = {
        get: jest.fn().mockImplementation((k: string) => {
          if (k === "STRIPE_SECRET_KEY") return "sk_test_123";
          return null;
        }),
      };
      const provider = new StripeBillingProvider(mockConfig as any, mockStripe);
      // Mock priceId lookup
      jest.spyOn(provider as any, "priceId").mockResolvedValue("price_pro");

      const preview = await provider.previewChange({
        subscriptionId: "sub_123",
        target: {
          planId: "pro",
          interval: "monthly",
          amount: 5900,
          currency: "USD",
          lookupKey: "pro_monthly",
        },
        kind: "upgrade",
      });

      expect(preview.amountDueNow).toBe(0);
      expect(preview.creditUsed).toBe(1952);
      expect(preview.discount).toBe(0);
      expect(preview.tax).toBe(0);
      expect(preview.alreadyPaid).toBe(3900);
      expect(preview.unusedCredit).toBe(3807);
      expect(preview.newPlanCharge).toBe(5759);

      const bd = changeBreakdown(
        preview as any,
        { from: "Starter", to: "Pro" },
        preview.alreadyPaid,
      );

      const calculated =
        bd.usedOnCurrent +
        bd.newPlanCharge -
        bd.alreadyPaid -
        bd.discount +
        bd.tax -
        bd.creditUsed;
      expect(calculated).toBe(bd.chargedNow);
      expect(calculated).toBe(0);
    });
  });
});
