import { Subject } from "rxjs";
import { capStreamLifetime, SSE_MAX_LIFETIME_MS } from "./sse-lifetime.util";

describe("capStreamLifetime", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("ends a stream after the max lifetime and runs its teardown", () => {
    const source = new Subject<number>();
    const seen: number[] = [];
    let completed = false;
    const sub = capStreamLifetime(source).subscribe({
      next: (v) => seen.push(v),
      complete: () => (completed = true),
    });
    source.next(1);
    jest.advanceTimersByTime(SSE_MAX_LIFETIME_MS - 1);
    source.next(2);
    expect(completed).toBe(false);
    jest.advanceTimersByTime(1);
    expect(completed).toBe(true);
    expect(sub.closed).toBe(true);
    expect(source.observed).toBe(false); // upstream unsubscribed = slot released
    expect(seen).toEqual([1, 2]);
  });

  it("defaults to five minutes", () => {
    expect(SSE_MAX_LIFETIME_MS).toBe(300_000);
  });
});
