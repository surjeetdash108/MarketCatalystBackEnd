import { articlesSince, isMissingIndexError, newsStamp, parseSince } from "./news-since.util";

describe("parseSince", () => {
  it("returns undefined when absent so the full list is served", () => {
    expect(parseSince(undefined)).toBeUndefined();
    expect(parseSince("")).toBeUndefined();
  });
  it("parses an ISO timestamp", () => {
    expect(parseSince("2026-11-18T10:00:00.000Z")).toBe(
      Date.parse("2026-11-18T10:00:00.000Z"),
    );
  });
  it("returns null for garbage or a non-string", () => {
    expect(parseSince("not-a-date")).toBeNull();
    expect(parseSince(["2026-11-18"])).toBeNull();
  });
});

describe("articlesSince", () => {
  const since = Date.parse("2026-11-18T10:00:00.000Z");
  const old = { id: "a", createdAt: "2026-11-18T09:00:00.000Z", updatedAt: "2026-11-18T09:00:00.000Z" };
  const fresh = { id: "b", createdAt: "2026-11-18T10:05:00.000Z", updatedAt: "2026-11-18T10:05:00.000Z" };
  const sameMoment = { id: "c", createdAt: "2026-11-18T10:00:00.000Z" };
  // The news job re-stamps updatedAt on its newest articles every run; the
  // article is not new, so it must not come back.
  const restamped = { id: "d", createdAt: "2026-11-18T08:00:00.000Z", updatedAt: "2026-11-18T10:30:00.000Z" };
  const noCreated = { id: "e", updatedAt: "2026-11-18T11:00:00.000Z" };
  const onlyPublished = { id: "f", publishedAt: "2026-11-18T12:00:00.000Z" };

  it("returns nothing when there is nothing newer", () => {
    expect(articlesSince([old, sameMoment], since)).toEqual([]);
  });
  it("returns new articles, not ones the job merely re-stamped", () => {
    expect(articlesSince([old, fresh, restamped], since).map((a) => a.id)).toEqual(["b"]);
  });
  it("falls back to updatedAt then publishedAt when createdAt is missing", () => {
    expect(articlesSince([noCreated, onlyPublished], since).map((a) => a.id)).toEqual(["e", "f"]);
  });
  it("drops docs with no usable timestamp", () => {
    expect(articlesSince([{ id: "x" }], since)).toEqual([]);
    expect(newsStamp({ id: "x" })).toBe(0);
  });
});

describe("isMissingIndexError", () => {
  it("recognises Firestore's missing-index failure", () => {
    expect(isMissingIndexError({ code: 9, message: "x" })).toBe(true);
    expect(isMissingIndexError(new Error("9 FAILED_PRECONDITION: The query requires an index"))).toBe(true);
  });
  it("ignores other errors", () => {
    expect(isMissingIndexError(new Error("deadline exceeded"))).toBe(false);
    expect(isMissingIndexError(null)).toBe(false);
  });
});
