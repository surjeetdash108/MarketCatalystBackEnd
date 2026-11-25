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

describe("Market Catalyst Pulse search", () => {
  const at = (m: number) => new Date(Date.parse("2026-11-18T14:00:00Z") + m * 60_000);
  async function seeded() {
    const s = svc();
    await s.create({ text: "NVDA, AMD lead the chip bid", ticker: "NVDA" }, at(1));
    await s.create({ text: "Fed minutes at 2 PM", name: "Macro Desk", handle: "macro" }, at(2));
    await s.create({ text: "Oil slides as inventories build" }, at(3));
    await s.create({ text: "AMD guides above consensus", ticker: "AMD" }, at(4));
    return s;
  }
  it("matches ticker ($ optional) and words in the text — newest first; not the name or handle (cards no longer show them)", async () => {
    const s = await seeded();
    expect((await s.search("$nvda")).map((p) => p.ticker)).toEqual(["NVDA"]);
    expect((await s.search("amd")).map((p) => p.text)).toEqual(["AMD guides above consensus", "NVDA, AMD lead the chip bid"]);
    expect((await s.search("fed minutes")).map((p) => p.handle)).toEqual(["macro"]);
    expect(await s.search("macro desk")).toEqual([]);
    expect(await s.search("@macro")).toEqual([]);
  });
  it("every word must match; an empty query is the plain list", async () => {
    const s = await seeded();
    expect(await s.search("oil fed")).toEqual([]);
    expect((await s.search("   ")).length).toBe(4);
  });
});
