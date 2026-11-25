import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { etDate } from "../common/market-calendar.util";
import { FmpService } from "../vendors/fmp/fmp.service";
import { INDEX_MEMBERS_DOC } from "./index-members.job";

const JOB_NAME = "forward-estimates";
/** Estimates move slowly: a ticker is re-fetched once its stored figure is this old. */
export const REFRESH_AFTER_MS = 3 * 24 * 3600_000;
/** Vendor calls per run (one per ticker); ~550 members → every ticker within ~3 mornings. */
export const PER_RUN = 200;
const DELAY_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface EstimateRow {
  date: string;
  estimatedEpsAvg: number | null;
}

/**
 * The next fiscal year's consensus EPS: the earliest annual estimate whose
 * fiscal year ends today or later (the year not yet reported). Null when the
 * vendor has none.
 */
export function nextFiscalYearEps(
  rows: readonly EstimateRow[],
  todayIso: string,
): { eps: number; fyEnd: string } | null {
  const ahead = rows
    .filter(
      (r) =>
        /^\d{4}-\d{2}-\d{2}/.test(r.date) &&
        r.date.slice(0, 10) >= todayIso &&
        r.estimatedEpsAvg != null &&
        Number.isFinite(r.estimatedEpsAvg),
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  const first = ahead[0];
  return first
    ? { eps: first.estimatedEpsAvg as number, fyEnd: first.date.slice(0, 10) }
    : null;
}

/**
 * Next-fiscal-year consensus EPS for S&P 500 and Nasdaq-100 members, stored on
 * `companies/{ticker}` as `nextFyEps` / `nextFyEnd`, so the dashboard can rank
 * forward P/E (price ÷ nextFyEps) across the market. One FMP analyst-estimates
 * call per ticker; each ticker is refreshed every REFRESH_AFTER_MS, PER_RUN a
 * run, so a morning costs a couple of hundred calls.
 */
@Injectable()
export class ForwardEstimatesJob implements OnModuleInit {
  private readonly logger = new Logger(ForwardEstimatesJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly fmp: FmpService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["companies"],
      cronExpression: "0 8 * * 1-5",
      timeZone: "America/New_York",
    });
  }

  async run() {
    try {
      const db = this.firebase.firestore;
      const idx = (await db.doc(INDEX_MEMBERS_DOC).get()).data() as
        { sp500?: string[]; nasdaq100?: string[] } | undefined;
      const members = [
        ...new Set([...(idx?.sp500 ?? []), ...(idx?.nasdaq100 ?? [])]),
      ];
      if (members.length === 0) throw new Error("no index members stored yet");

      const now = Date.now();
      const due: string[] = [];
      for (let i = 0; i < members.length; i += 300) {
        const chunk = members.slice(i, i + 300);
        const snaps = await db.getAll(
          ...chunk.map((t) => db.collection("companies").doc(t)),
        );
        snaps.forEach((s, j) => {
          if (!s.exists) return;
          const at = Date.parse(String(s.get("nextFyEpsAt") ?? ""));
          if (!Number.isFinite(at) || now - at > REFRESH_AFTER_MS)
            due.push(chunk[j]);
        });
      }

      const today = etDate();
      let written = 0;
      let empty = 0;
      for (const t of due.slice(0, PER_RUN)) {
        try {
          // FMP spells share classes with a dash (BRK-B); company docs use a dot.
          const rows = await this.fmp.getForwardAnnualEstimates(
            t.replace(".", "-"),
          );
          const next = nextFiscalYearEps(rows, today);
          await db
            .collection("companies")
            .doc(t)
            .set(
              {
                nextFyEps: next?.eps ?? null,
                nextFyEnd: next?.fyEnd ?? null,
                nextFyEpsAt: new Date().toISOString(),
              },
              { merge: true },
            );
          if (next) written++;
          else empty++;
        } catch (err) {
          this.logger.warn(
            `forward-estimates: ${t} failed: ${(err as Error).message}`,
          );
        }
        await sleep(DELAY_MS);
      }
      const result = {
        members: members.length,
        due: due.length,
        written,
        empty,
      };
      await this.meta.record(JOB_NAME, { ok: true, count: written });
      return result;
    } catch (err) {
      await this.meta.record(JOB_NAME, {
        ok: false,
        error: (err as Error).message,
      });
      throw err;
    }
  }
}
