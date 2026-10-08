import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { PremarketPostJob } from "../src/sync/premarket-post.job";

const hasForce = process.argv.includes("--force") || process.env.FORCE_RUN === "true";
if (hasForce) {
  process.env.FORCE_RUN = "true";
  process.env.FORCE_PREMARKET = "true";
}

async function main() {
  console.log("==================================================");
  console.log(" MarketCatalyst Pre-Market Post Automation (Morning)");
  console.log(` Force run enabled: ${hasForce}`);
  console.log("==================================================");

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["log", "warn", "error"],
  });

  try {
    const job = app.get(PremarketPostJob);
    console.log("Executing PremarketPostJob...");
    const result = await job.run();
    console.log("\nExecution completed successfully:");
    console.log(JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error("\nExecution failed:", err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
