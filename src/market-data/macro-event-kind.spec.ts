import { macroEventKind } from "./macro-event-kind";

describe("macroEventKind", () => {
  it.each([
    ["Fed Williams Speech", "speech"],
    ["Fed Chair Powell Testimony", "speech"],
    ["Press Conference", "speech"],
    ["FOMC Press Conference", "speech"],
    ["FOMC Minutes", "report"],
    ["Fed Beige Book", "report"],
    ["Beige Book", "report"],
  ])("labels %s as %s", (name, kind) => {
    expect(macroEventKind(name)).toBe(kind);
  });

  // Real releases that arrive with no figures must stay "data" — they are
  // unpublished, not speeches.
  it.each([
    "Initial Jobless Claims",
    "CPI s.a",
    "PCE Price Index MoM",
    "S&P Global Manufacturing PMI",
    "EIA Crude Oil Stocks Change",
    "Fed Interest Rate Decision",
    "MBA 30-Year Mortgage Rate",
  ])("keeps %s as data", (name) => {
    expect(macroEventKind(name)).toBe("data");
  });

  it("treats a missing name as data", () => {
    expect(macroEventKind(undefined)).toBe("data");
  });
});
