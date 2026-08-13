import { Controller, Get } from "@nestjs/common";

/**
 * GET /market-data/recaps — backs the Recap screen (`RecapDoc`).
 *
 * A recap was an END-OF-DAY snapshot COMPOSED from other synced collections and
 * their accumulated *_history (indices/movers/sectors + per-day breadth + a
 * week of rows). In the live architecture those collections and histories are
 * no longer written, and the only fields the Recap screen reads off this doc —
 * `internals` (a single day's market breadth) and `weekly` (a 5-day rollup of
 * index % + sector leaders/laggards) — both require ACCUMULATED per-day history
 * that no single live vendor call can reproduce. So they degrade to null.
 *
 * Everything else the Recap screen shows (indices tape, sectors, earnings, news,
 * macro) it already fetches live from its own dedicated endpoints — it never
 * read them off this doc. So this endpoint returns one valid-but-degraded recap
 * for today: no Firestore cache, no sync job, no vendor call.
 *
 * If per-day breadth/weekly history is wanted again, it needs a deliberate
 * accumulation store (out of scope for the cache→live refactor), not a cron.
 */
@Controller("market-data")
export class RecapsController {
  @Get("recaps")
  async recaps() {
    const date = new Date().toISOString().slice(0, 10);
    return [
      {
        id: date,
        date,
        // Both need accumulated per-day history the live architecture no longer
        // keeps — see the class doc. The UI renders null as "not available".
        internals: null,
        weekly: null,
        // Narrative prose is R36 (Anthropic), not produced by any job.
        narrative: null,
      },
    ];
  }
}
