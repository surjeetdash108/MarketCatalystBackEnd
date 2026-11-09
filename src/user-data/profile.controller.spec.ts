import { readFileSync } from "fs";
import { join } from "path";
import { ExecutionContext, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { FakeFirestore } from "../../test/support/fake-firestore";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { createGlobalValidationPipe } from "../common/validation";
import { ProfileController } from "./profile.controller";

/**
 * PATCH /api/profile is the only route that writes `users/{uid}` on a user's
 * behalf. It used to spread the raw body into the document, so a signed-in user
 * could write `currentPlan: "pro"`, `subscriptionStatus: "ACTIVE"` and a far
 * expiry date and be resolved as a paying customer. These tests pin the fix:
 * only profile fields are accepted; plan, billing and identity fields are set
 * by the server and never taken from the request.
 */

const UID = "user-1";
const AUTH_EMAIL = "real.person@example.com";

/** Every field the client must never be able to set. */
const HOSTILE = {
  tier: "pro",
  currentPlan: "elite",
  subscriptionStatus: "ACTIVE",
  subscriptionStartDate: "2026-01-01",
  subscriptionExpiryDate: "2099-12-31",
  featureFlags: { adminDashboard: true, strategyLab: true },
  stripeCustomerId: "cus_fake",
  stripeSubId: "sub_fake",
  uid: "someone-else",
  email: "attacker@example.com",
  createdAt: "1999-01-01T00:00:00.000Z",
};

describe("PATCH /api/profile", () => {
  let app: INestApplication;
  let fs: FakeFirestore;

  beforeEach(async () => {
    fs = new FakeFirestore();
    const firebase = {
      firestore: fs,
      auth: {
        getUser: () => Promise.resolve({ uid: UID, email: AUTH_EMAIL }),
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ProfileController],
      providers: [{ provide: FirebaseAdminService, useValue: firebase }],
    })
      .overrideGuard(FirebaseAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ uid?: string }>().uid = UID;
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("creates the profile with server-set plan fields, ignoring client plan/billing/identity fields", async () => {
    await request(app.getHttpServer())
      .patch("/api/profile")
      .send({ name: "Real Person", riskTolerance: "Moderate", ...HOSTILE })
      .expect(200);

    const doc = fs.read("users", UID);
    expect(doc.name).toBe("Real Person");
    expect(doc.riskTolerance).toBe("Moderate");
    expect(doc.uid).toBe(UID);
    expect(doc.email).toBe(AUTH_EMAIL);
    expect(doc.tier).toBe("free");
    expect(doc.currentPlan).toBe("free");
    expect(doc.subscriptionStatus).toBe("NONE");
    expect(doc.createdAt).not.toBe(HOSTILE.createdAt);
    for (const k of [
      "subscriptionStartDate",
      "subscriptionExpiryDate",
      "featureFlags",
      "stripeCustomerId",
      "stripeSubId",
    ]) {
      expect(doc).not.toHaveProperty(k);
    }
  });

  it("never changes server-owned fields on an existing profile", async () => {
    // As the webhook would have written it for a paying customer.
    const existing = {
      uid: UID,
      email: AUTH_EMAIL,
      name: "Old Name",
      tier: "free",
      currentPlan: "starter",
      subscriptionStatus: "ACTIVE",
      subscriptionExpiryDate: "2026-12-09",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    fs.seed("users", UID, existing);

    await request(app.getHttpServer())
      .patch("/api/profile")
      .send({ name: "New Name", ...HOSTILE })
      .expect(200);

    const doc = fs.read("users", UID);
    expect(doc.name).toBe("New Name");
    for (const k of [
      "uid",
      "email",
      "tier",
      "currentPlan",
      "subscriptionStatus",
      "subscriptionExpiryDate",
      "createdAt",
    ] as const) {
      expect(doc[k]).toBe(existing[k]);
    }
    expect(doc).not.toHaveProperty("featureFlags");
    expect(doc).not.toHaveProperty("stripeSubId");
  });

  it("rejects a profile field of the wrong type with 400 and writes nothing", async () => {
    await request(app.getHttpServer())
      .patch("/api/profile")
      .send({ name: 42 })
      .expect(400);
    expect(fs.read("users", UID)).toBeUndefined();
  });

  it("accepts the asset-class list as strings only", async () => {
    await request(app.getHttpServer())
      .patch("/api/profile")
      .send({ preferredAssetClasses: ["Stocks", "ETFs"] })
      .expect(200);
    expect(fs.read("users", UID).preferredAssetClasses).toEqual([
      "Stocks",
      "ETFs",
    ]);

    await request(app.getHttpServer())
      .patch("/api/profile")
      .send({ preferredAssetClasses: [{ $gt: "" }] })
      .expect(400);
  });
});

describe("bootstrap", () => {
  it("installs the global validation pipe so every class DTO is enforced", () => {
    const main = readFileSync(join(__dirname, "../main.ts"), "utf8");
    expect(main).toMatch(
      /useGlobalPipes\(\s*createGlobalValidationPipe\(\)\s*\)/,
    );
  });
});
