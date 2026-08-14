import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { setWithCreatedAt } from "../common/firestore-batch.util";
import { SyncMetaService } from "../common/sync-meta.service";
import { FredService } from "../vendors/fred/fred.service";
import { SyncRegistry } from "../common/sync-registry.service";

/**
 * Macro regime label → `macro_regime/current`. A rules-based, graded read
 * composed entirely from FRED series (approved public source) — no forward
 * view, no vendor estimates. Each of five components scores +1 (risk-on),
 * 0 (neutral) or -1 (risk-off); the sum maps to Risk-On / Neutral / Risk-Off.
 * Components are stored so the UI can show the "why", not just the label.
 */

const JOB_NAME = "macro-regime";

interface Comp {
  value: number | null;
  signal: -1 | 0 | 1 | null;
  label: string;
}

function num(v: string | undefined): number | null {
  if (v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

@Injectable()
export class MacroRegimeJob implements OnModuleInit {
  private readonly logger = new Logger(MacroRegimeJob.name);

  constructor(
    private readonly fred: FredService,
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["macro_regime"],
      cronExpression: "0 8 * * 1-5", // runs inside premarket orchestration
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const [curveObs, vixObs, creditObs, sp500Obs, unrateObs] =
        await Promise.all([
          this.fred.getLatestObservations("T10Y2Y", 1), // 10Y-2Y spread
          this.fred.getLatestObservations("VIXCLS", 1), // VIX close
          this.fred.getLatestObservations("BAMLH0A0HYM2", 1), // HY OAS
          this.fred.getLatestObservations("SP500", 220), // for 200-DMA trend
          this.fred.getLatestObservations("UNRATE", 4), // ~3-month trend
        ]);

      // 1) Yield curve: steeper = risk-on, inverted = risk-off.
      const curve = num(curveObs[0]?.value);
      const yieldCurve: Comp = {
        value: curve,
        signal: curve == null ? null : curve > 0.5 ? 1 : curve < 0 ? -1 : 0,
        label:
          curve == null
            ? "n/a"
            : curve < 0
              ? "Inverted"
              : curve > 0.5
                ? "Steep"
                : "Flat",
      };

      // 2) Volatility (VIX): calm = risk-on, stressed = risk-off.
      const vix = num(vixObs[0]?.value);
      const volatility: Comp = {
        value: vix,
        signal: vix == null ? null : vix < 15 ? 1 : vix > 25 ? -1 : 0,
        label:
          vix == null
            ? "n/a"
            : vix < 15
              ? "Calm"
              : vix > 25
                ? "Stressed"
                : "Elevated",
      };

      // 3) Credit (HY OAS): tight spreads = risk-on, wide = risk-off.
      const oas = num(creditObs[0]?.value);
      const credit: Comp = {
        value: oas,
        signal: oas == null ? null : oas < 3.5 ? 1 : oas > 5 ? -1 : 0,
        label:
          oas == null
            ? "n/a"
            : oas < 3.5
              ? "Tight"
              : oas > 5
                ? "Wide"
                : "Normal",
      };

      // 4) Trend: S&P 500 vs its 200-day moving average.
      const sp500Vals = sp500Obs
        .map((o) => num(o.value))
        .filter((v): v is number => v != null);
      const spLatest = sp500Vals[0] ?? null; // desc order: [0] is most recent
      const ma200 =
        sp500Vals.length >= 200
          ? sp500Vals.slice(0, 200).reduce((a, b) => a + b, 0) / 200
          : null;
      const trendPct =
        spLatest != null && ma200 ? ((spLatest - ma200) / ma200) * 100 : null;
      const trend: Comp = {
        value: trendPct == null ? null : Math.round(trendPct * 100) / 100,
        signal:
          trendPct == null ? null : trendPct > 2 ? 1 : trendPct < 0 ? -1 : 0,
        label:
          trendPct == null
            ? "n/a"
            : trendPct < 0
              ? "Below 200-DMA"
              : trendPct > 2
                ? "Above 200-DMA"
                : "Near 200-DMA",
      };

      // 5) Employment: falling unemployment = risk-on, rising = risk-off.
      const unrateLatest = num(unrateObs[0]?.value);
      const unratePrior = num(unrateObs[unrateObs.length - 1]?.value);
      const employment: Comp = {
        value: unrateLatest,
        signal:
          unrateLatest == null || unratePrior == null
            ? null
            : unrateLatest < unratePrior
              ? 1
              : unrateLatest > unratePrior
                ? -1
                : 0,
        label:
          unrateLatest == null
            ? "n/a"
            : unratePrior == null
              ? "Flat"
              : unrateLatest < unratePrior
                ? "Falling"
                : unrateLatest > unratePrior
                  ? "Rising"
                  : "Flat",
      };

      const components = { yieldCurve, volatility, credit, trend, employment };
      const signals = Object.values(components)
        .map((c) => c.signal)
        .filter((s): s is -1 | 0 | 1 => s != null);
      const score = signals.reduce((a, b) => a + b, 0);
      const counted = signals.length;
      const regime =
        score >= 2 ? "Risk-On" : score <= -2 ? "Risk-Off" : "Neutral";

      const asOfDate =
        curveObs[0]?.date ??
        vixObs[0]?.date ??
        sp500Obs[0]?.date ??
        new Date().toISOString().slice(0, 10);

      await setWithCreatedAt(
        this.firebase.firestore,
        this.firebase.firestore.collection("macro_regime").doc("current"),
        {
          regime,
          score,
          maxScore: counted,
          components,
          asOfDate,
          source: "fred-derived",
          updatedAt: new Date().toISOString(),
        },
      );

      await this.meta.record(JOB_NAME, { ok: true, count: 1 });
      this.logger.log(
        `macro-regime: ${regime} (score ${score}/${counted}) as of ${asOfDate}`,
      );
      return { regime, score, counted };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: err.message });
      throw err;
    }
  }
}
