import { StaffAccessService } from "../account/staff-access.service";
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Body,
  UseGuards,
} from "@nestjs/common";
import { FieldValue } from "firebase-admin/firestore";
import { CurrentUser } from "../common/current-user.decorator";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import { AiAnalysisService } from "../live/ai-analysis.service";
import { setWithCreatedAt } from "../common/firestore-batch.util";
import { SubscriptionsService } from "../plans/subscriptions.service";
import { planById } from "../plans/plans.registry";
import { BillingAccessService } from "../billing/billing-access.service";

/**
 * Watchlist ticker cap: the user's plan limit from the catalog
 * (plans.registry → limits.watchlistTickers; Free = 5, paid = unlimited),
 * enforced only while subscriptions are live (SUBSCRIPTIONS_ENABLED + a billing
 * provider). Off → no cap, today's behaviour.
 *
 * NEW ADDITIONS ONLY. A user who already holds more keeps every ticker they
 * saved — nothing is removed, hidden or truncated. Re-adding a ticker the list
 * already holds is always allowed.
 */
const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const MAX_LISTS = 25;
const DEFAULT_ID = "default";
const DEFAULT_NAME = "My Watchlist";

interface WatchlistSummary {
  id: string;
  name: string;
  tickers: string[];
}

/**
 * Per-user watchlists. Each list is a doc under `users/{uid}/watchlists/{id}`
 * shaped `{ name, tickers[] }`; a user can have several. The legacy single list
 * lived at `.../watchlists/default` — it is simply one of the lists now, so no
 * migration is needed. Every read/write is scoped to the verified `uid` from
 * FirebaseAuthGuard, never a client-supplied one.
 *
 * `GET/POST/DELETE /api/watchlist` (singular) are kept for back-compat:
 * consumers that only care about "every ticker I watch" (dashboard widget,
 * commentary "My names") read the union across all lists.
 */
