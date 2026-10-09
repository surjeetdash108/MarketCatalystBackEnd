import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { EtfHoldingsService, POPULAR_16_ETFS } from "../src/market-data/etf-holdings.service";

async function main() {
  console.log("==================================================");
  console.log(" MarketCatalyst Popular 16 ETF Holdings Sync");
  console.log(` Target ETFs: ${POPULAR_16_ETFS.join(", ")}`);
  console.log("==================================================");

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["log", "warn", "error"],
  });

  try {
    const service = app.get(EtfHoldingsService);
    console.log("Syncing all 16 Popular ETFs from FMP into Firestore...");
    const result = await service.syncAllPopular();
    console.log("\nSync completed:");
    console.log(`Succeeded: ${result.successCount}/${POPULAR_16_ETFS.length}`);
    if (result.errors.length > 0) {
      console.warn("Errors:", result.errors);
    }
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
