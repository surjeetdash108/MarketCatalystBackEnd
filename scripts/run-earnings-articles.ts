/**
 * Runs one pass of the earnings-article job locally.
 *
 * Defaults to --mode=dry: builds the articles from live FMP data and writes
 * each full page to --out (if given) without claiming, marking or posting
 * anything. --mode=draft|publish runs the real pass against the configured
 * Firestore — the same thing the per-minute scheduler does.
 *
 *   npm run sync:earnings-articles -- --dates=2026-11-04 --tickers=FIG,CVS --out=/tmp/ea
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { EarningsArticleJob } from "../src/sync/earnings-article.job";

async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  const mode = arg("mode") ?? "dry";
  const out = arg("out");

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["log", "warn", "error"] });
  try {
    const job = app.get(EarningsArticleJob);
    const result = await job.run({
      mode,
      ...(arg("dates") ? { dates: arg("dates")! } : {}),
      ...(arg("tickers") ? { tickers: arg("tickers")! } : {}),
    });
    if (out && result.previews?.length) {
      fs.mkdirSync(out, { recursive: true });
      for (const p of result.previews) {
        const file = path.join(out, `${p.symbol}.html`);
        fs.writeFileSync(file, p.documentHtml, "utf-8");
        console.log(`preview ${p.symbol}: ${file}  "${p.title}"`);
      }
    }
    const { previews, ...summary } = result;
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
