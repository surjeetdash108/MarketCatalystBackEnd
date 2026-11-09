import { Body, Controller, INestApplication, Patch } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { createGlobalValidationPipe } from "../common/validation";
import {
  InvestorProfilePatchDto,
  PROFILE_FIELDS,
  pickProfileFields,
} from "./profile.dto";

/**
 * The profile write has two independent protection layers. Each is tested on
 * its own here, so removing either one fails a test — profile.controller.spec
 * only catches the removal of both.
 */

const HOSTILE = {
  tier: "pro",
  currentPlan: "elite",
  subscriptionStatus: "ACTIVE",
  subscriptionExpiryDate: "2099-12-31",
  featureFlags: { strategyLab: true },
  stripeCustomerId: "cus_x",
  stripeSubId: "sub_x",
  uid: "someone-else",
  email: "attacker@example.com",
  createdAt: "1999-01-01",
};

describe("layer 1: pickProfileFields (allowlist), without the pipe", () => {
  it("keeps profile fields and drops every server-owned field", () => {
    const out = pickProfileFields({
      name: "A",
      riskTolerance: "High",
      ...HOSTILE,
    });
    expect(out).toEqual({ name: "A", riskTolerance: "High" });
  });

  it("returns only keys from PROFILE_FIELDS, whatever the input", () => {
    const input: Record<string, unknown> = { ...HOSTILE };
    for (const k of PROFILE_FIELDS) input[k] = "v";
    expect(Object.keys(pickProfileFields(input)).sort()).toEqual(
      [...PROFILE_FIELDS].sort(),
    );
  });

  it("treats null/undefined bodies as empty", () => {
    expect(pickProfileFields(undefined)).toEqual({});
    expect(pickProfileFields(null)).toEqual({});
  });
});

/** A handler with NO allowlist: whatever reaches it is what the pipe let through. */
@Controller("probe")
class ProbeController {
  @Patch()
  echo(@Body() body: InvestorProfilePatchDto): Record<string, unknown> {
    return { ...(body as Record<string, unknown>) };
  }
}

describe("layer 2: global ValidationPipe, without the allowlist", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
  });
  afterAll(() => app.close());

  it("strips every property the DTO does not declare", async () => {
    const res = await request(app.getHttpServer())
      .patch("/probe")
      .send({ name: "A", ...HOSTILE })
      .expect(200);
    expect(res.body).toEqual({ name: "A" });
  });

  it("rejects declared fields of the wrong type", async () => {
    await request(app.getHttpServer())
      .patch("/probe")
      .send({ name: { $ne: null } })
      .expect(400);
  });
});
