import { Injectable } from "@nestjs/common";

/**
 * The application's notion of "now" for anything billing-related: expiry
 * checks, grace periods, promo expiry, renewal dates.
 *
 * In production it is always the wall clock. With the fake billing provider
 * (never in production — see provider.factory.ts) it can be moved forward so
 * renewals, period-end cancels, downgrades and discounts ending can be tested
 * without waiting months. Control is enabled explicitly by the fake provider.
 */
@Injectable()
export class AppClock {
  private offsetMs = 0;
  private frozenAt: number | null = null;
  private controllable = false;

  now(): number {
    return this.frozenAt ?? Date.now() + this.offsetMs;
  }

  nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Called by the fake provider only. */
  enableControl(): void {
    this.controllable = true;
  }

  get isControllable(): boolean {
    return this.controllable;
  }

  /** Moves time forward to `ms` (never backwards). */
  setNow(ms: number): void {
    if (!this.controllable) throw new Error("AppClock is not controllable");
    if (ms < this.now()) throw new Error("AppClock cannot move backwards");
    if (this.frozenAt !== null) this.frozenAt = ms;
    else this.offsetMs = ms - Date.now();
  }

  /** Stops time at `ms` (tests). */
  freeze(ms: number): void {
    if (!this.controllable) throw new Error("AppClock is not controllable");
    this.frozenAt = ms;
  }
}
