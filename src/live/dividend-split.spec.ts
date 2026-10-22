import { splitAdjustDividends } from "./ondemand.service";

describe("splitAdjustDividends", () => {
  const d = (exDividendDate: string, cashAmount: number) => ({ exDividendDate, cashAmount });
  it("restates unadjusted pre-split payments (NVDA 10:1, June 2024)", () => {
    const out = splitAdjustDividends([d("2024-03-05", 0.04), d("2024-06-11", 0.01)], [{ date: "2024-06-10", ratio: 10 }]);
    expect(out.map((x) => x.cashAmount)).toEqual([0.004, 0.01]);
  });
  it("leaves an already-adjusted series alone", () => {
    const rows = [d("2024-03-05", 0.004), d("2024-06-11", 0.01)];
    expect(splitAdjustDividends(rows, [{ date: "2024-06-10", ratio: 10 }])).toBe(rows);
  });
});
