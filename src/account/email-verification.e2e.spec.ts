import { billingApp } from "../../test/support/billing-app";
import {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  MAX_SENDS_PER_HOUR,
  RESEND_COOLDOWN_MS,
} from "./email-verification.service";

jest.setTimeout(30_000);
type App = Awaited<ReturnType<typeof billingApp>>;
let a: App;
afterEach(async () => {
  await a?.close();
});
const lastCode = (app: App) =>
  /code is (\d{6})/.exec(
    app.sender.outbox.filter((m) => m.tag === "verification_code").at(-1)
      ?.text ?? "",
  )?.[1];

describe("email verification code", () => {
  it("sends a 6-digit code by email, stores only its hash, and marks the account verified", async () => {
    a = await billingApp();
    const u = a.user("v1", "v1@example.com", { emailVerified: false });
    expect((await u.get("/api/account/email-verification")).body).toEqual({
      email: "v1@example.com",
      verified: false,
    });
    const sent = await u.post("/api/account/email-verification/send");
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({
      sent: true,
      expiresInSeconds: 600,
      resendInSeconds: 60,
    });
    const code = lastCode(a)!;
    expect(code).toMatch(/^\d{6}$/);
    expect(
      JSON.stringify(a.fs.read("email_verifications", "v1")),
    ).not.toContain(code);
    expect(
      (await u.post("/api/account/email-verification/verify", { code })).body,
    ).toEqual({ verified: true });
    expect(a.auth.users.get("v1")?.emailVerified).toBe(true);
  });

  it("a wrong code is refused and attempts are capped", async () => {
    a = await billingApp();
    const u = a.user("v2", "v2@example.com", { emailVerified: false });
    await u.post("/api/account/email-verification/send");
    const right = lastCode(a)!;
    const wrong = right === "000000" ? "111111" : "000000";
    expect(
      (await u.post("/api/account/email-verification/verify", { code: wrong }))
        .body.code,
    ).toBe("code_invalid");
    for (let i = 1; i < MAX_ATTEMPTS; i++)
      await u.post("/api/account/email-verification/verify", { code: wrong });
    const locked = await u.post("/api/account/email-verification/verify", {
      code: right,
    });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe("too_many_attempts");
    expect(a.auth.users.get("v2")?.emailVerified).toBe(false);
  });

  it("codes expire after 10 minutes", async () => {
    a = await billingApp();
    const u = a.user("v3", "v3@example.com", { emailVerified: false });
    await u.post("/api/account/email-verification/send");
    const code = lastCode(a)!;
    a.clock.freeze(a.clock.now() + CODE_TTL_MS + 1);
    expect(
      (await u.post("/api/account/email-verification/verify", { code })).body
        .code,
    ).toBe("code_expired");
  });

  it("resend has a cooldown and an hourly cap", async () => {
    a = await billingApp();
    const u = a.user("v4", "v4@example.com", { emailVerified: false });
    await u.post("/api/account/email-verification/send");
    const again = await u.post("/api/account/email-verification/send");
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ code: "resend_cooldown" });
    expect(again.body.retryAfterSeconds).toBeGreaterThan(0);
    for (let i = 1; i < MAX_SENDS_PER_HOUR; i++) {
      a.clock.freeze(a.clock.now() + RESEND_COOLDOWN_MS + 1);
      expect(
        (await u.post("/api/account/email-verification/send")).status,
      ).toBe(200);
    }
    a.clock.freeze(a.clock.now() + RESEND_COOLDOWN_MS + 1);
    const capped = await u.post("/api/account/email-verification/send");
    expect(capped.status).toBe(429);
    expect(capped.body.code).toBe("too_many_codes");
    // The previous code still works after a refused resend.
    expect(
      (
        await u.post("/api/account/email-verification/verify", {
          code: lastCode(a)!,
        })
      ).body.verified,
    ).toBe(true);
  });

  it("an already-verified (e.g. Google) account is not sent a code", async () => {
    a = await billingApp();
    const u = a.user("g1", "g1@example.com", {
      emailVerified: true,
      provider: "google.com",
    });
    expect((await u.post("/api/account/email-verification/send")).body).toEqual(
      { alreadyVerified: true },
    );
    expect(
      a.sender.outbox.filter((m) => m.tag === "verification_code"),
    ).toHaveLength(0);
  });

  it("rejects a malformed code at validation", async () => {
    a = await billingApp();
    const u = a.user("v5", "v5@example.com", { emailVerified: false });
    expect(
      (
        await u.post("/api/account/email-verification/verify", {
          code: "12ab56",
        })
      ).status,
    ).toBe(400);
  });
});

describe("dev outbox (fake provider only)", () => {
  it("admin can read what the console sender sent, so the walkthrough can enter the code", async () => {
    a = await billingApp();
    a.user("v6", "v6@example.com", { emailVerified: false });
    await a.as("v6").post("/api/account/email-verification/send");
    const r = await a.admin.get("/api/billing/fake/outbox?to=v6@example.com");
    expect(r.body.messages.at(-1).text).toMatch(/code is \d{6}/);
    expect(
      (await a.as("v6").get("/api/billing/fake/outbox?to=v6@example.com"))
        .status,
    ).toBe(403);
  });
  it("is absent without the fake provider", async () => {
    a = await billingApp({ provider: false });
    expect(
      (await a.admin.get("/api/billing/fake/outbox?to=x@example.com")).status,
    ).toBe(404);
  });
});
