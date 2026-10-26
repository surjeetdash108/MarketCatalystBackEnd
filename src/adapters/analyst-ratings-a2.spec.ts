import * as fs from "fs";
import * as path from "path";
import { ConfigService } from "@nestjs/config";
import { FmpService } from "../vendors/fmp/fmp.service";
import { FmpAnalystRatingsAdapter } from "./analyst-ratings.adapter";

/**
 * A-2 follow-up, on saved FMP responses (validation-output/fmp_trace). A post
 * whose headline names a DIFFERENT firm than its tag is re-attributed to the
 * named firm; when that headline states no target, the post's priceTarget
 * field is the tagged firm's number, not the named firm's, so the post must
 * not give the named firm a target:
 *  - PEP 2026-09-29 "JPMorgan Downgrades Pepsico (PEP) to Neutral", tagged
 *    Jefferies, priceTarget 138.
 * (KO 2026-08-14 "Piper Sandler Reiterates Overweight…", tagged Seaport Global
 * at 95, is the same shape, but a newer Piper post supersedes it, so it cannot
 * show the bug.)
 */
describe("A-2: a re-attributed post with no stated target is dropped", () => {
  const fx = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures/a2-reattributed.json"), "utf-8"),
  );

  function adapterFor(ticker: string) {
    const svc = new FmpService(new ConfigService({ FMP_API_KEY: "test" }));
    // Real FmpService mapping; only the HTTP layer is replaced by the saved responses.
    (svc as unknown as { get: (p: string) => Promise<unknown[]> }).get = async (p: string) => {
      const endpoint = p.split("?")[0];
      return (fx[ticker][endpoint] as unknown[]) ?? [];
    };
    // The rating-count row was not saved and plays no part in target attribution;
    // any non-zero count lets getConsensus build the grade rows under test.
    svc.getAnalystConsensus = async () => ({ strongBuy: 1, buy: 0, hold: 0, sell: 0, strongSell: 0 }) as never;
    return new FmpAnalystRatingsAdapter(svc);
  }

  it("PEP 2026-09-29: JPMorgan's downgrade does not carry the Jefferies-tagged 138", async () => {
    const out = await adapterFor("PEP").getConsensus("PEP");
    const jpm = (out?.recentGrades ?? []).find(
      (g) => /j\.?\s?p\.?\s?morgan/i.test(String(g.firm)) && g.date === "2026-09-29",
    );
    expect(jpm).toBeDefined();
    expect(jpm!.priceTargetDate === "2026-09-29" && jpm!.priceTarget === 138).toBe(false);
  });

  it("PEP: JPMorgan's latest target is not the 2026-09-29 Jefferies-tagged 138", async () => {
    const index = await (
      adapterFor("PEP") as unknown as {
        targetIndex(t: string): Promise<{ latestByFirm: Map<string, { date: string; priceTarget: number }> }>;
      }
    ).targetIndex("PEP");
    const latest = index.latestByFirm.get("jpmorgan");
    expect(latest?.date === "2026-09-29" && latest?.priceTarget === 138).toBe(false);
  });
});
