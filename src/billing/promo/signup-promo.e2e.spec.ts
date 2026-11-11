import request from "supertest";
import { billingApp } from "../../../test/support/billing-app";
import { PROMO_ATTEMPTS_PER_HOUR } from "./promo.service";

jest.setTimeout(30_000);
type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});

describe("signup page promo check (signed out)", () => {
  it("a valid code shows the discounted price; anything else is one generic error; rate limited per IP", async () => {
    a = await billingApp();
    await a.admin.post("/api/admin/billing/promos", { code: "SAVE10", percentOff: 10, duration: "once" });
    const post = (body: object, ip = "203.0.113.7") =>
      request(a.server).post("/api/billing/signup/promo").set("x-forwarded-for", ip).send(body);
    const ok = await post({ code: "save10", planId: "pro", interval: "annual" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ valid: true, code: "SAVE10", amount: 56640, discountAmount: 5664, amountDueToday: 50976 });
    const bad = await post({ code: "NOPE", planId: "pro", interval: "annual" });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "promo_invalid" });
    const wrong = await post({ code: "SAVE10", planId: "free", interval: "monthly" });
    expect(wrong.status).toBe(400);
    for (let i = 3; i < PROMO_ATTEMPTS_PER_HOUR; i++) await post({ code: "NOPE", planId: "pro", interval: "monthly" });
    const limited = await post({ code: "SAVE10", planId: "pro", interval: "monthly" });
    expect(limited.status).toBe(429);
    // Another IP still has its own budget.
    expect((await post({ code: "SAVE10", planId: "pro", interval: "monthly" }, "198.51.100.9")).status).toBe(200);
  });
});
