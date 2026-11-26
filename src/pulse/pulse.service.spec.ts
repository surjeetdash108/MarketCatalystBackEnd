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
    // No length limit any more (26 Nov 2026): 501 characters is fine.
    expect(cleanPulseBody({ text: "x".repeat(501) }, false).text).toHaveLength(501);
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
  it("searches every post, not just the newest ones, and returns every match", async () => {
    const s = svc();
    await s.create({ text: "Oldest note on ZZZQ", ticker: "ZZZQ" }, at(-100000));
    for (let i = 0; i < 520; i++) await s.create({ text: `Filler post ${i}` }, at(i));
    for (let i = 0; i < 60; i++) await s.create({ text: `Chip note ${i}` }, at(1000 + i));
    expect((await s.search("zzzq")).map((p) => p.ticker)).toEqual(["ZZZQ"]);
    expect((await s.search("chip note")).length).toBe(60);
  });
});

describe("Pulse post length (owner decision, 26 Nov 2026)", () => {
  it("has no limit: a long post is accepted in full", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { cleanPulseBody } = require("./pulse.service");
    const long = "x".repeat(20_000);
    expect(cleanPulseBody({ text: long }, false).text).toHaveLength(20_000);
  });
  it("still needs some text", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { cleanPulseBody } = require("./pulse.service");
    expect(() => cleanPulseBody({ text: "  " }, false)).toThrow(/Write something/);
  });
});
