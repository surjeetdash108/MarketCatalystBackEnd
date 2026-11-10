import * as fs from "fs";
import * as path from "path";
import { TickerSearchService } from "./ticker-search.service";

/**
 * Real universe order (getAllTickers, 2026-10-26): "T" (AT&T) comes after 282
 * other T-prefixed listings. The scan stopped once it had collected 3×MAX
 * exact+prefix hits, so the exact match was never reached and "T" returned
 * TSLA, TXN, TMUS… without AT&T.
 */
describe("TickerSearchService.search", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/ticker-universe-T.json"), "utf-8"));
  const svc = () =>
    new TickerSearchService({
      getAllTickers: async () => fx.universe.map((u: { ticker: string; name: string }) => ({ ...u, market: "stocks" })),
    } as never);

  it('"T" returns T first', async () => {
    const hits = await svc().search("T");
    expect(hits[0]).toEqual({ ticker: "T", name: expect.any(String) });
  });

  it("an exact match is first however late it sits in the universe (lower-case query too)", async () => {
    const hits = await svc().search("tt");
    expect(hits[0].ticker).toBe("TT");
  });

  it("prefix matches still follow, in universe order", async () => {
    const hits = await svc().search("T");
    expect(hits.slice(1, 4).every((h) => h.ticker.startsWith("T"))).toBe(true);
  });
});