@Controller("api")
@UseGuards(FirebaseAuthGuard)
export class WatchlistController {
  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly aiAnalysis: AiAnalysisService,
    private readonly subscriptions: SubscriptionsService,
    private readonly access: BillingAccessService,
    private readonly staff: StaffAccessService,
  ) {}

  /**
   * Refuse a symbol that is not a real listing.
   *
   * The format check alone accepted "ZZZZZZ", which then sat in the watchlist
   * producing failed quote and chart lookups on every screen that rendered it.
   * `tickers` is the synced universe (13k+ symbols, including dotted classes
   * like BRK.B), so membership is a reliable existence test.
   *
   * FAILS OPEN. If the lookup itself errors, the add proceeds: a Firestore
   * hiccup must not stop someone saving a symbol. The only rejection is a
   * successful read that found nothing.
   */
  private async assertTickerExists(ticker: string): Promise<void> {
    let exists: boolean;
    try {
      exists = (
        await this.firebase.firestore.collection("tickers").doc(ticker).get()
      ).exists;
    } catch {
      return; // fail open
    }
    if (!exists) {
      throw new BadRequestException(
        `${ticker} is not a symbol we track. Check the spelling — newly listed ` +
          `symbols can take a day to appear.`,
      );
    }
  }

  /**
   * Refuse an add that would push a free-tier list past the cap.
   *
   * A no-op when the user's plan has no limit, subscriptions are not live, or
   * the ticker is already in the list. Any failure to resolve the plan ALLOWS
   * the add: a billing lookup hiccup must not block someone from using their
   * own watchlist.
   */
  private async assertCanAdd(
    uid: string,
    existing: string[],
    ticker: string,
  ): Promise<void> {
    if (existing.includes(ticker)) return;
    const limit = await this.tickerLimitFor(uid);
    if (limit === null || existing.length < limit) return;
    throw new ForbiddenException({
      statusCode: 403,
      code: "plan_required",
      entitlement: "watchlistTickers",
      requiredPlan: "starter",
      message: `The Free plan holds up to ${limit} tickers per watchlist. Remove one, or upgrade to add more.`,
    });
  }

  /**
   * Tickers allowed per watchlist for this user, or null for no limit. Sent
   * with the lists so the client can show usage ("3 / 5") from the same check
   * that enforces it. Fails open (null): a billing lookup hiccup must never
   * lock someone out of their own list.
   */
  private async tickerLimitFor(uid: string): Promise<number | null> {
    try {
      if (!(await this.access.subscriptionsLive())) return null;
      if (await this.staff.isStaffUid(uid)) return null; // staff: no limits
      const { planId } = await this.subscriptions.forUser(uid);
      return planById(planId)?.limits.watchlistTickers ?? null;
    } catch {
      return null;
    }
  }

  private col(uid: string) {
    return this.firebase.firestore.collection(`users/${uid}/watchlists`);
  }

  private normTickers(v: unknown): string[] {
    return Array.isArray(v) ? (v as string[]) : [];
  }

  /** Every list for the user, ensuring at least one ("My Watchlist") exists. */
  private async listAll(uid: string): Promise<WatchlistSummary[]> {
    const snap = await this.col(uid).get();
    if (snap.empty) {
      await setWithCreatedAt(
        this.firebase.firestore,
        this.col(uid).doc(DEFAULT_ID),
        {
          name: DEFAULT_NAME,
          tickers: [],
        },
      );
      return [{ id: DEFAULT_ID, name: DEFAULT_NAME, tickers: [] }];
    }
    const lists = snap.docs.map((d) => ({
      id: d.id,
      name: (d.data()?.name as string | undefined) ?? DEFAULT_NAME,
      tickers: this.normTickers(d.data()?.tickers),
      createdAt: (d.data()?.createdAt as string | undefined) ?? "",
    }));
    // Stable order: default first, then by creation time, then name.
    lists.sort((a, b) => {
      if (a.id === DEFAULT_ID) return -1;
      if (b.id === DEFAULT_ID) return 1;
      return (
        (a.createdAt || "").localeCompare(b.createdAt || "") ||
        a.name.localeCompare(b.name)
      );
    });
    return lists.map(({ id, name, tickers }) => ({ id, name, tickers }));
  }

  private cleanName(raw: unknown): string {
    const name = String(raw ?? "")
      .trim()
      .slice(0, 60);
    if (!name) throw new BadRequestException("name is required");
    return name;
  }

  private cleanTicker(raw: unknown): string {
    const t = String(raw ?? "")
      .toUpperCase()
      .trim();
    if (!TICKER_RE.test(t))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    return t;
  }

  // ── Multi-list API ──────────────────────────────────────────────────────

  @Get("watchlists")
  async listWatchlists(
    @CurrentUser() uid: string,
  ): Promise<{ watchlists: WatchlistSummary[]; tickerLimit: number | null }> {
    const [watchlists, tickerLimit] = await Promise.all([
      this.listAll(uid),
      this.tickerLimitFor(uid),
    ]);
    return { watchlists, tickerLimit };
  }

  @Post("watchlists")
  async createWatchlist(
    @CurrentUser() uid: string,
    @Body() body: { name?: string },
  ): Promise<WatchlistSummary> {
    const name = this.cleanName(body.name);
    const existing = await this.col(uid).get();
    if (existing.size >= MAX_LISTS)
      throw new BadRequestException(
        `Maximum of ${MAX_LISTS} watchlists reached`,
      );

    const ref = this.col(uid).doc();
    await setWithCreatedAt(this.firebase.firestore, ref, { name, tickers: [] });
    return { id: ref.id, name, tickers: [] };
  }

  @Patch("watchlists/:id")
  async renameWatchlist(
    @CurrentUser() uid: string,
    @Param("id") id: string,
    @Body() body: { name?: string },
  ): Promise<WatchlistSummary> {
    const name = this.cleanName(body.name);
    const ref = this.col(uid).doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException("watchlist not found");
    await ref.set(
      { name, updatedAt: new Date().toISOString() },
      { merge: true },
    );
    return { id, name, tickers: this.normTickers(snap.data()?.tickers) };
  }

  @Delete("watchlists/:id")
  async deleteWatchlist(
    @CurrentUser() uid: string,
    @Param("id") id: string,
  ): Promise<{ watchlists: WatchlistSummary[] }> {
    const ref = this.col(uid).doc(id);
    if (!(await ref.get()).exists)
      throw new NotFoundException("watchlist not found");
    // Deleting the LAST list is allowed: listAll() below finds none left and
    // recreates an empty "My Watchlist", so the user always ends with one
    // list and deleting everything resets to the original empty state.
    await ref.delete();
    // Drop the list's cached AI summary too — nothing else ever revisits that
    // doc id, so without this it would linger in ai_watchlist_analysis forever.
    // ORDER MATTERS: this must run BEFORE listAll(). When the deleted list was
    // the default one, listAll() recreates it under the same "default" id, and
    // the fresh empty list must not inherit the old list's cached summary.
    await this.aiAnalysis.deleteWatchlistSummary(uid, id);
    return { watchlists: await this.listAll(uid) };
  }

  @Post("watchlists/:id/tickers")
  async addToList(
    @CurrentUser() uid: string,
    @Param("id") id: string,
    @Body() body: { ticker?: string },
  ): Promise<WatchlistSummary> {
    const ticker = this.cleanTicker(body.ticker);
    const ref = this.col(uid).doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException("watchlist not found");
    await this.assertTickerExists(ticker);
    await this.assertCanAdd(
      uid,
      this.normTickers(snap.data()?.tickers),
      ticker,
    );
    await ref.set(
      {
        tickers: FieldValue.arrayUnion(ticker),
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
    const after = await ref.get();
    return {
      id,
      name: (after.data()?.name as string) ?? DEFAULT_NAME,
      tickers: this.normTickers(after.data()?.tickers),
    };
  }

  @Delete("watchlists/:id/tickers/:ticker")
  async removeFromList(
    @CurrentUser() uid: string,
    @Param("id") id: string,
    @Param("ticker") ticker: string,
  ): Promise<WatchlistSummary> {
    const symbol = ticker.toUpperCase().trim();
    const ref = this.col(uid).doc(id);
    await ref.set(
      {
        tickers: FieldValue.arrayRemove(symbol),
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
    const after = await ref.get();
    return {
      id,
      name: (after.data()?.name as string) ?? DEFAULT_NAME,
      tickers: this.normTickers(after.data()?.tickers),
    };
  }

  // ── Legacy single-list API (union of every list) ────────────────────────

  @Get("watchlist")
  async get(@CurrentUser() uid: string): Promise<{ tickers: string[] }> {
    const all = await this.listAll(uid);
    const union = Array.from(new Set(all.flatMap((l) => l.tickers)));
    return { tickers: union };
  }

  @Post("watchlist/tickers")
  async add(
    @CurrentUser() uid: string,
    @Body() body: { ticker?: string },
  ): Promise<{ tickers: string[] }> {
    const ticker = this.cleanTicker(body.ticker);
    const ref = this.col(uid).doc(DEFAULT_ID);
    const snap = await ref.get();
    await this.assertTickerExists(ticker);
    if (snap.exists) {
      await this.assertCanAdd(
        uid,
        this.normTickers(snap.data()?.tickers),
        ticker,
      );
      // Never write `name` here — the user may have renamed the default list,
      // and this legacy endpoint must not clobber that rename.
      await ref.set(
        {
          tickers: FieldValue.arrayUnion(ticker),
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
    } else {
      await setWithCreatedAt(this.firebase.firestore, ref, {
        name: DEFAULT_NAME,
        tickers: FieldValue.arrayUnion(ticker),
      });
    }
    return this.get(uid);
  }

  @Delete("watchlist/tickers/:ticker")
  async remove(
    @CurrentUser() uid: string,
    @Param("ticker") ticker: string,
  ): Promise<{ tickers: string[] }> {
    const symbol = ticker.toUpperCase().trim();
    await this.col(uid)
      .doc(DEFAULT_ID)
      .set({ tickers: FieldValue.arrayRemove(symbol) }, { merge: true });
    return this.get(uid);
  }
}
