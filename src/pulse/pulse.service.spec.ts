import { BadRequestException, NotFoundException } from "@nestjs/common";
import { FakeFirestore } from "../../test/support/fake-firestore";
import type { FirebaseAdminService } from "../common/firebase-admin.provider";
import { ROUTE_FEATURES } from "../plans/plans.registry";
import { cleanPulseBody, PulseService } from "./pulse.service";

const svc = (fs = new FakeFirestore()) =>
  new PulseService({ firestore: fs } as unknown as FirebaseAdminService);

describe("Market Catalyst Pulse", () => {
  it("validates posts: text required, optional ticker, default name and handle", () => {
    expect(
      cleanPulseBody(
        { text: "  NVDA leads the chip bid.  ", ticker: "$nvda" },
        false,
      ),
    ).toEqual({
      text: "NVDA leads the chip bid.",
      ticker: "NVDA",
      name: "MarketCatalyst",
      handle: "MarketCatalyst",
    });
    expect(
      cleanPulseBody({ text: "Macro day", ticker: "" }, false).ticker,
    ).toBeNull();
    expect(() => cleanPulseBody({ text: "  " }, false)).toThrow(
      BadRequestException,
    );
    expect(() => cleanPulseBody({ text: "x".repeat(501) }, false)).toThrow(
      BadRequestException,
    );
    expect(() =>
      cleanPulseBody({ text: "ok", ticker: "BAD TICKER" }, false),
    ).toThrow(BadRequestException);
    expect(() =>
      cleanPulseBody({ text: "ok", handle: "no spaces allowed" }, false),
    ).toThrow(BadRequestException);
    expect(cleanPulseBody({ handle: "@desk_1" }, true)).toEqual({
      handle: "desk_1",
    });
  });

  it("lists newest first; an edit keeps the original publish time; delete removes", async () => {
    const s = svc();
    const a = await s.create(
      { text: "first" },
      new Date("2026-11-18T14:00:00Z"),
    );
    const b = await s.create(
      { text: "second", ticker: "AAPL" },
      new Date("2026-11-18T14:05:00Z"),
    );
    expect((await s.list()).map((p) => p.id)).toEqual([b.id, a.id]);
    const edited = await s.update(
      a.id,
      { text: "first, edited" },
      new Date("2026-11-18T15:00:00Z"),
    );
    expect(edited.createdAt).toBe("2026-11-18T14:00:00.000Z");
    expect((await s.list()).map((p) => p.text)).toEqual([
      "second",
      "first, edited",
    ]);
    await s.remove(b.id);
    expect((await s.list()).map((p) => p.id)).toEqual([a.id]);
    await expect(s.remove("missing")).rejects.toThrow(NotFoundException);
  });

  it("the dashboard read is open to every plan (Market Catalyst)", () => {
    expect(ROUTE_FEATURES["GET /api/pulse"]).toEqual(["marketCatalyst"]);
  });
});
