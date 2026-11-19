import { FakeFirestore } from "../../test/support/fake-firestore";
import { EmailLifecycleService } from "./email-lifecycle.service";
import { deviceLabel } from "./device-label";
import { signLinkToken } from "./email-links";
import { testCodeAllowed } from "../account/email-verification.service";

const DAY = 86_400_000;
const NOW = Date.parse("2026-12-05T15:00:00Z");

function setup(
  user: { created: number; lastIn?: number; verified?: boolean },
  eff: Record<string, unknown>,
) {
  const fs = new FakeFirestore();
  const sent: string[] = [];
  const emails = new Proxy(
    {},
    {
      get:
        (_t, name: string) =>
        (...args: unknown[]) => {
          sent.push(name);
          void args;
          return Promise.resolve();
        },
    },
  );
  const auth = {
    getUser: () =>
      Promise.resolve({
        uid: "u1",
        email: "ana@example.com",
        emailVerified: user.verified ?? true,
        displayName: "Ana B",
        metadata: {
          creationTime: new Date(user.created).toUTCString(),
          lastSignInTime: new Date(user.lastIn ?? user.created).toUTCString(),
        },
      }),
    revokeRefreshTokens: jest.fn(() => Promise.resolve()),
    generatePasswordResetLink: () =>
      Promise.resolve(
        "https://x.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=OOB123&apiKey=k",
      ),
  };
  const subs = {
    forUser: () => Promise.resolve(eff),
    accountStartMs: () => Promise.resolve(user.created),
  };
  const config = {
    get: (k: string, d?: unknown) =>
      (
        ({
          EMAIL_LINK_SECRET: "s3cret",
          APP_URL: "https://app.marketcatalyst.ai",
        }) as Record<string, unknown>
      )[k] ?? d,
  };
  const svc = new EmailLifecycleService(
    { firestore: fs, auth } as never,
    emails as never,
    subs as never,
    config as never,
    { register: jest.fn() } as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
  );
  return {
    svc,
    fs,
    sent,
    auth,
    sweep: (now = NOW) =>
      (
        svc as unknown as {
          sweepOne: (u: string, n: number) => Promise<number>;
        }
      ).sweepOne("u1", now),
  };
}

describe("lifecycle emails", () => {
  it("day 2, never came back, free week ends in 2 days: Welcome + Trial started catch-up, Getting started, First activation, Trial ending — once each", async () => {
    const t = setup(
      { created: NOW - 2.5 * DAY },
      { status: "INTRO", expiryDate: new Date(NOW + 2 * DAY).toISOString() },
    );
    await t.sweep();
    expect(t.sent).toEqual([
      "accountWelcome",
      "trialStarted",
      "gettingStarted",
      "firstActivation",
      "trialEnding",
    ]);
    await t.sweep();
    expect(t.sent).toHaveLength(5);
  });
  it("came back after sign-up: no First activation; unsubscribed: no promotional mail", async () => {
    const back = setup(
      { created: NOW - 2.5 * DAY, lastIn: NOW - 1 * DAY },
      { status: "INTRO", expiryDate: new Date(NOW + 5 * DAY).toISOString() },
    );
    await back.sweep();
    expect(back.sent).not.toContain("firstActivation");
    const off = setup(
      { created: NOW - 2.5 * DAY },
      { status: "INTRO", expiryDate: new Date(NOW + 2 * DAY).toISOString() },
    );
    await off.fs
      .collection("users")
      .doc("u1")
      .set({ emailPrefs: { marketing: false } });
    await off.sweep();
    expect(off.sent).toEqual(["accountWelcome", "trialStarted"]);
  });
  it("free week over with no plan: Trial ended (within 3 days of the end)", async () => {
    const t = setup(
      { created: NOW - 7.5 * DAY },
      { status: "NONE", entitled: false },
    );
    await t.sweep();
    expect(t.sent).toContain("trialEnded");
  });
  it("accounts created before the launch date and unverified ones get nothing", async () => {
    expect(
      await (async () => {
        const t = setup(
          { created: Date.parse("2026-11-10T00:00:00Z") },
          { status: "INTRO", expiryDate: new Date(NOW + DAY).toISOString() },
        );
        await t.sweep();
        return t.sent;
      })(),
    ).toEqual([]);
    const u = setup(
      { created: NOW - 2.5 * DAY, verified: false },
      { status: "INTRO" },
    );
    await u.sweep();
    expect(u.sent).toEqual([]);
  });
  it("new sign-in alert only for a device the account hasn't used (the first device is the sign-up)", async () => {
    const t = setup({ created: NOW - DAY }, { status: "INTRO" });
    const mac =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    await t.svc.recordSignIn("u1", "1.2.3.4", mac, NOW);
    await t.svc.recordSignIn("u1", "1.2.3.4", mac, NOW + 1000);
    expect(t.sent).toEqual([]);
    await t.svc.recordSignIn("u1", "5.6.7.8", iphone, NOW + 2000);
    expect(t.sent).toEqual(["loginAlert"]);
  });
  it("Secure my account signs out everywhere and emails a reset; unsubscribe turns promotional mail off", async () => {
    const t = setup({ created: NOW - DAY }, { status: "INTRO" });
    expect(await t.svc.secure(signLinkToken("s3cret", "u1", "secure"))).toBe(
      true,
    );
    expect(t.auth.revokeRefreshTokens).toHaveBeenCalledWith("u1");
    expect(t.sent).toContain("passwordReset");
    expect(await t.svc.secure("forged.token")).toBe(false);
    expect(
      await t.svc.unsubscribe(signLinkToken("s3cret", "u1", "unsubscribe")),
    ).toBe(true);
    expect(
      (await t.fs.collection("users").doc("u1").get()).data(),
    ).toMatchObject({ emailPrefs: { marketing: false } });
  });
});

describe("verification test code 000000", () => {
  it("only with the flag on, and only for our own accounts", () => {
    expect(testCodeAllowed("true", "qa@marketcatalyst.ai", false)).toBe(true);
    expect(testCodeAllowed("true", "someone@gmail.com", true)).toBe(true); // on the staff list
    expect(testCodeAllowed("true", "customer@gmail.com", false)).toBe(false);
    expect(testCodeAllowed("false", "qa@marketcatalyst.ai", false)).toBe(false);
    expect(testCodeAllowed(undefined, "qa@marketcatalyst.ai", true)).toBe(
      false,
    );
  });
});

describe("device labels", () => {
  it("names browser and OS", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iPhone");
    expect(
      deviceLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0",
      ),
    ).toBe("Edge on Windows");
    expect(deviceLabel(null)).toBe("Unknown device");
  });
});
