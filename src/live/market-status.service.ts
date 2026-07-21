import { Injectable, Logger } from '@nestjs/common';
import { PolygonService } from '../vendors/polygon/polygon.service';

/**
 * Exchange session state from the vendor, cached.
 *
 * The header pill computed this in the browser from a local clock plus a
 * hand-maintained holiday set that has to be extended by hand every year, and
 * which treats early-close half-days as full sessions. `/v1/marketstatus/now`
 * is authorized on the current plan and answers authoritatively, including the
 * early/late trading phases.
 *
 * Cached because status changes at most a handful of times a day but the header
 * is on every screen: without this, every page load would be an upstream call.
 * The holiday calendar is cached far longer — it changes a few times a year.
 */

const STATUS_TTL_MS = 60_000;
const HOLIDAYS_TTL_MS = 12 * 60 * 60_000;

export interface MarketStatusPayload {
  /** "open" | "closed" | "extended-hours" as reported by the vendor. */
  market: string;
  earlyHours: boolean;
  afterHours: boolean;
  exchanges: Record<string, string>;
  serverTime: string;
  /** Normalized phase matching the UI's own vocabulary. */
  phase: 'open' | 'pre' | 'after' | 'closed';
  label: string;
  upcoming: Array<{
    date: string;
    exchange: string;
    name: string;
    status: string;
    open?: string;
    close?: string;
  }>;
  fetchedAt: string;
}

@Injectable()
export class MarketStatusService {
  private readonly logger = new Logger(MarketStatusService.name);

  private status: { data: any; at: number } | null = null;
  private holidays: { data: MarketStatusPayload['upcoming']; at: number } | null = null;
  /** Last good payload, served if the vendor is briefly unreachable. */
  private lastGood: MarketStatusPayload | null = null;

  constructor(private readonly polygon: PolygonService) {}

  /**
   * `market` is "extended-hours" during both pre and post sessions, so the
   * earlyHours flag is what separates them — checked before afterHours because
   * a closed market reports false for both.
   */
  private phaseOf(s: {
    market: string;
    earlyHours: boolean;
    afterHours: boolean;
  }): { phase: MarketStatusPayload['phase']; label: string } {
    if (s.market === 'open') return { phase: 'open', label: 'Markets Open' };
    if (s.earlyHours) return { phase: 'pre', label: 'Pre-Market' };
    if (s.afterHours) return { phase: 'after', label: 'After Hours' };
    return { phase: 'closed', label: 'Markets Closed' };
  }

  async get(): Promise<MarketStatusPayload> {
    const now = Date.now();
    try {
      if (!this.status || now - this.status.at > STATUS_TTL_MS) {
        this.status = { data: await this.polygon.getMarketStatus(), at: now };
      }
      if (!this.holidays || now - this.holidays.at > HOLIDAYS_TTL_MS) {
        this.holidays = {
          data: await this.polygon.getUpcomingMarketHolidays(),
          at: now,
        };
      }
      const s = this.status.data;
      const payload: MarketStatusPayload = {
        market: s.market,
        earlyHours: !!s.earlyHours,
        afterHours: !!s.afterHours,
        exchanges: s.exchanges ?? {},
        serverTime: s.serverTime,
        ...this.phaseOf(s),
        upcoming: this.holidays.data,
        fetchedAt: new Date().toISOString(),
      };
      this.lastGood = payload;
      return payload;
    } catch (err) {
      this.logger.warn(`market status fetch failed: ${err.message}`);
      // A stale-but-real status beats blanking the header. Only when nothing has
      // ever succeeded does the caller get an explicit unknown.
      if (this.lastGood) return this.lastGood;
      throw err;
    }
  }
}
