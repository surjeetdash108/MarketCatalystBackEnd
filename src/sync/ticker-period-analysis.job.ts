import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import {
  etDate, isLastFridayOfMonth, monthBounds, monthKey, weekBounds,
} from "../common/market-calendar.util";
import { TickerPeriodAnalysisService } from "../live/ticker-period-analysis.service";
import { TickerAiAnalysisService } from "../live/ticker-ai-analysis.service";
import type { NewsInput } from "../live/ticker-ai-analysis.prompt";

const WEEKLY_JOB = "ticker-weekly-ai";
const MONTHLY_JOB = "ticker-monthly-ai";
const CLEANUP_JOB = "monthly-news-cleanup";

/** Tickers processed per period run. Bounded for cost and runtime (§15). */
const MAX_TICKERS = Number(process.env.PERIOD_AI_MAX_TICKERS) || 40;

/**
 * Weekly and monthly ticker analysis, plus the gated news cleanup (§8–§11).
 *
 * Cron note: both period jobs are registered on a FRIDAY schedule after the
 * US close. The monthly one additionally checks isLastFridayOfMonth() at run
 * time and exits immediately otherwise — §9's "Do not run the monthly job
 * simply because it is Friday". Cron alone cannot express "last Friday", so
 * the gate has to live in code.
 */
@Injectable()
export class TickerPeriodAnalysisJob implements OnModuleInit {
  private readonly logger = new Logger(TickerPeriodAnalysisJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly period: TickerPeriodAnalysisService,
    private readonly current: TickerAiAnalysisService,
  ) {}

  onModuleInit() {
    // 16:30 ET Friday — after the 16:00 close.
    this.registry.register(WEEKLY_JOB, () => this.runWeekly(), {
      collections: ["ticker_weekly_ai_analysis"],
      cronExpression: "30 16 * * 5",
      timeZone: "America/New_York",
    });
    // Same slot; the last-Friday gate is enforced inside runMonthly().
    this.registry.register(MONTHLY_JOB, () => this.runMonthly(), {
      collections: ["ticker_monthly_ai_analysis"],
      cronExpression: "45 16 * * 5",
      timeZone: "America/New_York",
    });
    // Runs after the monthly job and refuses to delete unless it verified.
    this.registry.register(CLEANUP_JOB, () => this.runCleanup(), {
      collections: ["news"],
      cronExpression: "30 17 * * 5",
      timeZone: "America/New_York",
    });
  }

  /**
   * The ticker analyses generated during a window, grouped by ticker.
   *
   * Per the plan, weekly and monthly roll-ups are built from the ANALYSES in
   * ticker_ai_analysis — general reads plus earnings announcements — not by
   * re-reading raw news. Each analysis is already a distilled view of the news
   * that produced it, so this both preserves continuity and keeps the prompt
   * far smaller than a month of articles.
   */
  private async analysesByTicker(
    start: string,
    end: string,
  ): Promise<Map<string, Array<Record<string, unknown>>>> {
    const snap = await this.firebase.firestore
      .collection("ticker_ai_analysis")
      .where("lastUpdatedAt", ">=", `${start}T00:00:00.000Z`)
      .where("lastUpdatedAt", "<=", `${end}T23:59:59.999Z`)
      .get();
    const out = new Map<string, Array<Record<string, unknown>>>();
    for (const d of snap.docs) {
      const a = d.data();
      const t = String(a.ticker ?? "").toUpperCase();
      if (!t) continue;
      const list = out.get(t) ?? [];
      list.push({ id: d.id, ...a });
      out.set(t, list);
    }
    return out;
  }

  /**
   * Renders stored analyses as period-prompt source material.
   *
   * TYPE-AGNOSTIC BY RULE. analysesByTicker() does not filter on
   * analysisType, and this renderer does not enumerate the types it knows
   * about — it labels each row from whatever `analysisType` it carries. So
   * when a new kind of analysis is added to ticker_ai_analysis (13F filings,
   * insider activity, anything later), it is automatically picked up by the
   * weekly and monthly roll-ups with no change here.
   *
   * Do not reintroduce a per-type branch. If a type needs special rendering,
   * add a label to TYPE_LABEL rather than an if.
   */
  private asNewsInput(rows: Array<Record<string, unknown>>): NewsInput[] {
    const TYPE_LABEL: Record<string, string> = {
      general: "rolling analysis",
      announcement: "earnings announcement",
    };
    return rows
      .map((r) => {
        const type = String(r.analysisType ?? "general");
        // Verdict is surfaced when a row happens to carry one; absence is
        // normal for types that have no verdict concept.
        const verdict = (r.announcement as { verdict?: string } | undefined)?.verdict;
        const prefix = verdict ? `${verdict.toUpperCase()}: ` : "";
        return {
          id: String(r.id ?? ""),
          headline: `${prefix}${String(r.summary ?? "")}`,
          summary: String(r.overallAssessment ?? ""),
          // Unknown types fall back to their raw name rather than being
          // mislabelled as a rolling analysis.
          source: TYPE_LABEL[type] ?? type,
          publishedAt: String(r.lastUpdatedAt ?? ""),
          tag: String(r.sentiment ?? ""),
        };
      })
      .filter((n) => n.headline.trim());
  }

