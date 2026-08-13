import { Controller, Get, Header } from '@nestjs/common';
import { FredService } from '../vendors/fred/fred.service';

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

/**
 * GET /market-data/macro-regime — the rules-based FRED-derived market regime
 * label. Calls FRED directly on every request (no Firestore cache, no sync
 * job) — mirrors macro-regime.job.ts's fetch + scoring, minus persistence.
 */
@Controller('market-data')
export class MacroRegimeController {
  constructor(private readonly fred: FredService) {}

  @Get('macro-regime')
  @Header('Cache-Control', 'no-store')
  async macroRegime() {
    const [curveObs, vixObs, creditObs, sp500Obs, unrateObs] = await Promise.all([
      this.fred.getLatestObservations('T10Y2Y', 1),
      this.fred.getLatestObservations('VIXCLS', 1),
      this.fred.getLatestObservations('BAMLH0A0HYM2', 1),
      this.fred.getLatestObservations('SP500', 220),
      this.fred.getLatestObservations('UNRATE', 4),
    ]);

    const curve = num(curveObs[0]?.value);
    const yieldCurve: Comp = {
      value: curve,
      signal: curve == null ? null : curve > 0.5 ? 1 : curve < 0 ? -1 : 0,
      label: curve == null ? 'n/a' : curve < 0 ? 'Inverted' : curve > 0.5 ? 'Steep' : 'Flat',
    };

    const vix = num(vixObs[0]?.value);
    const volatility: Comp = {
      value: vix,
      signal: vix == null ? null : vix < 15 ? 1 : vix > 25 ? -1 : 0,
      label: vix == null ? 'n/a' : vix < 15 ? 'Calm' : vix > 25 ? 'Stressed' : 'Elevated',
    };

    const oas = num(creditObs[0]?.value);
    const credit: Comp = {
      value: oas,
      signal: oas == null ? null : oas < 3.5 ? 1 : oas > 5 ? -1 : 0,
      label: oas == null ? 'n/a' : oas < 3.5 ? 'Tight' : oas > 5 ? 'Wide' : 'Normal',
    };

    const sp500Vals = sp500Obs
      .map((o) => num(o.value))
      .filter((v): v is number => v != null);
    const spLatest = sp500Vals[0] ?? null;
    const ma200 =
      sp500Vals.length >= 200
        ? sp500Vals.slice(0, 200).reduce((a, b) => a + b, 0) / 200
        : null;
    const trendPct = spLatest != null && ma200 ? ((spLatest - ma200) / ma200) * 100 : null;
    const trend: Comp = {
      value: trendPct == null ? null : Math.round(trendPct * 100) / 100,
      signal: trendPct == null ? null : trendPct > 2 ? 1 : trendPct < 0 ? -1 : 0,
      label:
        trendPct == null ? 'n/a' : trendPct < 0 ? 'Below 200-DMA' : trendPct > 2 ? 'Above 200-DMA' : 'Near 200-DMA',
    };

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
          ? 'n/a'
          : unratePrior == null
            ? 'Flat'
            : unrateLatest < unratePrior
              ? 'Falling'
              : unrateLatest > unratePrior
                ? 'Rising'
                : 'Flat',
    };

    const components = { yieldCurve, volatility, credit, trend, employment };
    const signals = Object.values(components)
      .map((c) => c.signal)
      .filter((s): s is -1 | 0 | 1 => s != null);
    const score = signals.reduce((a, b) => a + b, 0);
    const counted = signals.length;
    const regime = score >= 2 ? 'Risk-On' : score <= -2 ? 'Risk-Off' : 'Neutral';

    const asOfDate =
      curveObs[0]?.date ?? vixObs[0]?.date ?? sp500Obs[0]?.date ?? new Date().toISOString().slice(0, 10);

    return [
      {
        id: 'current',
        regime,
        score,
        maxScore: counted,
        components,
        asOfDate,
        source: 'fred-derived',
        updatedAt: new Date().toISOString(),
      },
    ];
  }
}
