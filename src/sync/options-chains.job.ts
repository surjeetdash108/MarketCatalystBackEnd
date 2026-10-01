import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { setWithCreatedAt } from "../common/firestore-batch.util";
import { OPTIONS_UNIVERSE } from "../common/options-universe";
import { SyncMetaService } from "../common/sync-meta.service";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { isoDate } from "../common/date.util";

const JOB_NAME = "options-chains";
const CONTRACTS_PER_TICKER = 20;
const AGG_LOOKBACK_DAYS = 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


@Injectable()
export class OptionsChainsJob implements OnModuleInit {
  private readonly logger = new Logger(OptionsChainsJob.name);

  constructor(
    private readonly polygon: PolygonService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["options_chains"],
      cronExpression: "0 19 * * 1-5",
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    const today = isoDate(new Date());
    const lookback = new Date();
    lookback.setUTCDate(lookback.getUTCDate() - AGG_LOOKBACK_DAYS);
    const from = isoDate(lookback);
    let tickersWritten = 0;
    for (const ticker of OPTIONS_UNIVERSE) {
      try {
        const contracts = await this.polygon.getOptionContracts(
          ticker,
          today,
          CONTRACTS_PER_TICKER,
        );
        await sleep(this.polygon.requestDelayMs);
        const enriched = [];
        for (const c of contracts) {
          try {
            const bar = await this.polygon.getOptionLatestBar(
              c.ticker,
              from,
              today,
            );
            // Per-contract OHLCV is authorized on this plan even though the
            // options SNAPSHOT (greeks/IV/OI/bid-ask) returns NOT_AUTHORIZED —
            // verified 2026-07-21. Only close and volume were being read, so the
            // chain table showed two of the six real columns available to it.
            enriched.push({
              contractTicker: c.ticker,
              contractType: c.contract_type,
              strike: c.strike_price,
              expirationDate: c.expiration_date,
              exerciseStyle: c.exercise_style ?? null,
              sharesPerContract: c.shares_per_contract ?? null,
              lastOpen: bar?.o ?? null,
              lastHigh: bar?.h ?? null,
              lastLow: bar?.l ?? null,
              lastClose: bar?.c ?? null,
              lastVwap: bar?.vw ?? null,
              lastVolume: bar?.v ?? null,
              lastTradeCount: bar?.n ?? null,
              lastBarDate: bar ? isoDate(new Date(bar.t)) : null,
              // Intraday range on the contract's own last session. Not a
              // substitute for a bid-ask spread, but it is a real traded range
              // where the table previously had nothing.
              lastRangePct:
                bar && bar.o > 0
                  ? Math.round(((bar.h - bar.l) / bar.o) * 10000) / 100
                  : null,
            });
          } catch (err) {
            this.logger.warn(
              `Failed fetching bar for ${c.ticker}: ${err.message}`,
            );
          }
          await sleep(this.polygon.requestDelayMs);
        }
        await setWithCreatedAt(
          this.firebase.firestore,
          this.firebase.firestore.collection("options_chains").doc(ticker),
          {
            underlyingTicker: ticker,
            contracts: enriched,
            source: "polygon",
            note: "Strikes, expirations and per-contract OHLCV/VWAP/volume are real (delayed). Bid/ask, IV, greeks and open interest return NOT_AUTHORIZED on the current Polygon plan — they need the Options add-on.",
            updatedAt: new Date().toISOString(),
          },
        );
        tickersWritten++;
      } catch (err) {
        this.logger.error(
          `Failed syncing options for ${ticker}: ${err.message}`,
        );
      }
    }
    await this.meta.record(JOB_NAME, { ok: true, count: tickersWritten });
    return { tickersWritten };
  }
}
