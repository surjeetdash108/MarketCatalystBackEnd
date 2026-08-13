import { Controller, Get, Header, Logger } from '@nestjs/common';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { activeUniverse } from '../common/ticker-universe';
import {
  AlphaVantageRateLimitError,
  AlphaVantageService,
  type AlphaVantageAnalystRatings,
} from '../vendors/alphavantage/alphavantage.service';

// Alpha Vantage's free tier enforces a hard ~1 request/second burst limit on
// top of its 25/day cap — verified empirically: firing 5 requests at once
// (the old CONCURRENCY) had only ~1 land and the rest instantly rejected
// with the same "spread out your requests" envelope, wasting most of the
// scarce daily quota against itself. Serial (1) is what actually lets each
// of the ~25 daily calls have a shot at succeeding.
const CONCURRENCY = 1;

function consensusLabel(r: AlphaVantageAnalystRatings): string {
  const total = r.strongBuy + r.buy + r.hold + r.sell + r.strongSell;
  if (total === 0) return 'No Rating';
  // Same 5-point scale analysts vote on (Strong Buy=5 .. Strong Sell=1),
  // averaged across the vote count and bucketed back to a label.
  const score =
    (r.strongBuy * 5 + r.buy * 4 + r.hold * 3 + r.sell * 2 + r.strongSell * 1) / total;
  if (score >= 4.5) return 'Strong Buy';
  if (score >= 3.5) return 'Buy';
  if (score >= 2.5) return 'Hold';
  if (score >= 1.5) return 'Sell';
  return 'Strong Sell';
}

/**
 * GET /market-data/analyst-actions — live per-ticker analyst-rating
 * consensus (Buy/Hold/Sell vote counts), sourced from Alpha Vantage's
 * OVERVIEW endpoint's `AnalystRating*` fields. Replaces the previous 501:
 * Polygon has no analyst/ratings endpoint on any tier, and Alpha Vantage is
 * the first vendor wired for it. This is a snapshot vote count, not a
 * per-firm upgrade/downgrade event feed — Alpha Vantage doesn't have one
 * either — matching what `AnalystConsensusDoc` already expects.
 *
 * Calls Alpha Vantage directly on every request (no Firestore cache, no sync
 * job), one OVERVIEW call per ticker in `activeUniverse`, serialized (see
 * CONCURRENCY). Alpha Vantage's free tier caps out at ~25 requests/day, so in
 * practice this only ever covers a small slice of tickers per call before
 * hitting that ceiling — once hit, every further call returns the same
 * rate-limit envelope instantly, so remaining tickers are skipped rather than
 * burning calls that are already doomed. Tickers Alpha Vantage has no analyst
 * coverage for are silently skipped, same as an unreachable ticker.
 */
@Controller('market-data')
export class AnalystActionsController {
  private readonly logger = new Logger(AnalystActionsController.name);

  constructor(
    private readonly alphaVantage: AlphaVantageService,
    private readonly firebase: FirebaseAdminService,
  ) {}

  @Get('analyst-actions')
  @Header('Cache-Control', 'no-store')
  async analystActions() {
    const universe = await activeUniverse(this.firebase.firestore);
    const docs: Record<string, unknown>[] = [];

    for (let i = 0; i < universe.length; i += CONCURRENCY) {
      const chunk = universe.slice(i, i + CONCURRENCY);
      let rateLimited = false;

      const results = await Promise.all(
        chunk.map(async (symbol): Promise<Record<string, unknown> | null> => {
          try {
            const ratings = await this.alphaVantage.getCompanyOverview(symbol);
            if (!ratings) return null;
            return {
              id: symbol,
              ticker: symbol,
              strongBuy: ratings.strongBuy,
              buy: ratings.buy,
              hold: ratings.hold,
              sell: ratings.sell,
              strongSell: ratings.strongSell,
              consensus: consensusLabel(ratings),
              updatedAt: new Date().toISOString(),
            };
          } catch (err) {
            if (err instanceof AlphaVantageRateLimitError) rateLimited = true;
            return null;
          }
        }),
      );
      docs.push(...results.filter((d): d is Record<string, unknown> => d != null));

      if (rateLimited) {
        this.logger.warn(
          `analyst-actions: Alpha Vantage rate limit hit after ${docs.length} of ${universe.length} tickers — returning partial results.`,
        );
        break;
      }
    }
    return docs;
  }
}
