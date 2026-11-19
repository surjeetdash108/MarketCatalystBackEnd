import { readdirSync } from "fs";
import { join } from "path";
import {
  escapeHtml,
  noticeRow,
  renderTemplate,
  unsubscribeHtml,
  type TemplateName,
} from "./email-template";
import { signLinkToken, verifyLinkToken } from "./email-links";

const base = {
  logoUrl: "https://app.marketcatalyst.ai/email/logo.png",
  firstName: "Ana",
  email: "ana@example.com",
  unsubscribeHtml: "",
};
const SAMPLE: Record<TemplateName, Record<string, string | boolean>> = {
  "verify-email": {
    ...base,
    code: "123456",
    minutes: "10",
    verifyUrl: "https://app.marketcatalyst.ai/verify-email",
  },
  welcome: base,
  "getting-started": base,
  "first-activation": base,
  "trial-started": { ...base, trialEnd: "26 Nov 2026" },
  "trial-ending": { ...base, trialEnd: "26 Nov 2026" },
  "trial-ended": { ...base, trialEnd: "26 Nov 2026" },
  "pro-confirmed": {
    ...base,
    billing: "Monthly",
    amount: "$59.00",
    card: "Card on file",
    nextBilling: "19 Dec 2026",
  },
  "elite-confirmed": {
    ...base,
    billing: "Annual",
    amount: "$1,791.00 / year",
    card: "Card on file",
    nextBilling: "19 Nov 2027",
  },
  "pro-renewal-reminder": {
    ...base,
    billing: "Annual",
    amount: "$531.00",
    per: "year",
    renewalDate: "19 Nov 2027",
    monthly: false,
  },
  "elite-renewal-reminder": {
    ...base,
    billing: "Annual",
    amount: "$1,791.00",
    per: "year",
    renewalDate: "19 Nov 2027",
  },
  "password-reset": {
    ...base,
    resetUrl:
      "https://app.marketcatalyst.ai/auth/action?mode=resetPassword&oobCode=x",
  },
  "login-alert": {
    ...base,
    time: "20 Nov 2026 · 10:00 ET",
    device: "Chrome on Mac",
    location: "Austin, US",
    ip: "1.2.3.4",
    secureUrl: "https://x/secure",
  },
  "account-deleted": { ...base, date: "20 Nov 2026" },
  notice: {
    ...base,
    subject: "S",
    preheader: "P",
    eyebrow: "E",
    headlineHtml: "H",
    introHtml: "I",
    cardTitle: "C",
    rowsHtml: noticeRow("r", true),
    ctaUrl: "https://x",
    ctaLabel: "Go",
    noteHtml: "N",
    reason: "R",
  },
};

describe("branded email templates", () => {
  it("every template file is covered", () => {
    const files = readdirSync(join(__dirname, "templates"))
      .map((f) => f.replace(/\.html$/, ""))
      .sort();
    expect(files).toEqual(Object.keys(SAMPLE).sort());
  });
  for (const [name, vars] of Object.entries(SAMPLE)) {
    it(`${name} renders with no placeholders or sample data left`, () => {
      const html = renderTemplate(name as TemplateName, vars);
      expect(html).not.toMatch(
        /\{\{|\}\}|Vinay|vinay@example|data:image|settings\/billing|settings\/security|auth\/(reset|verify)\?token|#video-/,
      );
      expect(html).toContain("https://app.marketcatalyst.ai/email/logo.png");
    });
  }
  it("a missing value is an error, values are escaped, IF blocks follow their flag", () => {
    expect(() =>
      renderTemplate("welcome", { logoUrl: "x", unsubscribeHtml: "" }),
    ).toThrow(/firstName/);
    expect(
      renderTemplate("welcome", { ...base, firstName: "<b>x</b>" }),
    ).toContain("&lt;b&gt;x&lt;/b&gt;");
    const r = SAMPLE["pro-renewal-reminder"];
    expect(
      renderTemplate("pro-renewal-reminder", { ...r, monthly: true }),
    ).toContain("Paying monthly?");
    expect(
      renderTemplate("pro-renewal-reminder", { ...r, monthly: false }),
    ).not.toContain("Paying monthly?");
    expect(escapeHtml(`"'&`)).toBe("&quot;&#39;&amp;");
  });
  it("renewal reminders say the plan renews automatically, with a Manage plan button", () => {
    const html = renderTemplate(
      "elite-renewal-reminder",
      SAMPLE["elite-renewal-reminder"],
    );
    expect(html).toContain("renews automatically on");
    expect(html).toContain("Manage plan");
    expect(html).not.toMatch(/Renew Elite|Renew before/);
    expect(html).toContain("https://app.marketcatalyst.ai/manage-plan");
  });
  it("the unsubscribe line appears only when given a link", () => {
    expect(
      renderTemplate("getting-started", {
        ...base,
        unsubscribeHtml: unsubscribeHtml("https://u/x"),
      }),
    ).toContain(">Unsubscribe</a>");
    expect(unsubscribeHtml(null)).toBe("");
  });
});

describe("signed email links", () => {
  it("round-trips, and rejects another purpose, a tampered token, an old one", () => {
    const t = signLinkToken("s3cret", "uid1", "unsubscribe", 1000);
    expect(verifyLinkToken("s3cret", t, "unsubscribe", 60_000, 2000)).toBe(
      "uid1",
    );
    expect(verifyLinkToken("s3cret", t, "secure", 60_000, 2000)).toBeNull();
    expect(verifyLinkToken("other", t, "unsubscribe", 60_000, 2000)).toBeNull();
    expect(
      verifyLinkToken(
        "s3cret",
        t.slice(0, -2) + "xx",
        "unsubscribe",
        60_000,
        2000,
      ),
    ).toBeNull();
    expect(
      verifyLinkToken("s3cret", t, "unsubscribe", 60_000, 1000 + 61_000),
    ).toBeNull();
  });
});
