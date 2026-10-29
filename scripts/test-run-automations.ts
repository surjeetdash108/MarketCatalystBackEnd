import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { D03PremarketMoversJob } from "../src/sync/d03-premarket-movers.job";
import { D04AnalystCallsJob } from "../src/sync/d04-analyst-calls.job";
import { D06WhyItMovedJob } from "../src/sync/d06-why-it-moved.job";

process.env.FORCE_RUN = "true";
process.env.ENABLE_D03_AUTOMATION = "true";
process.env.ENABLE_D04_AUTOMATION = "true";
process.env.ENABLE_D06_AUTOMATION = "true";

async function main() {
  console.log("==================================================");
  console.log(" Triggering Test Posts for D03, D04, D06 with Today's Data");
  console.log("==================================================");

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["log", "warn", "error"],
  });

  try {
    console.log("\n--- 1. Generating D03 Test Post (Premarket Movers) ---");
    const d03 = app.get(D03PremarketMoversJob);
    const res03 = await d03.run();
    console.log("D03 Result:", res03);

    console.log("\n--- 2. Generating D04 Test Post (Analyst Calls) ---");
    const d04 = app.get(D04AnalystCallsJob);
    const res04 = await d04.run();
    console.log("D04 Result:", res04);

    console.log("\n--- 3. Generating D06 Test Post (Mid-Morning Movers by Cap) ---");
    const d06 = app.get(D06WhyItMovedJob);
    const res06 = await d06.run();
    console.log("D06 Result:", res06);

    console.log("\n==================================================");
    console.log(" GENERATED POST URLS:");
    console.log(" D03 (Premarket Movers):", res03.url);
    console.log(" D04 (Analyst Calls):", res04.url);
    console.log(" D06 (Mid-Morning Movers by Market Cap):", res06.url);
    console.log("==================================================");
  } catch (err: any) {
    console.error("Test run failed:", err);
    process.exit(1);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