  /**
   * The period's MAJOR news, as distinct from its analyses.
   *
   * Analyses are distilled and lose the specific headline that caused them, so
   * a roll-up built only from analyses cannot say "the FDA approval on the
   * 14th". Major means: not syndication filler, and carrying a real category —
   * "other" is the general market commentary bucket and would swamp the prompt.
   */
  private async majorNews(
    ticker: string,
    start: string,
    end: string,
    limit = 12,
  ): Promise<NewsInput[]> {
    const snap = await this.firebase.firestore
      .collection("news")
      .where("ticker", "==", ticker)
      .get();
    return snap.docs
      .map((d): Record<string, unknown> => ({ ...d.data(), id: d.id }))
      .filter((a) => {
        const p = String(a.publishedAt ?? "");
        if (p < start || p > `${end}T23:59:59.999Z`) return false;
        if (a.filler === true) return false;
        const tag = String(a.tag ?? "other");
        return tag !== "other";
      })
      .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
      .slice(0, limit)
      .map((a) => ({
        id: String(a.id),
        headline: String(a.headline ?? ""),
        summary: (a.summary as string | null) ?? null,
        source: String(a.source ?? ""),
        publishedAt: String(a.publishedAt ?? ""),
        tag: String(a.tag ?? ""),
      }));
  }

  /** Tickers with news in the window, newest-first, capped. */
  private async newsByTicker(
    start: string, end: string,
  ): Promise<Map<string, NewsInput[]>> {
    const snap = await this.firebase.firestore
      .collection("news")
      .where("publishedAt", ">=", `${start}T00:00:00.000Z`)
      .where("publishedAt", "<=", `${end}T23:59:59.999Z`)
      .get();
    const byTicker = new Map<string, NewsInput[]>();
    for (const d of snap.docs) {
      const a = d.data();
      const t = String(a.ticker ?? "").toUpperCase();
      if (!t) continue;
      // Filler carries a ticker but no event — excluding it keeps the period
      // read about the company rather than about syndication volume.
      if (a.filler === true) continue;
      const list = byTicker.get(t) ?? [];
      list.push({
        id: d.id,
        headline: String(a.headline ?? ""),
        summary: (a.summary as string | null) ?? null,
        source: String(a.source ?? ""),
        publishedAt: String(a.publishedAt ?? ""),
        tag: (a.tag as string | null) ?? null,
      });
      byTicker.set(t, list);
    }
    return byTicker;
  }

  async runWeekly() {
    const today = etDate();
    const { start, end } = weekBounds(today);
    try {
      // Source: the analyses generated in this window, per the plan.
      const byTicker = await this.analysesByTicker(start, end);
      const ranked = [...byTicker.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, MAX_TICKERS);
      let ok = 0, failed = 0;
      for (const [ticker, news] of ranked) {
        try {
          const out = await this.period.generate(
            "weekly", ticker, { start, end },
            // Analyses AND the week's major headlines — the analyses give
            // continuity, the headlines give the specifics they distilled away.
            [...this.asNewsInput(news), ...(await this.majorNews(ticker, start, end))],
            { current: await this.current.getCurrent(ticker) },
          );
          if (out) ok++; else failed++;
        } catch (err) {
          failed++;
          this.logger.warn(`weekly ${ticker}: ${(err as Error).message}`);
        }
      }
      await this.meta.record(WEEKLY_JOB, { ok: failed === 0, count: ok,
        ...(failed ? { error: `${failed} ticker(s) failed` } : {}) });
      this.logger.log(`weekly ${start}..${end}: ${ok} ok, ${failed} failed`);
      return { weekStart: start, weekEnd: end, ok, failed };
    } catch (err) {
      await this.meta.record(WEEKLY_JOB, { ok: false, error: (err as Error).message });
      throw err;
    }
  }

