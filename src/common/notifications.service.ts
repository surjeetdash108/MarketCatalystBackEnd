import { Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "./firebase-admin.provider";
import {
  batchSetWithCreatedAt,
  type PendingWrite,
} from "./firestore-batch.util";

/** Per-user cap — the bell subscribes to the whole subcollection. */
const MAX_PER_USER = 100;
const MAX_AGE_DAYS = 30;

export interface NotificationInput {
  /** Article id — stable, so a re-run updates in place instead of duplicating. */
  id: string;
  type: "news";
  header: string;
  detail: string | null;
  imageUrl: string | null;
  /** Tickers the story mentions; matched against each user's tracked set. */
  tickers: string[];
  source: string | null;
  url: string | null;
  publishedAt: string;
  /** How the news reads for the stock: +ve, -ve or neutral. Drives the bell's
   *  colour so a user sees at a glance whether their holding got good/bad news. */
  direction: "positive" | "negative" | "neutral";
  /** Which importance rule(s) fired — keeps the heuristic auditable from data. */
  reasons: string[];
}

/** A user and the tickers they track (watchlist ∪ portfolio holdings). */
interface Subscriber {
  uid: string;
  tickers: Set<string>;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly firebase: FirebaseAdminService) {}

  /**
   * Every user's tracked tickers, from watchlist + portfolio holdings.
   *
   *   watchlist: users/{uid}/watchlists/default   -> { tickers: string[] }
   *   holdings : users/{uid}/portfolios/default/holdings/{TICKER}
   *
   * Users tracking nothing are omitted entirely, so they receive no
   * notifications — the bell shows an empty state prompting them to add
   * tickers rather than silently filling with irrelevant news.
   *
   * NOTE ON SCALE: this reads two documents per user per run, which is fine at
   * the current user count. Past a few thousand users, invert it — maintain a
   * ticker -> uid index updated when a watchlist changes — rather than
   * enumerating every user on every news sync.
   */
  private async loadSubscribers(): Promise<Subscriber[]> {
    const users = await this.firebase.firestore.collection("users").get();
    const out: Subscriber[] = [];

    for (const u of users.docs) {
      const tickers = new Set<string>();

      // Union of every watchlist the user has (a user can keep several named
      // lists now, each a doc under users/{uid}/watchlists/{id}).
      const watchlists = await this.firebase.firestore
        .collection(`users/${u.id}/watchlists`)
        .get();
      for (const wl of watchlists.docs) {
        for (const t of (wl.data()?.tickers as string[] | undefined) ?? []) {
          if (t) tickers.add(t.toUpperCase());
        }
      }

      const holdings = await this.firebase.firestore
        .collection(`users/${u.id}/portfolios/default/holdings`)
        .get();
      for (const h of holdings.docs) {
        // Holding doc id IS the ticker; the field is a fallback.
        const t = (h.data()?.ticker as string | undefined) ?? h.id;
        if (t) tickers.add(t.toUpperCase());
      }

      if (tickers.size > 0) out.push({ uid: u.id, tickers });
    }
    return out;
  }

  /**
   * Fans each important story out to the users who track one of its tickers.
   *
   * Nothing is written for a story no one tracks — that is the point of the
   * change: the backend no longer stores every important article, only the ones
   * some user actually cares about. The article itself already lives in `news`.
   */
  async publish(items: NotificationInput[]): Promise<{
    written: number;
    recipients: number;
    skipped: number;
  }> {
    if (items.length === 0) return { written: 0, recipients: 0, skipped: 0 };

    const subs = await this.loadSubscribers();
    if (subs.length === 0) {
      this.logger.log(
        `${items.length} important article(s) but no user tracks any ticker — nothing written`,
      );
      return { written: 0, recipients: 0, skipped: items.length };
    }

    const writes: PendingWrite[] = [];
    const recipients = new Set<string>();
    let skipped = 0;

    for (const n of items) {
      const upper = n.tickers.map((t) => t.toUpperCase());
      const matched = subs.filter((s) => upper.some((t) => s.tickers.has(t)));
      if (matched.length === 0) {
        skipped++;
        continue;
      }
      for (const s of matched) {
        recipients.add(s.uid);
        writes.push({
          ref: this.firebase.firestore.doc(
            `users/${s.uid}/notifications/${n.id}`,
          ),
          data: {
            type: n.type,
            header: n.header,
            detail: n.detail,
            imageUrl: n.imageUrl,
            tickers: n.tickers,
            /** The subset the user actually tracks — lets the UI say why they got it. */
            matchedTickers: upper.filter((t) => s.tickers.has(t)),
            source: n.source,
            url: n.url,
            publishedAt: n.publishedAt,
            direction: n.direction,
            reasons: n.reasons,
            read: false,
            updatedAt: new Date().toISOString(),
          },
        });
      }
    }

    await batchSetWithCreatedAt(this.firebase.firestore, writes);
    if (writes.length > 0) {
      this.logger.log(
        `notifications: ${writes.length} write(s) to ${recipients.size} user(s); ${skipped} story(s) matched no subscriber`,
      );
    }
    return { written: writes.length, recipients: recipients.size, skipped };
  }

  /** Trims each user's subcollection to MAX_PER_USER and MAX_AGE_DAYS. */
  async prune(): Promise<number> {
    const cutoff = new Date(
      Date.now() - MAX_AGE_DAYS * 86400_000,
    ).toISOString();
    const users = await this.firebase.firestore.collection("users").get();
    let deleted = 0;

    for (const u of users.docs) {
      const col = this.firebase.firestore.collection(
        `users/${u.id}/notifications`,
      );
      const snap = await col.orderBy("publishedAt", "desc").get();
      if (snap.empty) continue;

      const stale = snap.docs.filter(
        (d) => (d.data().publishedAt ?? "") < cutoff,
      );
      const fresh = snap.docs.filter(
        (d) => (d.data().publishedAt ?? "") >= cutoff,
      );
      const doomed = [...stale, ...fresh.slice(MAX_PER_USER)];

      for (let i = 0; i < doomed.length; i += 500) {
        const batch = this.firebase.firestore.batch();
        doomed.slice(i, i + 500).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
      deleted += doomed.length;
    }
    if (deleted > 0) this.logger.log(`notifications pruned: ${deleted} doc(s)`);
    return deleted;
  }
}
