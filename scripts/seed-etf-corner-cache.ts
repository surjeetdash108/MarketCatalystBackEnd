import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { EtfMarketService } from "../src/live/etf-market.service";
import { FirebaseAdminService } from "../src/common/firebase-admin.provider";

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["log", "warn", "error"] });

  try {
    const service = app.get(EtfMarketService);
    const firebase = app.get(FirebaseAdminService);

    console.log("Generating categorized ETFs from live Massive API...");
    const rawData = await service.getCategorizedEtfs();

    console.log("\nRaw categories breakdown:");
    for (const c of rawData.categories) {
      console.log(`- ${c.id}: ${c.funds.length} funds`);
    }

    // Cap each category to top 150 funds so it fits comfortably within Firestore's 1MB limit
    const MAX_PER_CATEGORY = 150;
    const cleanCategories = rawData.categories.map((c) => ({
      id: c.id,
      label: c.label,
      funds: c.funds.slice(0, MAX_PER_CATEGORY),
    }));

    const cleanData = {
      updatedAt: Date.now(),
      source: "massive-polygon",
      categories: cleanCategories,
      largest: cleanCategories.find(c => c.id === "largest")?.funds || [],
      equity: cleanCategories.find(c => c.id === "equity")?.funds || [],
      bitcoin: cleanCategories.find(c => c.id === "bitcoin")?.funds || [],
      ethereum: cleanCategories.find(c => c.id === "ethereum")?.funds || [],
      gold: cleanCategories.find(c => c.id === "gold")?.funds || [],
      fixedIncome: cleanCategories.find(c => c.id === "fixedIncome")?.funds || [],
      realEstate: cleanCategories.find(c => c.id === "realEstate")?.funds || [],
      totalMarket: cleanCategories.find(c => c.id === "totalMarket")?.funds || [],
      commodities: cleanCategories.find(c => c.id === "commodities")?.funds || [],
      leveraged: cleanCategories.find(c => c.id === "leveraged")?.funds || [],
    };

    const jsonStr = JSON.stringify(cleanData);
    console.log(`\nCapped document size: ${(jsonStr.length / 1024).toFixed(1)} KB (Firestore limit: 1024 KB)`);

    console.log("Saving clean ETF market cache to Firestore 'etf_corner_cache/latest'...");
    const ref = firebase.firestore.collection("etf_corner_cache").doc("latest");
    await ref.set(cleanData);
    console.log("✔ Successfully persisted clean ETF market cache to Firestore!");

  } catch (err: any) {
    console.error("Error:", err.message);
  } finally {
    await app.close();
  }
}

main().catch(console.error);
