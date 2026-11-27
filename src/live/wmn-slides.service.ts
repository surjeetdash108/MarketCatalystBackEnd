import { Injectable, Logger } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { macroEventKind } from "../market-data/macro-event-kind";
import { StockInFocusService } from "../stock-in-focus/stock-in-focus.service";
import { CachedCollectionsService } from "./cached-collections.service";
import {
  analystSummary,
  earningsFocus,
  etDayOf,
  latestBreadth,
  sp500Weights,
  upcomingCatalysts,
  type WmnComposed,
  type WmnSlidesPayload,
} from "./wmn-slides.util";

type Row = Record<string, unknown>;

/**
 * Where the index-members job keeps the S&P 500 list (INDEX_MEMBERS_DOC in
 * sync/index-members.job.ts). Repeated here, not imported: that file is a sync
 * job, and importing it would pull the job and its own live-module imports into
 * this one.
 */
const INDEX_MEMBERS_DOC = "config/index_members";

/** The composed payload is reused this long per instance. */
const SLIDES_TTL_MS = 2 * 60 * 1000;
/** Index membership changes a few times a year; one read a few hours is plenty. */
const MEMBERS_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * How long one slide's data may take before that slide is left out of THIS
 * response. The dashboard's request gives up at 20 s, and the digest rides in the
 * same response, so nothing here may be allowed to run that long.
 *
 * Measured 27 Nov 2026: a fresh backend's FIRST request took 20 s and was cut off,
 * because the shared cache cold-loads each collection in full on first use
 * (earnings_events is ~12,000 documents, analyst_actions ~2,500) and the old code
 * waited for all of them. Every new Cloud Run instance would have done the same.
 */
export const SLOW_DATA_DEADLINE_MS = 4_000;
/**
 * A response that had to leave something out is reused only this long, so the
 * slide fills in as soon as its collection has finished loading in the background
 * (the load is not cancelled; only this response stops waiting for it).
 */
const INCOMPLETE_TTL_MS = 15 * 1000;
const DAY_MS = 86_400_000;

interface Loaded {
  rows: Row[];
  /** False when the data was not ready in time, or failed: the slide built from it is partial. */
  complete: boolean;
}

/**
 * The data-backed slides of "What Matters Now" (market breadth + the S&P 500's
 * heaviest names, the next 24 hours of releases, the day's biggest earnings, what
 * analysts did). One small object built from collections the app already keeps in
 * the shared in-memory cache, plus a two-day earnings read, so the dashboard makes
 * the request it already makes and no new list is downloaded.
 *
 * READ-ONLY. Nothing here writes to Firestore, calls a vendor or calls a model.
 * Each slide is built independently: a failure or a slow load in one leaves that
 * slide empty for now, it never takes the digest or the other slides down with it.
 */
@Injectable()
export class WmnSlidesService {
  private readonly logger = new Logger(WmnSlidesService.name);
  private cache: { at: number; value: WmnComposed } | null = null;
  private inflight: Promise<WmnComposed> | null = null;
  private members: { at: number; set: Set<string> } | null = null;

  constructor(
    private readonly cached: CachedCollectionsService,
    private readonly firebase: FirebaseAdminService,
    private readonly stockInFocus: StockInFocusService,
  ) {}

  /**
   * The composed slides plus the desk's latest Stock in Focus. The entry is NOT
   * part of the 2-minute composed cache: it has its own 60-second cache that a
   * write drops, so a post the desk just made reaches the slide promptly. Its
   * failure leaves the slide empty and nothing else.
   */
  async get(now = new Date()): Promise<WmnSlidesPayload> {
    const [composed, entry] = await Promise.all([
      this.composed(now),
      this.stockInFocus.latest().catch((err: Error) => {
        this.logger.warn(`what-matters-now slides: stockInFocus failed: ${err.message}`);
        return null;
      }),
    ]);
    return { ...composed, stockInFocus: entry };
  }

