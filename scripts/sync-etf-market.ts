import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { EtfMarketService } from "../src/live/etf-market.service";
import { FirebaseAdminService } from "../src/common/firebase-admin.provider";

async function main() {
  console.log("==================================================");
  console.log(" MarketCatalyst Weekly ETF Market Sync & Rotation");
  console.log(" Preserving 100% of discovered ETF funds in Firestore");
  console.log(" Current Week: etf_market_current");
  console.log(" Prior Week:   etf_market_previous");
  console.log("==================================================");

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["log", "warn", "error"],
  });

  try {
    const service = app.get(EtfMarketService);
    const firebase = app.get(FirebaseAdminService);
    const db = firebase.firestore;

    console.log("\nStarting full universe ETF sync & weekly rotation...");
    const started = Date.now();
    const result = await service.syncUniverse();

    console.log(`\nSync finished in ${Date.now() - started}ms!`);
    console.log(`Categories count: ${result.categories.length}`);

    const summaryTable: any[] = [];
    for (const cat of result.categories) {
      summaryTable.push({
        Category: cat.label,
        ID: cat.id,
        "Total Funds": cat.funds.length,
        "Top Fund": cat.funds[0]?.symbol || "—",
        "Top Fund AUM": cat.funds[0]?.badge || "—",
      });
    }
    console.table(summaryTable);

    const totalFunds = result.categories.reduce((acc, c) => acc + c.funds.length, 0);
    console.log(`\n✔ Total Funds Preserved: ${totalFunds}`);

    // Verify Firestore documents in etf_market_current
    console.log("\nVerifying Firestore `etf_market_current` documents:");
    const currentSnap = await db.collection("etf_market_current").get();
    for (const doc of currentSnap.docs) {
      const data = doc.data();
      const bytes = Buffer.byteLength(JSON.stringify(data));
      const count = doc.id.startsWith("_") ? data.totalFunds : data.count || data.funds?.length || 0;
      console.log(`  - etf_market_current/${doc.id}: ${count} funds (${(bytes / 1024).toFixed(1)} KB)`);
    }

    // Verify fallback read
    console.log("\nTesting fallback DB read from service...");
    const verifiedData = await service.readFromFirestore();
    const verifiedTotal = verifiedData?.categories?.reduce((a, c) => a + c.funds.length, 0) || 0;
    console.log(`✔ Service readFromFirestore returned ${verifiedTotal} total funds across ${verifiedData?.categories?.length} categories`);

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
