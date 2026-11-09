import { readFileSync } from "fs";
import { join } from "path";
import { auditUserDoc } from "./plan-field-audit";

describe("auditUserDoc", () => {
  it("ignores a plain free profile and the server defaults", () => {
    expect(auditUserDoc("u", { name: "A", email: "a@x.com" })).toBeNull();
    expect(
      auditUserDoc("u", {
        tier: "free",
        currentPlan: "free",
        subscriptionStatus: "NONE",
        featureFlags: {},
      }),
    ).toBeNull();
  });

  it("flags any non-default plan, subscription, Stripe or feature-flag field", () => {
    const f = auditUserDoc("u1", {
      email: "a@x.com",
      tier: "pro",
      currentPlan: "pro",
      subscriptionStatus: "ACTIVE",
      subscriptionExpiryDate: "2099-12-31",
      featureFlags: { strategyLab: true },
      stripeSubId: "sub_x",
      name: "not audited",
    });
    expect(f).toEqual({
      uid: "u1",
      email: "a@x.com",
      fields: {
        tier: "pro",
        currentPlan: "pro",
        subscriptionStatus: "ACTIVE",
        subscriptionExpiryDate: "2099-12-31",
        featureFlags: { strategyLab: true },
        stripeSubId: "sub_x",
      },
    });
  });
});

describe("scripts/audit-plan-fields.ts", () => {
  const src = readFileSync(
    join(__dirname, "../../scripts/audit-plan-fields.ts"),
    "utf8",
  );

  it("is read-only: no Firestore or Auth write call anywhere", () => {
    expect(src).not.toMatch(
      /\.(set|update|delete|create|add|commit|recursiveDelete)\(/,
    );
    expect(src).not.toMatch(
      /\.batch\(|runTransaction|bulkWriter|setCustomUserClaims|deleteUser/,
    );
  });

  it("refuses to run without an explicit --project and --confirm-read-only", () => {
    expect(src).toMatch(/--project/);
    expect(src).toMatch(/confirm-read-only/);
  });

  it("never prints emails to stdout (they go to the output file only)", () => {
    expect(src).not.toMatch(/console\.(log|info|warn|error)\([^)]*email/);
  });
});
