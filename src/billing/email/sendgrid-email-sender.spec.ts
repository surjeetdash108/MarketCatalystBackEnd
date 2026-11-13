import { Logger } from "@nestjs/common";
import { configOf } from "../../../test/support/billing-harness";
import { BillingAccessService } from "../billing-access.service";
import { FeatureFlagsService } from "../../feature-flags/feature-flags.service";
import { createEmailSender, emailDeliveryReady } from "./email-provider";
import { ConsoleEmailSender, type EmailMessage } from "./email-sender";
import { EmailService } from "./email.service";
import {
  SENDGRID_URL,
  SendGridEmailSender,
  SendGridError,
  parseAddress,
} from "./sendgrid-email-sender";

const KEY = "SG.test-key-never-logged";
const msg: EmailMessage = {
  tag: "verification_code",
  to: "pat.buyer@example.com",
  from: "MarketCatalyst <noreply@example.com>",
  replyTo: "support@example.com",
  subject: "Your code",
  text: "Your verification code is 123456.",
};
const res = (status: number, body = "") => ({
  status,
  text: () => Promise.resolve(body),
});

describe("SendGrid adapter (mocked client)", () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    for (const m of ["log", "warn", "error"] as const)
      jest
        .spyOn(Logger.prototype, m)
        .mockImplementation((s: unknown) => void logs.push(String(s)));
  });
  afterEach(() => jest.restoreAllMocks());

  it("success: one POST to the v3 Mail Send API with the key as bearer token and a plain-text body", async () => {
    const f = jest.fn(() => Promise.resolve(res(202)));
    await new SendGridEmailSender(KEY, f).send(msg);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe(SENDGRID_URL);
    expect(init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body)).toMatchObject({
      personalizations: [{ to: [{ email: "pat.buyer@example.com" }] }],
      from: { email: "noreply@example.com", name: "MarketCatalyst" },
      reply_to: { email: "support@example.com" },
      content: [
        { type: "text/plain", value: "Your verification code is 123456." },
      ],
      categories: ["verification_code"],
    });
  });

  it("provider error (4xx) fails at once without retrying", async () => {
    const f = jest.fn(() =>
      Promise.resolve(res(401, '{"errors":[{"message":"bad auth"}]}')),
    );
    await expect(
      new SendGridEmailSender(KEY, f, { backoffMs: 0 }).send(msg),
    ).rejects.toMatchObject({ status: 401 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries 429 / 5xx / network errors with backoff, then succeeds", async () => {
    const f = jest
      .fn()
      .mockResolvedValueOnce(res(429))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(res(202));
    await new SendGridEmailSender(KEY, f, { backoffMs: 0 }).send(msg);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("gives up after 3 attempts with a SendGridError", async () => {
    const f = jest.fn(() => Promise.resolve(res(503)));
    await expect(
      new SendGridEmailSender(KEY, f, { backoffMs: 0 }).send(msg),
    ).rejects.toBeInstanceOf(SendGridError);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("never logs the API key, the full address or the message body", async () => {
    await new SendGridEmailSender(
      KEY,
      jest.fn(() => Promise.resolve(res(202))),
    ).send(msg);
    await new SendGridEmailSender(
      KEY,
      jest.fn(() => Promise.resolve(res(400, "bad request"))),
      { backoffMs: 0 },
    )
      .send(msg)
      .catch(() => undefined);
    const all = logs.join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("pat.buyer@example.com");
    expect(all).not.toContain("123456");
    expect(all).toContain("p***@example.com");
  });

  it("parses display-name addresses", () => {
    expect(parseAddress("MarketCatalyst <noreply@example.com>")).toEqual({
      name: "MarketCatalyst",
      email: "noreply@example.com",
    });
    expect(parseAddress("support@example.com")).toEqual({
      email: "support@example.com",
    });
  });
});

describe("email provider selection and readiness", () => {
  afterEach(() => jest.restoreAllMocks());
  const PROD = { FIREBASE_PROJECT_ID: "market-catalyst-502415" };

  it("EMAIL_PROVIDER=sendgrid + key → SendGrid; otherwise the console sender", () => {
    expect(
      createEmailSender(
        configOf({ EMAIL_PROVIDER: "sendgrid", EMAIL_PROVIDER_API_KEY: KEY }),
      ),
    ).toBeInstanceOf(SendGridEmailSender);
    expect(
      createEmailSender(
        configOf({
          EMAIL_PROVIDER: "sendgrid",
          EMAIL_PROVIDER_API_KEY: "__PLACEHOLDER__",
        }),
      ),
    ).toBeInstanceOf(ConsoleEmailSender);
    expect(createEmailSender(configOf({}))).toBeInstanceOf(ConsoleEmailSender);
  });

  it("production without SendGrid logs a startup warning and reports email not ready", () => {
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    createEmailSender(configOf(PROD));
    expect(warn.mock.calls.map((c) => String(c[0])).join()).toMatch(
      /EMAIL_PROVIDER is not set to sendgrid.*Stripe sends billing emails/,
    );
    expect(emailDeliveryReady(configOf(PROD))).toBe(false);
    expect(
      emailDeliveryReady(
        configOf({
          ...PROD,
          EMAIL_PROVIDER: "sendgrid",
          EMAIL_PROVIDER_API_KEY: KEY,
        }),
      ),
    ).toBe(true);
    expect(
      emailDeliveryReady(configOf({ FIREBASE_PROJECT_ID: "demo-staging" })),
    ).toBe(true);
  });

  it("production: paid checkout opens without SendGrid (Firebase verifies email, Stripe sends billing emails)", async () => {
    const env = { ...PROD, SUBSCRIPTIONS_ENABLED: "true" };
    const fb = {
      firestore: {
        doc: () => ({ get: () => Promise.resolve({ data: () => ({}) }) }),
      },
    } as never;
    const provider = { name: "stripe" } as never;
    const access = new BillingAccessService(
      new FeatureFlagsService(fb, configOf(env)),
      provider,
      configOf(env),
    );
    expect(await access.subscriptionsLive()).toBe(true);
  });

  it("a failed notification never throws into billing; a failed verification code reaches the user", async () => {
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const failing = {
      send: () => Promise.reject(new SendGridError(503, "SendGrid 503")),
    };
    const emails = new EmailService(failing, configOf({}));
    await expect(
      emails.receipt("a@example.com", {
        planId: "pro",
        amount: 5900,
        currency: "USD",
        invoiceNumber: "1",
      }),
    ).resolves.toBeUndefined();
    await expect(
      emails.verificationCode("a@example.com", "123456", 10),
    ).rejects.toBeInstanceOf(SendGridError);
  });
});
