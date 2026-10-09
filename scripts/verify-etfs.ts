import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { FirebaseAdminService } from "../src/common/firebase-admin.provider";
import { POPULAR_16_ETFS } from "../src/market-data/etf-holdings.service";

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  try {
    const firebase = app.get(FirebaseAdminService);
    const db = firebase.firestore;

    const results: any[] = [];
    for (const sym of POPULAR_16_ETFS) {
      const doc = await db.collection("etf_holdings").doc(sym).get();
      if (!doc.exists) {
        results.push({ ETF: sym, Exists: "NO" });
        continue;
      }
      const data = doc.data()!;
      const top = data.holdings?.[0];
      results.push({
        ETF: sym,
        Type: data.etfType,
        "As-of": data.asOfDate,
        Holdings: data.holdingsCount,
        "Top 10 Conc.": `${data.top10Concentration}%`,
        "Top Holding": top ? `${top.asset || top.name} (${top.weightPercentage}%)` : "—",
        "Top Holding Name": (top?.name || "—").slice(0, 24),
      });
    }
    console.table(results);
  } finally {
    await app.close();
  }
}

main().catch(console.error);
