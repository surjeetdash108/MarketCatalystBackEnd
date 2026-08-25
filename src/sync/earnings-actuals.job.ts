import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { etDate } from "../common/market-calendar.util";
import { TickerAiAnalysisService } from "../live/ticker-ai-analysis.service";
import { EARNINGS_ESTIMATES_ADAPTER } from "../adapters/types";
import type { EarningsEstimatesAdapter } from "../adapters/earnings-estimates.adapter";

const JOB_NAME = "earnings-actuals";

/**
 * Fills in actuals for the tickers reporting TODAY, nothing else.
 *
 * WHY NOT JUST RUN THE `earnings` JOB MORE OFTEN
 * That job rebuilds the entire forward calendar — 12,441 docs per run. Firing
 * it every 5 minutes across the two reporting windows would be 48 runs/day and
 * ~597,000 writes/day, roughly $32/month, in order to change the couple of
 * dozen rows that actually report on a given day (27 today). More than the
 * whole cost ceiling, spent rewriting rows that did not change.
 *
 * This job instead reads only the rows already dated today, pulls that single
 * calendar day from the vendor (one call, covering exactly those reporters),
 * and writes ONLY rows whose actuals have appeared or changed. A typical run
 * is one vendor call and zero writes; the run that matters is the one right
 * after a company reports.
 *
 * It never creates rows and never touches dates or estimates — the nightly
 * `earnings` job remains the sole owner of calendar shape.
 */
@Injectable()
export class EarningsActualsJob implements OnModuleInit {
  private readonly logger = new Logger(EarningsActualsJob.name);

  constructor(
    @Inject(EARNINGS_ESTIMATES_ADAPTER)
    private readonly estimates: EarningsEstimatesAdapter,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly tickerAi: TickerAiAnalysisService,
  ) {}

  onModuleInit() {
    // Registered for completeness. The REAL cadence is Cloud Scheduler: the
    // worker has no minScale and scales to zero, so the in-process cron cannot
    // be relied on to fire.
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["earnings_events"],
      cronExpression: "*/5 6-7,16-17 * * 1-5",
      timeZone: "America/New_York",
    });
  }

  /**
   * One "announcement" analysis per ticker whose result just landed.
   *
   * Runs only for tickers in `filled` — those whose epsActual went from null
   * to a value on THIS run — so a company is analysed once per report, not on
   * every 5-minute pass through the window.
   *
   * Never throws: a model failure must not fail an actuals run that already
   * stored the figures correctly.
   */
  private async announce(
    filled: string[],
    docs: FirebaseFirestore.QueryDocumentSnapshot[],
    today: string,
  ): Promise<void> {
    const byTicker = new Map(
      docs.map((d) => [String((d.data() as { ticker?: string }).ticker ?? "").toUpperCase(), d.data()]),
    );
    for (const ticker of filled) {
      try {
        const e = byTicker.get(ticker) as {
          epsActual?: number | null; epsEstimate?: number | null;
          revenueActual?: number | null; revenueEstimate?: number | null;
          companyName?: string | null;
        } | undefined;
        if (!e) continue;
        const act = e.epsActual ?? null;
        const est = e.epsEstimate ?? null;
        const surprisePct =
          act != null && est != null && est !== 0
            ? ((act - est) / Math.abs(est)) * 100
            : null;
        const verdict: "beat" | "miss" | "in-line" | "unknown" =
          surprisePct == null ? "unknown"
          : surprisePct > 1 ? "beat"
          : surprisePct < -1 ? "miss"
          : "in-line";

        // Recent stories give the model context for WHY, but the figures
        // above are the subject. Filler is excluded for the usual reason.
        const newsSnap = await this.firebase.firestore
          .collection("news").where("ticker", "==", ticker).get();
        const news = newsSnap.docs
          .map((d) => ({
            id: d.id,
            headline: String(d.data().headline ?? ""),
            summary: (d.data().summary as string | null) ?? null,
            source: String(d.data().source ?? ""),
            publishedAt: String(d.data().publishedAt ?? ""),
            tag: (d.data().tag as string | null) ?? null,
            filler: d.data().filler === true,
          }))
          .filter((n) => !n.filler && n.headline)
          .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
          .slice(0, 8);

        const out = await this.tickerAi.recordAnnouncement(
          ticker,
          {
            reportDate: today,
            epsActual: act, epsEstimate: est,
            surprisePct: surprisePct == null ? null : Math.round(surprisePct * 10) / 10,
            revenueActual: e.revenueActual ?? null,
            revenueEstimate: e.revenueEstimate ?? null,
            verdict,
          },
          news,
          e.companyName ?? null,
        );
        this.logger.log(
          `announcement ${ticker}: ${verdict}` +
            (surprisePct != null ? ` ${surprisePct.toFixed(1)}%` : "") +
            (out ? " — analysis stored" : " — analysis unavailable"),
        );
      } catch (err) {
        this.logger.warn(
          `announcement analysis failed for ${ticker}: ${(err as Error).message}`,
        );
      }
    }
  }

  async run() {
    const today = etDate();
    try {
      const snap = await this.firebase.firestore
        .collection("earnings_events")
        .where("date", "==", today)
        .get();
      if (snap.empty) {
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { date: today, reporters: 0, updated: 0, filled: [] as string[] };
      }

      const rows = await this.estimates.getUpcoming(today, today);
      const byTicker = new Map(rows.map((r) => [r.ticker.toUpperCase(), r]));

      const batch = this.firebase.firestore.batch();
      let updated = 0;
      const filled: string[] = [];
      for (const d of snap.docs) {
        const cur = d.data() as {
          ticker?: string;
          epsActual?: number | null;
          revenueActual?: number | null;
        };
        const t = String(cur.ticker ?? "").toUpperCase();
        const fresh = byTicker.get(t);
        if (!fresh) continue;

        const patch: Record<string, unknown> = {};
        // Only ever FILL or correct. A vendor momentarily returning null for a
        // value we already hold must never blank it back out.
        if (fresh.epsActual != null && fresh.epsActual !== cur.epsActual) {
          patch.epsActual = fresh.epsActual;
        }
        if (
          fresh.revenueActual != null &&
          fresh.revenueActual !== cur.revenueActual
        ) {
          patch.revenueActual = fresh.revenueActual;
        }
        if (!Object.keys(patch).length) continue;

        patch.actualsUpdatedAt = new Date().toISOString();
        batch.set(d.ref, patch, { merge: true });
        updated++;
        if (cur.epsActual == null && patch.epsActual != null) filled.push(t);
      }
      if (updated) await batch.commit();

      if (filled.length) {
        this.logger.log(
          `earnings-actuals ${today}: FIRST actuals in for ${filled.join(", ")}`,
        );
        // The result is persisted at this point (batch.commit above), so the
        // announcement analysis is generated from data already stored — same
        // ordering rule as the news pipeline: never analyse before the save.
        await this.announce(filled, snap.docs, today);
      }
      await this.meta.record(JOB_NAME, { ok: true, count: updated });
      return { date: today, reporters: snap.size, updated, filled };
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: (err as Error).message,
      });
      throw err;
    }
  }
}
