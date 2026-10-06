import { sessionFromAcceptance } from "./edgar-8k.job";

describe("sessionFromAcceptance (UTC instant -> New York session)", () => {
  it("AAL 8-K accepted 07:00 ET in summer (11:00Z) is pre-market", () => {
    expect(sessionFromAcceptance("2026-07-23T11:00:28.000Z")).toBe("BMO");
  });
  it("MDB 8-K accepted 16:07 ET in summer (20:07Z) is after the close", () => {
    expect(sessionFromAcceptance("2026-09-02T20:07:00.000Z")).toBe("AMC");
  });
  it("13:00 ET in summer (17:00Z) is intraday, not AMC", () => {
    expect(sessionFromAcceptance("2026-08-05T17:00:00.000Z")).toBe("Intraday");
  });
  it("winter (EST, UTC-5): 06:30 ET = 11:30Z is pre-market", () => {
    expect(sessionFromAcceptance("2026-02-04T11:30:00.000Z")).toBe("BMO");
  });
  it("winter: 16:05 ET = 21:05Z is after the close", () => {
    expect(sessionFromAcceptance("2026-02-04T21:05:31.000Z")).toBe("AMC");
  });
  it("09:30 ET exactly is intraday; 16:00 ET exactly is AMC", () => {
    expect(sessionFromAcceptance("2026-07-23T13:30:00.000Z")).toBe("Intraday");
    expect(sessionFromAcceptance("2026-07-23T20:00:00.000Z")).toBe("AMC");
  });
  it("returns null for missing or unparseable input", () => {
    expect(sessionFromAcceptance(undefined)).toBeNull();
    expect(sessionFromAcceptance("not a date")).toBeNull();
  });
});
