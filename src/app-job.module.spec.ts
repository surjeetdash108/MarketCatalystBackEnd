// blogs-admin imports the ESM-only `marked`.
jest.mock("marked", () => ({ marked: { parse: (s: string) => s } }));

import { Test } from "@nestjs/testing";
import { AppJobModule } from "./app-job.module";
import { AppModule } from "./app.module";

/**
 * Both root module graphs must resolve. The premarket Cloud Run Job boots
 * AppJobModule (job-entry.ts) from the same image as the services; a missing
 * global module there only shows up when the job starts in production
 * ("Nest can't resolve dependencies of the EntitlementGuard").
 * compile() resolves every provider without running lifecycle hooks, so no
 * job, seed or network call runs.
 */
jest.setTimeout(60_000);
const ENV = {
  NODE_ENV: "test",
  FIREBASE_PROJECT_ID: "demo-boot",
  GOOGLE_CLOUD_PROJECT: "demo-boot",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:1",
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:1",
};

describe("root module graphs resolve", () => {
  const saved = { ...process.env };
  beforeAll(() => Object.assign(process.env, ENV));
  afterAll(() => {
    process.env = saved;
  });

  it.each([
    ["AppJobModule (premarket-job)", AppJobModule],
    ["AppModule (services)", AppModule],
  ])("%s compiles with every dependency resolved", async (_name, mod) => {
    const ref = await Test.createTestingModule({ imports: [mod] }).compile();
    await ref.close();
  });
});