  async runMonthly() {
    const today = etDate();
    // §9: the ONLY thing that makes this a monthly run.
    if (!isLastFridayOfMonth()) {
      this.logger.log(`monthly: ${today} is not the last Friday — skipping`);
      return { skipped: true, reason: "not-last-friday" as const };
    }
    const { start, end } = monthBounds(today);
    try {
      // Source: the analyses generated in this window, per the plan.
      const byTicker = await this.analysesByTicker(start, end);
      const ranked = [...byTicker.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, MAX_TICKERS);
      let ok = 0, failed = 0;
      for (const [ticker, news] of ranked) {
        try {
          const out = await this.period.generate(
            "monthly", ticker, { start, end },
            [...this.asNewsInput(news), ...(await this.majorNews(ticker, start, end, 20))],
            {
              current: await this.current.getCurrent(ticker),
              weeklies: await this.period.weeklyBetween(ticker, start, end),
            },
          );
          if (out) ok++; else failed++;
        } catch (err) {
          failed++;
          this.logger.warn(`monthly ${ticker}: ${(err as Error).message}`);
        }
      }
      // The cleanup reads this receipt; it is written ONLY here, and only with
      // the true counts, so a partial month can never look complete.
      await this.firebase.firestore
        .collection("monthly_analysis_runs")
        .doc(monthKey(today))
        .set({
          month: monthKey(today), monthStart: start, monthEnd: end,
          tickersAttempted: ranked.length, tickersSucceeded: ok, tickersFailed: failed,
          complete: failed === 0 && ok > 0,
          generatedAt: new Date().toISOString(),
        });
      await this.meta.record(MONTHLY_JOB, { ok: failed === 0, count: ok,
        ...(failed ? { error: `${failed} ticker(s) failed` } : {}) });
      this.logger.log(`monthly ${start}..${end}: ${ok} ok, ${failed} failed`);
      return { monthStart: start, monthEnd: end, ok, failed };
    } catch (err) {
      await this.meta.record(MONTHLY_JOB, { ok: false, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * §11: delete a month's news ONLY after that month's analysis is verified.
   *
   * Every gate below is a refusal to delete. The default outcome of anything
   * unexpected is to keep the news, because the news is the only thing that
   * makes a retry possible.
   */
  async runCleanup() {
    const today = etDate();
    if (!isLastFridayOfMonth()) {
      return { skipped: true, reason: "not-last-friday" as const };
    }
    const key = monthKey(today);
    try {
      const receipt = await this.firebase.firestore
        .collection("monthly_analysis_runs").doc(key).get();
      if (!receipt.exists) {
        this.logger.warn(`cleanup ${key}: no monthly analysis receipt — NOT deleting`);
        await this.meta.record(CLEANUP_JOB, { ok: false, error: "no receipt" });
        return { deleted: 0, blocked: "no-receipt" as const };
      }
      const r = receipt.data() as {
        complete?: boolean; tickersSucceeded?: number; tickersFailed?: number;
        monthStart?: string; monthEnd?: string;
      };
      if (!r.complete || (r.tickersFailed ?? 0) > 0 || (r.tickersSucceeded ?? 0) === 0) {
        this.logger.warn(
          `cleanup ${key}: analysis incomplete (ok=${r.tickersSucceeded} failed=${r.tickersFailed}) — NOT deleting`,
        );
        await this.meta.record(CLEANUP_JOB, { ok: false, error: "analysis incomplete" });
        return { deleted: 0, blocked: "incomplete" as const };
      }

      const snap = await this.firebase.firestore
        .collection("news")
        .where("publishedAt", ">=", `${r.monthStart}T00:00:00.000Z`)
        .where("publishedAt", "<=", `${r.monthEnd}T23:59:59.999Z`)
        .get();
      let deleted = 0;
      let batch = this.firebase.firestore.batch();
      let pending = 0;
      for (const d of snap.docs) {
        batch.delete(d.ref); deleted++; pending++;
        if (pending >= 400) { await batch.commit(); batch = this.firebase.firestore.batch(); pending = 0; }
      }
      if (pending) await batch.commit();
      await this.firebase.firestore.collection("monthly_analysis_runs").doc(key)
        .set({ newsDeleted: deleted, cleanedAt: new Date().toISOString() }, { merge: true });
      await this.meta.record(CLEANUP_JOB, { ok: true, count: deleted });
      this.logger.log(`cleanup ${key}: deleted ${deleted} news docs`);
      return { deleted, blocked: null };
    } catch (err) {
      await this.meta.record(CLEANUP_JOB, { ok: false, error: (err as Error).message });
      throw err;
    }
  }
}
