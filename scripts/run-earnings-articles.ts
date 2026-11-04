import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { EarningsArticleJob } from "../src/sync/earnings-article.job";
import { etDate } from "../src/common/market-calendar.util";

async function main() {
  console.log("==================================================");
  console.log(" MarketCatalyst Earnings Article Automation");
  console.log("==================================================");

  // Parse command line arguments
  const args = process.argv.slice(2);
  const getArg = (prefix: string) => {
    const found = args.find((a) => a.startsWith(prefix));
    return found ? found.split("=")[1] : undefined;
  };

  const dateArg = getArg("--date") || process.env.EARNINGS_DATE || etDate();
  const tickersArg = getArg("--tickers") || process.env.EARNINGS_TICKERS;
  const limitArg = getArg("--limit") || "5";
  // Safe-by-default: only save draft to firestore if requested, otherwise generate & download preview HTML
  const saveDraftArg = getArg("--saveDraft") ?? "false";

  console.log(`Target Date: ${dateArg}`);
  if (tickersArg) console.log(`Selected Tickers: ${tickersArg}`);
  console.log(`Limit: ${limitArg}`);
  console.log(`Save to Firestore Draft: ${saveDraftArg}`);
  console.log("==================================================");

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["log", "warn", "error"],
  });

  try {
    const job = app.get(EarningsArticleJob);
    console.log(`\nExecuting EarningsArticleJob for ${dateArg}...`);
    const result = await job.run({
      date: dateArg,
      tickers: tickersArg,
      limit: limitArg,
      saveDraft: saveDraftArg,
    });

    console.log("\n==================================================");
    console.log(" EXECUTION COMPLETED SUCCESSFULLY");
    console.log(` Generated ${result.count} Earnings Article HTML files:`);
    result.files.forEach((file: string, idx: number) => {
      console.log(`  ${idx + 1}. ${file}`);
    });
    console.log("==================================================");
  } catch (err: unknown) {
    console.error("\nExecution failed:", (err as Error).message);
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

