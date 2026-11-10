import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { configOf } from "../../test/support/billing-harness";
import { AdminGuard } from "./admin.guard";
import { FirebaseAdminService } from "./firebase-admin.provider";

const ADMIN = "admin@example.com";
const tokens: Record<string, Record<string, unknown>> = {
  good: {
    email: ADMIN,
    email_verified: true,
    firebase: { sign_in_second_factor: "totp" },
  },
  unverified: {
    email: ADMIN,
    email_verified: false,
    firebase: { sign_in_second_factor: "totp" },
  },
  nomfa: { email: ADMIN, email_verified: true, firebase: {} },
  user: {
    email: "someone@example.com",
    email_verified: true,
    firebase: { sign_in_second_factor: "totp" },
  },
  staff: {
    email: "ops-staff@example.com",
    email_verified: true,
    staff: true,
    plan: "elite",
    firebase: { sign_in_provider: "google.com", sign_in_second_factor: "totp" },
  },
};

function guard(env: Record<string, string> = {}) {
  const firebase = {
    auth: {
      verifyIdToken: (t: string) =>
        tokens[t]
          ? Promise.resolve(tokens[t])
          : Promise.reject(new Error("bad")),
    },
  } as unknown as FirebaseAdminService;
  return new AdminGuard(firebase, configOf({ ADMIN_EMAIL: ADMIN, ...env }));
}

function ctx(token?: string) {
  const req: {
    headers: Record<string, string>;
    adminActor?: string;
    adminEmail?: string;
  } = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  return {
    req,
    c: {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext,
  };
}

describe("AdminGuard", () => {
  it("admits the admin with a verified email and a second factor, and records the actor", async () => {
    const { req, c } = ctx("good");
    await expect(guard().canActivate(c)).resolves.toBe(true);
    expect(req.adminActor).toBe(ADMIN);
  });

  it("refuses an unverified admin email (403 admin_email_unverified)", async () => {
    await expect(
      guard().canActivate(ctx("unverified").c),
    ).rejects.toMatchObject({ response: { code: "admin_email_unverified" } });
  });

  it("refuses an admin sign-in without a second factor (403 admin_mfa_required)", async () => {
    await expect(guard().canActivate(ctx("nomfa").c)).rejects.toMatchObject({
      response: { code: "admin_mfa_required" },
    });
  });

  it("both checks can be relaxed explicitly by env (until MFA is enrolled)", async () => {
    await expect(
      guard({ ADMIN_REQUIRE_MFA: "false" }).canActivate(ctx("nomfa").c),
    ).resolves.toBe(true);
    await expect(
      guard({ ADMIN_REQUIRE_EMAIL_VERIFIED: "false" }).canActivate(
        ctx("unverified").c,
      ),
    ).resolves.toBe(true);
  });

  it("refuses non-admin and missing tokens", async () => {
    await expect(guard().canActivate(ctx("user").c)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(guard().canActivate(ctx().c)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("staff is NOT admin: a verified staff claim never opens the admin console", async () => {
    await expect(guard().canActivate(ctx("staff").c)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      guard({
        ADMIN_REQUIRE_MFA: "false",
        ADMIN_REQUIRE_EMAIL_VERIFIED: "false",
      }).canActivate(ctx("staff").c),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("IAM path (scheduler) is admitted only when trusted, as actor 'iam'", async () => {
    const { req, c } = ctx();
    await expect(
      guard({ ADMIN_GUARD_TRUST_IAM: "true" }).canActivate(c),
    ).resolves.toBe(true);
    expect(req.adminActor).toBe("iam");
  });
});
