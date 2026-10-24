import { realListingDate } from "./ondemand.service";

describe("realListingDate", () => {
  it("drops vendor placeholders and keeps real dates", () => {
    expect(realListingDate("1900-01-01")).toBeNull(); // GE, Polygon
    expect(realListingDate("1962-01-02")).toBe("1962-01-02");
    expect(realListingDate("2024-04-02T00:00:00Z")).toBe("2024-04-02");
    expect(realListingDate("")).toBeNull();
    expect(realListingDate(undefined)).toBeNull();
  });
});
