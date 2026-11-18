import { freeWindowEnd, freeDaysLeft } from "./et-calendar";

/**
 * The free period (new-account intro = free trial) is 7 calendar days in US
 * Eastern, counting the sign-up day: sign up Nov 13 → ends Nov 19 11:59 PM ET,
 * so the first charge of a plan bought during it is on Nov 20.
 */
describe("free window: 7 calendar days counting the sign-up day", () => {
  const nov13 = Date.parse("2026-11-13T15:00:00Z"); // Nov 13, 10 AM EST
  it("signed up Nov 13 → ends Nov 19 at 11:59:59 PM ET", () => {
    expect(new Date(freeWindowEnd(nov13, 7)).toISOString()).toBe(
      "2026-11-20T04:59:59.000Z",
    );
  });
  it("late-night sign-up still counts that day as day 1", () => {
    const lateNov13 = Date.parse("2026-11-14T04:50:00Z"); // Nov 13, 11:50 PM EST
    expect(new Date(freeWindowEnd(lateNov13, 7)).toISOString()).toBe(
      "2026-11-20T04:59:59.000Z",
    );
  });
  it("across DST (summer): Jun 30 → Jul 6 11:59:59 PM EDT", () => {
    expect(
      new Date(
        freeWindowEnd(Date.parse("2026-07-01T03:30:00Z"), 7),
      ).toISOString(),
    ).toBe("2026-07-07T03:59:59.000Z");
  });
  it("days left: 7 on the sign-up day, 1 on the last day", () => {
    const end = freeWindowEnd(nov13, 7);
    expect(freeDaysLeft(end, nov13)).toBe(7);
    expect(freeDaysLeft(end, Date.parse("2026-11-19T20:00:00Z"))).toBe(1);
  });
});
