import { ConfigService } from "@nestjs/config";
import { FakeFirestore } from "../../test/support/fake-firestore";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { FeatureFlagsService } from "./feature-flags.service";
import { SUBSCRIPTIONS_FLAG } from "./feature-flags.registry";

/**
 * SUBSCRIPTIONS_ENABLED is the release switch for the whole subscription
 * system. Default OFF in the production project, ON everywhere else; an
 * explicit env value beats the default; a Firestore override (the admin
 * toggle) beats both — that is what makes it switchable without a deploy.
 */
function service(env: Record<string, string>, fs = new FakeFirestore()) {
  const config = {
    get: (k: string, d?: unknown) => env[k] ?? d,
  } as unknown as ConfigService;
  return {
    svc: new FeatureFlagsService(
      { firestore: fs } as unknown as FirebaseAdminService,
      config,
    ),
    fs,
  };
}

describe("SUBSCRIPTIONS_ENABLED", () => {
  it("is OFF by default in the production project", async () => {
    const { svc } = service({ FIREBASE_PROJECT_ID: "market-catalyst-502415" });
    expect(await svc.isEnabled(SUBSCRIPTIONS_FLAG)).toBe(false);
  });

  it("is ON by default in staging and local", async () => {
    expect(
      await service({
        FIREBASE_PROJECT_ID: "market-catalyst-stage",
      }).svc.isEnabled(SUBSCRIPTIONS_FLAG),
    ).toBe(true);
    expect(await service({}).svc.isEnabled(SUBSCRIPTIONS_FLAG)).toBe(true);
  });

  it("an explicit env value beats the environment default", async () => {
    const { svc } = service({
      FIREBASE_PROJECT_ID: "market-catalyst-502415",
      SUBSCRIPTIONS_ENABLED: "true",
    });
    expect(await svc.isEnabled(SUBSCRIPTIONS_FLAG)).toBe(true);
  });

  it("the admin's Firestore override wins, so it switches without a deploy", async () => {
    const { svc } = service({ FIREBASE_PROJECT_ID: "market-catalyst-stage" });
    await svc.setOverride(SUBSCRIPTIONS_FLAG, false);
    expect(await svc.isEnabled(SUBSCRIPTIONS_FLAG)).toBe(false);
    await svc.setOverride(SUBSCRIPTIONS_FLAG, true);
    expect(await svc.isEnabled(SUBSCRIPTIONS_FLAG)).toBe(true);
  });

  it("boot seeding never pins it (it would override the per-environment default)", async () => {
    const { svc, fs } = service({
      FIREBASE_PROJECT_ID: "market-catalyst-502415",
    });
    await svc.seed();
    const flags = (fs.read("feature_flags", "default")?.flags ?? {}) as Record<
      string,
      unknown
    >;
    expect(flags).not.toHaveProperty(SUBSCRIPTIONS_FLAG);
    expect(flags).toHaveProperty("FF_MOVERS");
  });
});
