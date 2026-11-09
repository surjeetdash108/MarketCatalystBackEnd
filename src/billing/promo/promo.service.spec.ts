import {
  BadRequestException,
  ConflictException,
  HttpException,
} from "@nestjs/common";
import { billingHarness, DAY, T0 } from "../../../test/support/billing-harness";
import {
  GENERIC_PROMO_ERROR,
  PROMO_ATTEMPTS_PER_HOUR,
  PromoService,
} from "./promo.service";

function setup() {
  const h = billingHarness();
  const promos = new PromoService(h.firebase, h.provider, h.clock);
  return { ...h, promos };
}

async function rejection(
  p: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    const err = e as HttpException;
    return {
      status: err.getStatus(),
      body: err.getResponse() as Record<string, unknown>,
    };
  }
  throw new Error("expected a rejection");
}

describe("PromoService: admin create", () => {
  it("creates each option and mirrors it to the provider", async () => {
    const { promos } = setup();
    const p = await promos.create(
      {
        code: "save20",
        percentOff: 20,
        duration: "repeating",
        durationInMonths: 3,
        appliesToPlans: ["pro"],
        appliesToIntervals: ["monthly"],
        expiresAt: new Date(T0 + 30 * DAY).toISOString(),
        maxRedemptions: 50,
        firstTimeOnly: true,
      },
      "admin@example.com",
    );
    expect(p).toMatchObject({
      code: "SAVE20",
      percentOff: 20,
      amountOff: null,
      duration: "repeating",
      durationInMonths: 3,
      appliesToPlans: ["pro"],
      appliesToIntervals: ["monthly"],
      maxRedemptions: 50,
      firstTimeOnly: true,
      active: true,
      timesRedeemed: 0,
    });
    expect(p.providerRefs.fakePromotionId).toBeTruthy();
    expect(
      await promos.create(
        { code: "TENOFF", amountOff: 1000, duration: "once" },
        null,
      ),
    ).toMatchObject({ amountOff: 1000, duration: "once" });
    expect(
      await promos.create(
        { code: "FOREVER5", percentOff: 5, duration: "forever" },
        null,
      ),
    ).toMatchObject({ duration: "forever", durationInMonths: null });
  });

  it.each([
    [{ code: "X", percentOff: 10, duration: "once" }, /code/],
    [
      { code: "BOTH", percentOff: 10, amountOff: 100, duration: "once" },
      /exactly one/,
    ],
    [{ code: "NONE", duration: "once" }, /exactly one/],
    [{ code: "BIG", percentOff: 120, duration: "once" }, /1–100/],
    [
      { code: "REP", percentOff: 10, duration: "repeating" },
      /durationInMonths/,
    ],
    [
      {
        code: "PLAN",
        percentOff: 10,
        duration: "once",
        appliesToPlans: ["plus"],
      },
      /unknown paid plan/,
    ],
    [
      {
        code: "FREEPLAN",
        percentOff: 10,
        duration: "once",
        appliesToPlans: ["free"],
      },
      /unknown paid plan/,
    ],
  ])("rejects invalid input %#", async (input, msg) => {
    const { promos } = setup();
    await expect(promos.create(input as never, null)).rejects.toThrow(msg);
  });

  it("refuses duplicate codes (case-insensitive)", async () => {
    const { promos } = setup();
    await promos.create(
      { code: "DUP", percentOff: 10, duration: "once" },
      null,
    );
    await expect(
      promos.create({ code: "dup", percentOff: 10, duration: "once" }, null),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("PromoService: preview and validation", () => {
  it("shows the discounted price for a valid percent code", async () => {
    const { promos } = setup();
    await promos.create(
      { code: "SAVE20", percentOff: 20, duration: "once" },
      null,
    );
    expect(
      await promos.preview({
        code: "save20",
        uid: "u1",
        planId: "pro",
        interval: "annual",
        ip: "1.1.1.1",
      }),
    ).toMatchObject({
      amount: 56640,
      discountAmount: 11328,
      amountDueToday: 45312,
      description: "20% off your first invoice",
    });
  });

  it("caps a fixed discount at the price", async () => {
    const { promos } = setup();
    await promos.create(
      { code: "HUGE", amountOff: 999999, duration: "once" },
      null,
    );
    expect(
      await promos.preview({
        code: "HUGE",
        uid: "u1",
        planId: "starter",
        interval: "monthly",
        ip: null,
      }),
    ).toMatchObject({ discountAmount: 3900, amountDueToday: 0 });
  });

  it("rejects expired, used-up, wrong plan, wrong interval, inactive, unknown and first-time-only-for-returning — all with one generic message", async () => {
    const h = setup();
    const { promos } = h;
    await promos.create(
      {
        code: "EXPIRED",
        percentOff: 10,
        duration: "once",
        expiresAt: new Date(T0 - DAY).toISOString(),
      },
      null,
    );
    const used = await promos.create(
      { code: "USEDUP", percentOff: 10, duration: "once", maxRedemptions: 1 },
      null,
    );
    h.fs.seed("promo_codes", used.id, {
      ...h.fs.read("promo_codes", used.id),
      timesRedeemed: 1,
    });
    await promos.create(
      {
        code: "PROONLY",
        percentOff: 10,
        duration: "once",
        appliesToPlans: ["pro"],
      },
      null,
    );
    await promos.create(
      {
        code: "ANNUALONLY",
        percentOff: 10,
        duration: "once",
        appliesToIntervals: ["annual"],
      },
      null,
    );
    const off = await promos.create(
      { code: "OFF", percentOff: 10, duration: "once" },
      null,
    );
    await promos.deactivate(off.id);
    await promos.create(
      {
        code: "FIRSTONLY",
        percentOff: 10,
        duration: "once",
        firstTimeOnly: true,
      },
      null,
    );
    await h.buy("returning", "starter", "monthly");

    const cases: Array<[string, string, string, "monthly" | "annual", string]> =
      [
        ["EXPIRED", "u1", "pro", "monthly", "expired"],
        ["USEDUP", "u1", "pro", "monthly", "max_redemptions"],
        ["PROONLY", "u1", "elite", "monthly", "wrong_plan"],
        ["ANNUALONLY", "u1", "pro", "monthly", "wrong_interval"],
        ["OFF", "u1", "pro", "monthly", "inactive"],
        ["NOPE", "u1", "pro", "monthly", "not_found"],
        ["FIRSTONLY", "returning", "pro", "monthly", "not_first_time"],
      ];
    for (const [code, uid, planId, interval, reason] of cases) {
      expect(await promos.validate({ code, uid, planId, interval })).toEqual({
        ok: false,
        reason,
      });
      const r = await rejection(
        promos.preview({ code, uid, planId, interval, ip: null }),
      );
      expect(r).toEqual({
        status: 400,
        body: {
          statusCode: 400,
          code: "promo_invalid",
          message: GENERIC_PROMO_ERROR,
        },
      });
    }
    expect(
      (
        await promos.validate({
          code: "FIRSTONLY",
          uid: "brand-new",
          planId: "pro",
          interval: "monthly",
        })
      ).ok,
    ).toBe(true);
  });

  it(`rate-limits after ${PROMO_ATTEMPTS_PER_HOUR} attempts per hour, even for valid codes, then resets`, async () => {
    const h = setup();
    await h.promos.create(
      { code: "VALID", percentOff: 10, duration: "once" },
      null,
    );
    for (let i = 0; i < PROMO_ATTEMPTS_PER_HOUR; i++) {
      await h.promos
        .preview({
          code: i % 2 ? "VALID" : "GUESS" + i,
          uid: "u1",
          planId: "pro",
          interval: "monthly",
          ip: "9.9.9.9",
        })
        .catch((e: unknown) => expect(e).toBeInstanceOf(BadRequestException));
    }
    expect(
      (
        await rejection(
          h.promos.preview({
            code: "VALID",
            uid: "u1",
            planId: "pro",
            interval: "monthly",
            ip: "9.9.9.9",
          }),
        )
      ).status,
    ).toBe(429);
    // A different account from the same IP is limited too.
    expect(
      (
        await rejection(
          h.promos.preview({
            code: "VALID",
            uid: "u2",
            planId: "pro",
            interval: "monthly",
            ip: "9.9.9.9",
          }),
        )
      ).status,
    ).toBe(429);
    h.clock.freeze(T0 + 3601_000);
    expect(
      (
        await h.promos.preview({
          code: "VALID",
          uid: "u1",
          planId: "pro",
          interval: "monthly",
          ip: "9.9.9.9",
        })
      ).valid,
    ).toBe(true);
  });
});
