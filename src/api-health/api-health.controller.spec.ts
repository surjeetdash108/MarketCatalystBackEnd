import { HttpException, HttpStatus, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AdminGuard } from "../common/admin.guard";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { ApiHealthController } from "./api-health.controller";
import { ApiHealthService } from "./api-health.service";
import { JobsAdminService } from "./jobs-admin.service";
import { ScreenApiService } from "./screen-api.service";

/**
 * The HTTP surface of the admin Jobs and API Docs tabs, through the REAL
 * AdminGuard. "Only visible to the admin" is a requirement of these tabs, so it
 * is tested where it is enforced rather than assumed from the decorator.
 */

const ADMIN_EMAIL = "admin@marketcatalyst.ai";

describe("admin Jobs / API Docs endpoints", () => {
  let app: INestApplication;
  const jobsAdmin = {
    inventory: jest.fn(async () => ({ jobs: [], counts: {} })),
    recentRuns: jest.fn(async () => [{ id: "r1" }]),
    requestRun: jest.fn(async (name: string, by: string) => ({ run: { id: "r2", job: name, requestedBy: by }, message: "started" })),
  };
  const screenApis = { report: jest.fn(async () => ({ screens: [], apis: {} })) };
  const health = { check: jest.fn(async () => ({ endpoints: [] })) };

  const verifyIdToken = jest.fn(async (token: string) => {
    if (token === "admin-token") return { email: ADMIN_EMAIL, uid: "a" };
    if (token === "user-token") return { email: "someone@example.com", uid: "u" };
    throw new Error("not a Firebase token");
  });

  async function boot(trustIam: "true" | "false" | undefined) {
    const moduleRef = await Test.createTestingModule({
      controllers: [ApiHealthController],
      providers: [
        AdminGuard,
        { provide: FirebaseAdminService, useValue: { auth: { verifyIdToken } } },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: unknown) =>
              key === "ADMIN_GUARD_TRUST_IAM" ? (trustIam ?? fallback) : key === "ADMIN_EMAIL" ? ADMIN_EMAIL : fallback,
          },
        },
        { provide: ApiHealthService, useValue: health },
        { provide: JobsAdminService, useValue: jobsAdmin },
        { provide: ScreenApiService, useValue: screenApis },
      ],
    }).compile();
    const nest = moduleRef.createNestApplication();
    await nest.init();
    return nest;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    app = await boot("false"); // the live service's posture
  });
  afterEach(() => app.close());

  const endpoints: Array<[string, "get" | "post", string]> = [
    ["the job inventory", "get", "/api/admin/jobs"],
    ["the manual-run list", "get", "/api/admin/jobs/runs"],
    ["starting a run", "post", "/api/admin/jobs/news/run"],
    ["the screen/API catalogue", "get", "/api/admin/screen-apis"],
  ];

  describe.each(endpoints)("%s", (_label, method, url) => {
    it("refuses a request with no token", async () => {
      await request(app.getHttpServer())[method](url).expect(HttpStatus.UNAUTHORIZED);
      expect(jobsAdmin.requestRun).not.toHaveBeenCalled();
      expect(screenApis.report).not.toHaveBeenCalled();
      expect(jobsAdmin.inventory).not.toHaveBeenCalled();
    });

    it("refuses a signed-in user who is not the admin", async () => {
      await request(app.getHttpServer())[method](url).set("Authorization", "Bearer user-token").expect(HttpStatus.FORBIDDEN);
      expect(jobsAdmin.requestRun).not.toHaveBeenCalled();
      expect(screenApis.report).not.toHaveBeenCalled();
    });

    it("refuses a token that is not a Firebase token at all", async () => {
      await request(app.getHttpServer())[method](url).set("Authorization", "Bearer forged").expect(HttpStatus.UNAUTHORIZED);
    });
  });

  it("refuses an empty Authorization header even on the IAM-trust posture's opposite setting", async () => {
    // The live service must run with trust OFF; an unset value must behave the same.
    const unset = await boot(undefined);
    await request(unset.getHttpServer()).post("/api/admin/jobs/news/run").expect(HttpStatus.UNAUTHORIZED);
    await unset.close();
  });

  it("serves the admin the inventory, the runs and the catalogue, uncacheably", async () => {
    const auth = { Authorization: "Bearer admin-token" };
    const jobs = await request(app.getHttpServer()).get("/api/admin/jobs").set(auth).expect(200);
    expect(jobs.headers["cache-control"]).toBe("private, no-store");

    const runs = await request(app.getHttpServer()).get("/api/admin/jobs/runs?limit=7").set(auth).expect(200);
    expect(runs.body.runs).toEqual([{ id: "r1" }]);
    expect(jobsAdmin.recentRuns).toHaveBeenCalledWith(7);
    expect(runs.headers["cache-control"]).toBe("private, no-store");

    const docs = await request(app.getHttpServer()).get("/api/admin/screen-apis?fresh=1").set(auth).expect(200);
    expect(screenApis.report).toHaveBeenCalledWith({ fresh: true });
    expect(docs.headers["cache-control"]).toBe("private, no-store");

    await request(app.getHttpServer()).get("/api/admin/screen-apis").set(auth).expect(200);
    expect(screenApis.report).toHaveBeenLastCalledWith({ fresh: false });
  });

  it("routes /jobs/runs to the run list, not to the run-a-job route", async () => {
    await request(app.getHttpServer()).get("/api/admin/jobs/runs").set("Authorization", "Bearer admin-token").expect(200);
    expect(jobsAdmin.recentRuns).toHaveBeenCalledTimes(1);
    expect(jobsAdmin.requestRun).not.toHaveBeenCalled();
  });

  it("accepts a run with 202 and records the VERIFIED admin's email as who asked", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/admin/jobs/auto-purge/run")
      .set("Authorization", "Bearer admin-token")
      .send({ confirm: "auto-purge", clearStaleLock: false })
      .expect(HttpStatus.ACCEPTED);
    expect(res.body.run).toMatchObject({ job: "auto-purge", requestedBy: ADMIN_EMAIL });
    expect(jobsAdmin.requestRun).toHaveBeenCalledWith("auto-purge", ADMIN_EMAIL, { confirm: "auto-purge", clearStaleLock: false });
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("does not let a client choose who it is — a spoofed email in the body is ignored", async () => {
    await request(app.getHttpServer())
      .post("/api/admin/jobs/news/run")
      .set("Authorization", "Bearer admin-token")
      .send({ requestedBy: "ceo@example.com", adminEmail: "ceo@example.com" })
      .expect(HttpStatus.ACCEPTED);
    expect(jobsAdmin.requestRun.mock.calls[0][1]).toBe(ADMIN_EMAIL);
  });

  it("starts a run when no body is sent at all", async () => {
    await request(app.getHttpServer()).post("/api/admin/jobs/news/run").set("Authorization", "Bearer admin-token").expect(HttpStatus.ACCEPTED);
    expect(jobsAdmin.requestRun).toHaveBeenCalledWith("news", ADMIN_EMAIL, {});
  });

  it("passes a refusal through with its status and structured body", async () => {
    jobsAdmin.requestRun.mockRejectedValueOnce(
      new HttpException({ statusCode: 409, code: "JOB_LOCKED", message: "running now" }, HttpStatus.CONFLICT),
    );
    const res = await request(app.getHttpServer())
      .post("/api/admin/jobs/news/run")
      .set("Authorization", "Bearer admin-token")
      .expect(HttpStatus.CONFLICT);
    expect(res.body).toMatchObject({ code: "JOB_LOCKED", message: "running now" });
  });

  it("answers 503 with a reason when the manual-run list cannot be read", async () => {
    jobsAdmin.recentRuns.mockRejectedValueOnce(new Error("firestore down"));
    const res = await request(app.getHttpServer()).get("/api/admin/jobs/runs").set("Authorization", "Bearer admin-token").expect(503);
    expect(res.body).toMatchObject({ code: "RUNS_UNAVAILABLE" });
    expect(res.body.message).toContain("firestore down");
  });

  it("leaves the existing apihealth endpoint where it was", async () => {
    await request(app.getHttpServer()).get("/api/admin/apihealth").set("Authorization", "Bearer admin-token").expect(200);
    expect(health.check).toHaveBeenCalledTimes(1);
    await request(app.getHttpServer()).get("/api/admin/apihealth").expect(401);
  });
});
