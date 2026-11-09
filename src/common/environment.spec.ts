import { ConfigService } from "@nestjs/config";
import { currentProjectId, isProductionProject } from "./environment";

const cfg = (env: Record<string, string | undefined>) =>
  ({
    get: (k: string, d?: unknown) => env[k] ?? d,
  }) as unknown as ConfigService;

describe("isProductionProject", () => {
  it("is true for the production Firebase project", () => {
    expect(
      isProductionProject(
        cfg({ FIREBASE_PROJECT_ID: "market-catalyst-502415" }),
      ),
    ).toBe(true);
  });
  it("is false for staging, demo and local projects", () => {
    for (const p of ["market-catalyst-stage", "demo-test", undefined]) {
      expect(isProductionProject(cfg({ FIREBASE_PROJECT_ID: p }))).toBe(false);
    }
  });
  it("honours PRODUCTION_PROJECT_IDS and falls back to GOOGLE_CLOUD_PROJECT", () => {
    expect(
      isProductionProject(
        cfg({
          GOOGLE_CLOUD_PROJECT: "acme-prod",
          PRODUCTION_PROJECT_IDS: "acme-prod, other",
        }),
      ),
    ).toBe(true);
    expect(currentProjectId(cfg({ GOOGLE_CLOUD_PROJECT: "x" }))).toBe("x");
  });
});
