import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { OnDemandService } from "../live/ondemand.service";
import { canonicalTicker } from "../live/money-flow/money-flow.calc";
import { FmpService } from "../vendors/fmp/fmp.service";

const JOB_NAME = "index-members";
export const INDEX_MEMBERS_DOC = "config/index_members";
/** New company docs built per run (each is a vendor round-trip): 132 missing → ~4 mornings. */
export const SEED_PER_RUN = 40;
const SEED_DELAY_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** FMP constituent rows → canonical tickers (BRK-B → BRK.B), sorted, de-duplicated. */
export function constituentTickers(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  const out = new Set<string>();
  for (const r of rows as Array<{ symbol?: unknown }>) {
    if (typeof r?.symbol === "string" && r.symbol.trim()) out.add(canonicalTicker(r.symbol));
  }
  return [...out].sort();
}

/**
 * Index membership, live: FMP's S&P 500 and Nasdaq-100 constituent lists are
 * stored in config/index_members (served by GET /market-data/index-members),
 * and members without a `companies` doc get one built (the same on-demand
 * build a first view does), SEED_PER_RUN a run. The UI's static 2024 list had
 * drifted (55 members missing, 45 non-members) and 132 members had no company
 * doc, so "Top S&P 500" listed 340 names. Runs in the premarket market-wide
 * phase, before the per-ticker jobs that then fill history, technicals and RS.
 */
@Injectable()
export class IndexMembersJob implements OnModuleInit {
  private readonly logger = new Logger(IndexMembersJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly fmp: FmpService,
    private readonly ondemand: OnDemandService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["config", "companies"],
      cronExpression: "0 8 * * 1-5",
      timeZone: "America/New_York",
    });
  }

  async run() {
    try {
      const [sp, nd] = await Promise.all([
        this.fmp.request("sp500-constituent"),
        this.fmp.request("nasdaq-constituent"),
      ]);
      const sp500 = constituentTickers(sp);
      const nasdaq100 = constituentTickers(nd);
      // A thin answer is a vendor hiccup, not an index: keep yesterday's lists.
      if (sp500.length < 400 || nasdaq100.length < 80) {
        throw new Error(`implausible constituent lists (S&P ${sp500.length}, NDX ${nasdaq100.length})`);
      }
      const db = this.firebase.firestore;
      await db.doc(INDEX_MEMBERS_DOC).set({ sp500, nasdaq100, updatedAt: new Date().toISOString() });

      const members = [...new Set([...sp500, ...nasdaq100])];
      const missing: string[] = [];
      for (let i = 0; i < members.length; i += 300) {
        const chunk = members.slice(i, i + 300);
        const snaps = await db.getAll(...chunk.map((t) => db.collection("companies").doc(t)));
        snaps.forEach((s, j) => {
          if (!s.exists) missing.push(chunk[j]);
        });
      }
      let seeded = 0;
      for (const t of missing.slice(0, SEED_PER_RUN)) {
        try {
          if (await this.ondemand.getCompany(t)) seeded++;
        } catch (err) {
          this.logger.warn(`index-members: building ${t} failed: ${(err as Error).message}`);
        }
        await sleep(SEED_DELAY_MS);
      }
      const result = { sp500: sp500.length, nasdaq100: nasdaq100.length, missing: missing.length, seeded };
      await this.meta.record(JOB_NAME, { ok: true, count: seeded });
      return result;
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: (err as Error).message });
      throw err;
    }
  }
}
