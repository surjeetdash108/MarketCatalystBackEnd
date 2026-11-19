jest.mock("../../common/http.util", () => ({
  fetchJson: jest.fn(() =>
    Promise.resolve({
      results: [
        {
          ticker: "BHAIU",
          listing_date: "2026-11-14",
          issuer_name: "BHAV Acquisition Corp. II",
          security_type: "SP",
          ipo_status: "history",
          final_issue_price: 10,
        },
        {
          ticker: "MDRN",
          listing_date: "2026-11-13",
          issuer_name: "Modern Mining Technology Corp",
          security_type: "CS",
          ipo_status: "history",
          final_issue_price: 4.25,
        },
      ],
    }),
  ),
}));
import { PolygonService } from "./polygon.service";
import type { ConfigService } from "@nestjs/config";

// Nov 19 workbook Logic #2: SPAC units (BHAIU) on Recent IPOs. Polygon's IPO
// feed says what each listing is; the calendar now keeps it.
describe("Polygon IPO calendar keeps security_type", () => {
  it("maps security_type to securityType", async () => {
    const svc = new PolygonService({
      get: (k: string, d?: unknown) => (k === "POLYGON_API_KEY" ? "k" : d),
    } as unknown as ConfigService);
    const rows = await svc.getIpoCalendar("2026-11-01", "2026-11-30");
    expect(rows.map((r) => [r.symbol, r.securityType])).toEqual([
      ["BHAIU", "SP"],
      ["MDRN", "CS"],
    ]);
  });
});
