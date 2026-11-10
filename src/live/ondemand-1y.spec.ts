import * as fs from "fs";
import * as path from "path";
import { OnDemandService } from "./ondemand.service";

/**
 * The 1Y chart is the last 252 sessions — one trading year, the same span the
 * 52-week figures beside it describe. A 12-calendar-month cut kept only 251
 * bars of CAT's real Polygon history to Oct 26 2026 (from Oct 27 2025). This is
 * the line that ran live but was never committed.
 */
describe("OnDemandService.getBars 1Y", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/cat-daily-to-oct26.json"), "utf-8"));
  it("returns the last 252 sessions", async () => {
    const store = new Map<string, unknown>();
    const firebase = {
      firestore: {
        collection: () => ({
          doc: (key: string) => ({
            get: () => Promise.resolve({ exists: store.has(key), data: () => store.get(key) }),
            set: (v: unknown) => (store.set(key, v), Promise.resolve()),
          }),
        }),
      },
    };
    const polygon = { getAggsRange: jest.fn(() => Promise.resolve(fx.results)) };
    const svc = new OnDemandService(
      firebase as never, polygon as never, null as never, null as never, null, null,
      null as never, null as never, null as never, null as never, null as never,
    );
    jest.spyOn(svc, "recordUsage").mockImplementation(() => undefined);
    const res = await svc.getBars("CAT", "1Y");
    expect(res.bars).toHaveLength(252);
  });
});