  private async composed(now: Date): Promise<WmnComposed> {
    if (this.cache && now.getTime() - this.cache.at < SLIDES_TTL_MS) return this.cache.value;
    if (this.inflight) return this.inflight;
    this.inflight = this.compose(now)
      .then(({ value, complete }) => {
        // A partial response is kept briefly, not for the full TTL: backdating
        // `at` makes it expire INCOMPLETE_TTL_MS from now.
        const at = complete ? now.getTime() : now.getTime() - (SLIDES_TTL_MS - INCOMPLETE_TTL_MS);
        this.cache = { at, value };
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async sp500(): Promise<Set<string>> {
    if (this.members && Date.now() - this.members.at < MEMBERS_TTL_MS) return this.members.set;
    const snap = await this.firebase.firestore.doc(INDEX_MEMBERS_DOC).get();
    const list = (snap.data()?.sp500 ?? []) as unknown;
    const set = new Set<string>(Array.isArray(list) ? list.filter((t): t is string => typeof t === "string") : []);
    // An empty list is a missing doc, not an index with no members: do not cache it.
    if (set.size > 0) this.members = { at: Date.now(), set };
    return set;
  }

  /**
   * Runs one read with a deadline. The read itself is never cancelled: when it
   * loses the race it carries on filling the shared cache, so the next response
   * finds it ready. A failure is logged and treated like a miss.
   */
  private async load(label: string, read: () => Promise<unknown[]>): Promise<Loaded> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SLOW_DATA_DEADLINE_MS);
    });
    try {
      const rows = await Promise.race([read(), late]);
      if (rows === null) {
        this.logger.warn(
          `what-matters-now slides: ${label} not ready after ${SLOW_DATA_DEADLINE_MS} ms; leaving it out of this response`,
        );
        return { rows: [], complete: false };
      }
      return { rows: rows as Row[], complete: true };
    } catch (err) {
      this.logger.warn(`what-matters-now slides: ${label} failed: ${(err as Error).message}`);
      return { rows: [], complete: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /** One allow-listed collection from the shared in-memory cache. */
  private fromCache(name: string) {
    return this.load(name, async () => (await this.cached.get([name]))[name] ?? []);
  }

  /**
   * Only the rows for the given days, straight from Firestore. Used for earnings,
   * where the cached collection holds the whole calendar (~12,000 documents) and
   * the slide needs one or two days of it. `in` on one field needs no index.
   */
  private forDays(collection: string, field: string, days: string[]) {
    return this.load(collection, async () => {
      const snap = await this.firebase.firestore.collection(collection).where(field, "in", days).get();
      return snap.docs.map((d): Row => ({ ...d.data(), id: d.id }));
    });
  }

  private async compose(now: Date): Promise<{ value: WmnComposed; complete: boolean }> {
    const guard = async <T>(label: string, fallback: T, fn: () => T | Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        this.logger.warn(`what-matters-now slides: ${label} failed: ${(err as Error).message}`);
        return fallback;
      }
    };

    // Yesterday and today on the New York calendar: the two days the earnings slide can use.
    const days = [etDayOf(new Date(now.getTime() - DAY_MS)), etDayOf(now)];
    const [companies, breadthRows, macro, analystDocs, events, announcements] = await Promise.all([
      this.fromCache("companies"),
      this.fromCache("market_breadth"),
      this.fromCache("macro_events"),
      this.fromCache("analyst_actions"),
      this.forDays("earnings_events", "date", days),
      this.forDays("earnings_announcements", "announceDate", days),
    ]);

    const [weights, catalysts, earnings, analysts, breadth] = await Promise.all([
      guard("weights", null, async () => sp500Weights(companies.rows, await this.sp500())),
      guard("catalysts", [], () => upcomingCatalysts(macro.rows, now, macroEventKind)),
      guard("earnings", null, () => earningsFocus(events.rows, announcements.rows, companies.rows, now)),
      guard("analysts", null, () => analystSummary(analystDocs.rows, companies.rows, now)),
      guard("breadth", null, () => latestBreadth(breadthRows.rows, now)),
    ]);

    const complete = [companies, breadthRows, macro, analystDocs, events, announcements].every((l) => l.complete);
    return { value: { breadth, weights, catalysts, earnings, analysts }, complete };
  }
}
