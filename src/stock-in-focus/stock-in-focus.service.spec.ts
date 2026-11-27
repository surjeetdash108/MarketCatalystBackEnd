import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { FakeFirestore } from "../../test/support/fake-firestore";
import type { FirebaseAdminService } from "../common/firebase-admin.provider";
import { ROUTE_FEATURES } from "../plans/plans.registry";
import {
  cleanStockInFocusBody,
  etDay,
  HEADLINE_MAX,
  NOTE_MAX,
  StockInFocusService,
} from "./stock-in-focus.service";

const svc = (fs = new FakeFirestore()) =>
  new StockInFocusService({ firestore: fs } as unknown as FirebaseAdminService);

// Thu 26 Nov 2026, 18:00 UTC = 13:00 New York.
const NOW = new Date("2026-11-26T18:00:00Z");

describe("etDay", () => {
  it("is the New York calendar day, not the UTC one", () => {
    expect(etDay(new Date("2026-11-27T02:00:00Z"))).toBe("2026-11-26"); // 21:00 ET on the 26th
    expect(etDay(new Date("2026-11-26T18:00:00Z"))).toBe("2026-11-26");
  });
});

describe("cleanStockInFocusBody", () => {
  it("normalises a post: ticker upper-cased without $, headline and note trimmed", () => {
    expect(
      cleanStockInFocusBody({ ticker: " $nvda ", headline: "  Chips   lead the bid  ", note: "  Why now.  " }, false, NOW),
    ).toEqual({ ticker: "NVDA", headline: "Chips lead the bid", note: "Why now." });
  });

  it("needs a ticker and a headline to post, but not a note", () => {
    expect(() => cleanStockInFocusBody({ headline: "x" }, false, NOW)).toThrow(BadRequestException);
    expect(() => cleanStockInFocusBody({ ticker: "AAPL" }, false, NOW)).toThrow(BadRequestException);
    expect(() => cleanStockInFocusBody({ ticker: "AAPL", headline: "   " }, false, NOW)).toThrow(BadRequestException);
    expect(cleanStockInFocusBody({ ticker: "AAPL", headline: "h" }, false, NOW).note).toBe("");
  });

  it("rejects a bad ticker and over-long text, with the limit in the message", () => {
    expect(() => cleanStockInFocusBody({ ticker: "BAD TICKER", headline: "h" }, false, NOW)).toThrow(/ticker/);
    expect(() =>
      cleanStockInFocusBody({ ticker: "AAPL", headline: "x".repeat(HEADLINE_MAX + 1) }, false, NOW),
    ).toThrow(new RegExp(String(HEADLINE_MAX)));
    expect(() =>
      cleanStockInFocusBody({ ticker: "AAPL", headline: "h", note: "x".repeat(NOTE_MAX + 1) }, false, NOW),
    ).toThrow(new RegExp(String(NOTE_MAX)));
    expect(cleanStockInFocusBody({ ticker: "AAPL", headline: "x".repeat(HEADLINE_MAX) }, false, NOW).headline).toHaveLength(HEADLINE_MAX);
  });

  it("accepts today or a past day, rejects a future or impossible one", () => {
    const base = { ticker: "AAPL", headline: "h" };
    expect(cleanStockInFocusBody({ ...base, day: "2026-11-26" }, false, NOW).day).toBe("2026-11-26");
    expect(cleanStockInFocusBody({ ...base, day: "2026-11-01" }, false, NOW).day).toBe("2026-11-01");
    expect(() => cleanStockInFocusBody({ ...base, day: "2026-11-27" }, false, NOW)).toThrow(/future/);
    expect(() => cleanStockInFocusBody({ ...base, day: "2026-02-30" }, false, NOW)).toThrow(/valid/);
    expect(() => cleanStockInFocusBody({ ...base, day: "tomorrow" }, false, NOW)).toThrow(/valid/);
    // "today" is New York's today: 02:00 UTC on the 27th is still the 26th there.
    expect(() => cleanStockInFocusBody({ ...base, day: "2026-11-27" }, false, new Date("2026-11-27T02:00:00Z"))).toThrow(/future/);
  });

  it("an edit may send any subset of fields", () => {
    expect(cleanStockInFocusBody({ headline: "New" }, true, NOW)).toEqual({ headline: "New" });
    expect(cleanStockInFocusBody({}, true, NOW)).toEqual({});
  });
});

