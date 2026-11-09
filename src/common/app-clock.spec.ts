import { AppClock } from "./app-clock";

describe("AppClock", () => {
  it("is the wall clock and cannot be moved unless the fake provider enabled control", () => {
    const c = new AppClock();
    expect(Math.abs(c.now() - Date.now())).toBeLessThan(50);
    expect(c.isControllable).toBe(false);
    expect(() => c.setNow(Date.now() + 1e9)).toThrow(/not controllable/);
    expect(() => c.freeze(0)).toThrow(/not controllable/);
  });
  it("moves forward only once enabled", () => {
    const c = new AppClock();
    c.enableControl();
    c.freeze(1_000_000);
    c.setNow(2_000_000);
    expect(c.now()).toBe(2_000_000);
    expect(() => c.setNow(1)).toThrow(/backwards/);
  });
});
