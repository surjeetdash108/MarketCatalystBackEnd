import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { SyncRegistry } from "../common/sync-registry.service";
import { SyncMetaService } from "../common/sync-meta.service";
import { EtfHoldingsService, POPULAR_16_ETFS } from "../market-data/etf-holdings.service";

const JOB_NAME = "etf-holdings";

@Injectable()
export class EtfHoldingsJob implements OnModuleInit {
  private readonly logger = new Logger(EtfHoldingsJob.name);

  constructor(
    private readonly etfService: EtfHoldingsService,
    private readonly registry: SyncRegistry,
    private readonly meta: SyncMetaService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["etf_holdings"],
      cronExpression: "0 19 * * 1-5", // 7:00 PM ET weekdays (after market close)
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  /**
   * Main sync job runner covering all 16 Popular ETFs.
   */
  async run(): Promise<{ ok: boolean; count: number; error?: string }> {
    this.logger.log("Starting Popular 16 ETF Holdings sync job...");
    const { successCount, errors } = await this.etfService.syncAllPopular();

    const ok = successCount > 0;
    const errorMsg = errors.length > 0 ? errors.join("; ") : undefined;
    await this.meta.record(JOB_NAME, {
      ok,
      count: successCount,
      error: errorMsg,
    });

    this.logger.log(
      `Popular 16 ETF Holdings sync completed: ${successCount}/${POPULAR_16_ETFS.length} succeeded.`,
    );
    return { ok, count: successCount, error: errorMsg };
  }
}
