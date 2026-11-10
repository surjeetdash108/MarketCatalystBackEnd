import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("exposes git commit hash and build time on GET /health", () => {
    const controller = new HealthController();
    const res = controller.check();
    expect(res.ok).toBe(true);
    expect(res.service).toBe("market-catalyst-backend");
    expect(typeof (res as any).commit).toBe("string");
    expect((res as any).commit.length).toBeGreaterThan(0);
    expect(typeof (res as any).buildTime).toBe("string");
    expect((res as any).buildTime.length).toBeGreaterThan(0);
  });
});