describe("StockInFocusService", () => {
  const post = (over: Record<string, unknown> = {}) => ({ ticker: "NVDA", headline: "Chip bid", note: "n", ...over });

  it("files an entry under its day, defaulting to today in New York", async () => {
    const fs = new FakeFirestore();
    const s = svc(fs);
    const e = await s.create(post(), NOW);
    expect(e).toMatchObject({ day: "2026-11-26", ticker: "NVDA", headline: "Chip bid", createdAt: NOW.toISOString() });
    expect(fs.ids("stock_in_focus")).toEqual(["2026-11-26"]);
    // The archive orders on the `day` field, so it must be stored, not only the id.
    expect(fs.read("stock_in_focus", "2026-11-26")).toMatchObject({ day: "2026-11-26" });
  });

  it("allows one entry per day: a second is a conflict, not an overwrite", async () => {
    const s = svc();
    await s.create(post(), NOW);
    await expect(s.create(post({ ticker: "AAPL" }), NOW)).rejects.toBeInstanceOf(ConflictException);
    expect((await s.list())[0].ticker).toBe("NVDA");
  });

  it("lists the newest day first and honours the limit", async () => {
    const s = svc();
    await s.create(post({ ticker: "AAA", day: "2026-11-24" }), NOW);
    await s.create(post({ ticker: "BBB", day: "2026-11-26" }), NOW);
    await s.create(post({ ticker: "CCC", day: "2026-11-25" }), NOW);
    expect((await s.list()).map((e) => e.ticker)).toEqual(["BBB", "CCC", "AAA"]);
    expect((await s.list(2)).map((e) => e.ticker)).toEqual(["BBB", "CCC"]);
    expect(await s.list(0)).toHaveLength(3); // a nonsense limit falls back to the default, never to nothing
  });

  it("an edit keeps the day and the original post time", async () => {
    const s = svc();
    await s.create(post(), NOW);
    const later = new Date("2026-11-26T20:00:00Z");
    const e = await s.update("2026-11-26", { headline: "Sharper headline" }, later);
    expect(e).toMatchObject({ day: "2026-11-26", ticker: "NVDA", headline: "Sharper headline", createdAt: NOW.toISOString(), updatedAt: later.toISOString() });
  });

  it("will not move an entry to another day through an edit", async () => {
    const s = svc();
    await s.create(post(), NOW);
    await expect(s.update("2026-11-26", { day: "2026-11-25" }, NOW)).rejects.toThrow(/another day/);
    // Sending the same day back is harmless (the console may include it).
    await expect(s.update("2026-11-26", { day: "2026-11-26", note: "x" }, NOW)).resolves.toMatchObject({ note: "x" });
  });

  it("404s an unknown or malformed day on edit and delete", async () => {
    const s = svc();
    await expect(s.update("2026-11-26", { note: "x" }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.update("../etc", { note: "x" }, NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.remove("2026-11-26")).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.remove("not-a-day")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("deletes an entry, so the day can be posted again", async () => {
    const s = svc();
    await s.create(post(), NOW);
    expect(await s.remove("2026-11-26")).toEqual({ ok: true });
    expect(await s.list()).toEqual([]);
    await expect(s.create(post({ ticker: "AAPL" }), NOW)).resolves.toMatchObject({ ticker: "AAPL" });
  });

  describe("latest()", () => {
    it("is null with no entries, else the newest day", async () => {
      const s = svc();
      expect(await s.latest(0)).toBeNull();
      await s.create(post({ day: "2026-11-25" }), NOW);
      await s.create(post({ ticker: "AAPL", day: "2026-11-26" }), NOW);
      expect((await s.latest(1))?.ticker).toBe("AAPL");
    });

    it("caches for a minute, and any write on this instance drops the cache", async () => {
      const fs = new FakeFirestore();
      const s = svc(fs);
      expect(await s.latest(0)).toBeNull(); // cached as "none"
      // A write through ANOTHER path (as another instance would make) stays unseen inside the TTL...
      fs.seed("stock_in_focus", "2026-11-26", { day: "2026-11-26", ticker: "AAPL", headline: "h", note: "", createdAt: "x", updatedAt: "x" });
      expect(await s.latest(30_000)).toBeNull();
      // ...and is seen once the TTL has run out.
      expect((await s.latest(61_000))?.ticker).toBe("AAPL");
      // A write on this instance is visible at once.
      await s.update("2026-11-26", { ticker: "MSFT" }, NOW);
      expect((await s.latest(61_001))?.ticker).toBe("MSFT");
    });
  });

  it("the archive read is open to every plan", () => {
    expect(ROUTE_FEATURES["GET /api/stock-in-focus"]).toEqual(["marketCatalyst"]);
  });
});
