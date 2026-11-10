import * as fs from "fs";
import * as path from "path";
import { mapFmpQuote } from "./snapshot-cache.service";
import type { FmpFullQuote } from "../vendors/fmp/fmp.service";

/** Real FMP live quotes captured during the Nov 2, 2026 session (incl. PNR / APA, absent from `companies`). */
const fx = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/fmp-quotes-2026-11-02.json"),
    "utf-8",
  ),
) as { quotes: Array<FmpFullQuote & { name: string; marketCap: number }> };

describe("live quote carries FMP's live market cap and company name", () => {
  const now = Date.parse("2026-11-02T18:53:00Z"); // 13:53 ET, regular session
  for (const t of ["ORCL", "MRVL", "PNR", "APA"]) {
    it(`${t}: marketCap and name pass through unchanged`, () => {
      const raw = fx.quotes.find((q) => q.symbol === t);
      if (!raw) throw new Error(`no ${t} in the fixture`);
      const q = mapFmpQuote(raw, undefined, now);
      expect(q.marketCap).toBe(raw.marketCap);
      expect(q.name).toBe(raw.name);
      // live cap = live price × shares: consistent with the live price, not Friday's close
      const sharesAtPrev = raw.marketCap / raw.price;
      expect(
        Math.abs(sharesAtPrev * raw.previousClose - raw.marketCap) /
          raw.marketCap,
      ).toBeGreaterThan(0.02);
    });
  }
});
