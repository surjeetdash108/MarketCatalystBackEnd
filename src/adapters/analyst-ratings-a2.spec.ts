import * as fs from "fs";
import * as path from "path";
import { ConfigService } from "@nestjs/config";
import { FmpService } from "../vendors/fmp/fmp.service";
import { FmpAnalystRatingsAdapter } from "./analyst-ratings.adapter";

/**
 * Re-attributed posts (headline names a different firm than FMP's tag), on
 * saved FMP responses. Every such post with no stated target that the Oct 24
 * E2E could verify (3 of 3: CAT Freedom Broker $980, SFM JPMorgan $103, EPM
 * Freedom $5.30) carried the HEADLINE firm's target in priceTarget — the tag
 * is what FMP got wrong. So the target is kept, attributed to the named firm.
 * A target the headline states still wins over the field (GE Morgan Stanley:
 * a Guggenheim-tagged copy carries 380, the headline says $375).
 */
describe("analyst targets of re-attributed posts", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/a2-kept-targets.json"), "utf-8"));

  function adapterFor(ticker: string) {
    const svc = new FmpService(new ConfigService({ FMP_API_KEY: "test" }));
    // Real FmpService mapping; only the HTTP layer is replaced by the saved responses.
    (svc as unknown as { get: (p: string) => Promise<unknown[]> }).get = async (p: string) =>
      (fx[ticker][p.split("?")[0]] as unknown[]) ?? [];
    // The rating-count row plays no part in target attribution.
    svc.getAnalystConsensus = async () => ({ strongBuy: 1, buy: 0, hold: 0, sell: 0, strongSell: 0 }) as never;
    return new FmpAnalystRatingsAdapter(svc);
  }
  const rowFor = async (ticker: string, firm: RegExp, date: string) => {
    const out = await adapterFor(ticker).getConsensus(ticker);
    return (out?.recentGrades ?? []).find((g) => firm.test(String(g.firm)) && String(g.date).startsWith(date));
  };

  it.each([
    ["CAT", /freedom/i, "2026-09-10", 980],
    ["SFM", /j\.?\s?p\.?\s?morgan/i, "2026-07-30", 103],
    ["EPM", /freedom/i, "2025-12-23", 5.3],
  ])("%s keeps the named firm's target from a mis-tagged post", async (ticker, firm, date, pt) => {
    const row = await rowFor(ticker as string, firm as RegExp, date as string);
    expect(row).toBeDefined();
    expect(row!.priceTarget).toBe(pt);
  });

  it("GE Morgan Stanley stays $375 (the headline's stated target beats the 380 field)", async () => {
    const row = await rowFor("GE", /morgan stanley/i, "2026-10-21");
    expect(row?.priceTarget).toBe(375);
  });
});
