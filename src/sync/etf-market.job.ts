import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { SyncRegistry } from "../common/sync-registry.service";
import { SyncMetaService } from "../common/sync-meta.service";
import { EtfMarketService } from "../live/etf-market.service";

const JOB_NAME = "etf-market";

@Injectable()
export class EtfMarketJob implements OnModuleInit {
  private readonly logger = new Logger(EtfMarketJob.name);

  constructor(
    private readonly etfMarketService: EtfMarketService,
    private readonly registry: SyncRegistry,
    private readonly meta: SyncMetaService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["etf_market_current", "etf_market_previous"],
      cronExpression: "0 0 * * 0", // Sunday midnight (weekly rotation)
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  /**
   * Main sync job runner:
   * Rotates current week data -> previous week data,
   * discovers all 5,000+ ETFs across 10 categories,
   * writes all categories to etf_market_current in Firestore.
   */
  async run(): Promise<{ ok: boolean; count: number; error?: string }> {
    this.logger.log("Starting Weekly ETF Market Universe & Discovery sync job...");
    try {
      const response = await this.etfMarketService.syncUniverse();
      const totalFunds =
        response.categories?.reduce((acc, c) => acc + (c.funds?.length || 0), 0) || 0;

      const ok = totalFunds > 0;
      await this.meta.record(JOB_NAME, {
        ok,
        count: totalFunds,
      });

      this.logger.log(
        `Weekly ETF Market sync completed successfully: ${totalFunds} total funds preserved across ${response.categories.length} categories.`,
      );
      return { ok, count: totalFunds };
    } catch (err: any) {
      this.logger.error(`Weekly ETF Market sync failed: ${err.message}`);
      await this.meta.record(JOB_NAME, {
        ok: false,
        count: 0,
        error: err.message,
      });
      return { ok: false, count: 0, error: err.message };
    }
  }
}
