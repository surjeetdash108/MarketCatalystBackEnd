import { Injectable, Logger } from "@nestjs/common";
import { FieldValue } from "firebase-admin/firestore";
import { FirebaseAdminService } from "../common/firebase-admin.provider";

/**
 * Tracks which tickers users actually search for and select (not every
 * keystroke — only a resolved selection, logged by the frontend on click /
 * Enter). One doc per ticker in `searched_tickers`, count incremented on
 * each selection — same shape as `ticker_usage` in ondemand.service.ts,
 * which this mirrors, except this is scoped to explicit searches rather
 * than every data fetch.
 */
@Injectable()
export class SearchedTickersService {
  private readonly logger = new Logger(SearchedTickersService.name);

  constructor(private readonly firebase: FirebaseAdminService) {}

  async record(ticker: string): Promise<void> {
    const now = new Date().toISOString();
    const ref = this.firebase.firestore
      .collection("searched_tickers")
      .doc(ticker);
    try {
      await ref.set(
        { ticker, count: FieldValue.increment(1), lastSearchedAt: now },
        { merge: true },
      );
    } catch (err) {
      this.logger.warn(`record(${ticker}) failed: ${(err as Error).message}`);
    }
  }

  async mostSearched(
    limit = 10,
  ): Promise<Array<{ ticker: string; count: number }>> {
    const snap = await this.firebase.firestore
      .collection("searched_tickers")
      .orderBy("count", "desc")
      .limit(limit)
      .get();
    return snap.docs.map((d) => ({
      ticker: d.id,
      count: (d.data().count as number) ?? 0,
    }));
  }
}
