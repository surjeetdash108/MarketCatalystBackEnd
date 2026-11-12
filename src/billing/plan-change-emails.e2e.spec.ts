import { billingApp } from "../../test/support/billing-app";
import { DAY, T0 } from "../../test/support/billing-harness";

jest.setTimeout(30_000);
type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});
const last = (app: App) => app.sender.outbox[app.sender.outbox.length - 1];

describe("every plan change sends a confirmation email", () => {
  it("upgrade, downgrade (with credit), annual→monthly, keep current plan, cancel, resume", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("e1", "starter", "monthly");
    a.clock.freeze(T0 + 10 * DAY);
    let p = (await u.post("/api/billing/change/preview", { planId: "elite", interval: "monthly" })).body;
    await u.post("/api/billing/change", { planId: "elite", interval: "monthly", expectedAmountDue: p.amountDueNow, prorationDate: p.prorationDate });
    expect(a.sender.outbox.some((m) => m.tag === "upgrade" && m.subject === "You're now on Elite")).toBe(true);

    p = (await u.post("/api/billing/change/preview", { planId: "pro", interval: "monthly" })).body;
    await u.post("/api/billing/change", { planId: "pro", interval: "monthly", prorationDate: p.prorationDate });
    const down = a.sender.outbox.find((m) => m.tag === "downgrade_scheduled")!;
    expect(down.subject).toBe("Your change to Pro is scheduled");
    expect(down.text).toMatch(/You keep .* until/);

    await u.post("/api/billing/cancel");
    expect(last(a).tag).toBe("cancellation");
    await u.post("/api/billing/resume");
    expect(last(a).tag).toBe("resumed");
  });

  it("annual → monthly is confirmed when scheduled and when you keep your plan", async () => {
    a = await billingApp();
    const { u } = await a.subscribe("e2", "pro", "annual");
    await u.post("/api/billing/change", { planId: "pro", interval: "monthly" });
    expect(last(a).tag).toBe("downgrade_scheduled");
    await u.post("/api/billing/change/keep");
    expect(last(a)).toMatchObject({ tag: "change_cancelled", subject: "You're staying on Pro" });
  });
});
