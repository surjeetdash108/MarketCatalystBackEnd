import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { DocumentData } from "firebase-admin/firestore";
import { CurrentUser } from "../common/current-user.decorator";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";
import {
  Lot,
  LotSummary,
  LotWithRunning,
  summarizeLots,
  withRunningTotals,
} from "./portfolio-lots";

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Upper bound on shares per purchase — rejects typos like an extra few zeros. */
const MAX_SHARES = 1_000_000_000;
/** Upper bound on price per share — same purpose. */
const MAX_PRICE = 10_000_000;
const POSITION_SIZES = ["Small", "Medium", "Large"] as const;
const CONVICTIONS = ["High", "Medium", "Low"] as const;
type PositionSize = (typeof POSITION_SIZES)[number];
type Conviction = (typeof CONVICTIONS)[number];

interface HoldingDoc {
  id: string;
  ticker: string;
  shares: number;
  positionSize: PositionSize;
  conviction: Conviction;
  /** Average purchase price per share across all buy lots. Null when no lot
   *  carries a price — unrealized P&L is only shown for holdings with a basis. */
  costBasis: number | null;
  /** Date of the FIRST purchase, YYYY-MM-DD. Null for a pre-lots holding saved
   *  without a date. */
  purchaseDate: string | null;
}

interface HoldingHistory {
  ticker: string;
  summary: LotSummary;
  /** Newest first, each with the running position after it. */
  lots: LotWithRunning[];
}

/** Today in UTC as YYYY-MM-DD — the trade date for clients that send none. */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Validates an optional purchase date. Empty/absent → null. Rejects anything
 * that is not a real calendar date in YYYY-MM-DD form, or that is in the
 * future. One day of slack past "now" covers users ahead of UTC, whose local
 * today is already tomorrow in UTC.
 */
function parsePurchaseDate(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !DATE_RE.test(value))
    throw new BadRequestException("purchaseDate must be YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new BadRequestException("purchaseDate is not a valid date");
  if (value < "1900-01-01")
    throw new BadRequestException("purchaseDate is too far in the past");
  if (date.getTime() > Date.now() + 24 * 60 * 60 * 1000)
    throw new BadRequestException("purchaseDate cannot be in the future");
  return value;
}

/**
 * Per-user portfolio holdings — replaces portfolio.tsx's direct Firestore
 * `setDoc`/`deleteDoc` against `users/{uid}/portfolios/default/holdings/{TICKER}`.
 * Every read/write is scoped to the verified `uid` from FirebaseAuthGuard,
 * never a client-supplied one — same pattern as StockNotesController.
 *
 * The debounced `totalValue`/`dayPL`/`holdingsCount` summary write
 * portfolio.tsx used to make to the parent `portfolios/default` doc is
 * dropped here, not ported: it was write-only — every reader (portfolio.tsx
 * itself, dashboard.tsx) already recomputes those figures client-side from
 * live holdings + prices, nothing ever read the written fields back.
 */
@Controller("api")
@UseGuards(FirebaseAuthGuard)
export class PortfolioController {
  constructor(private readonly firebase: FirebaseAdminService) {}

  private holdingsCol(uid: string) {
    return this.firebase.firestore.collection(
      `users/${uid}/portfolios/default/holdings`,
    );
  }

  private lotsCol(uid: string, ticker: string) {
    return this.holdingsCol(uid).doc(ticker).collection("lots");
  }

  private toHoldingDoc(id: string, data: DocumentData): HoldingDoc {
    return {
      id,
      ticker: (data.ticker as string) ?? id,
      shares: (data.shares as number) ?? 0,
      positionSize: (data.positionSize as PositionSize) ?? "Medium",
      conviction: (data.conviction as Conviction) ?? "Medium",
      costBasis: typeof data.costBasis === "number" ? data.costBasis : null,
      purchaseDate:
        typeof data.purchaseDate === "string" ? data.purchaseDate : null,
    };
  }

  /**
   * A holding saved before lots existed has totals but no `lots` docs. Treat
   * those totals as one opening lot so its history and average still make
   * sense. The id is fixed, so writing it later is idempotent.
   */
  private openingLot(data: DocumentData): Lot {
    const addedAt =
      typeof data.addedAt === "string"
        ? data.addedAt
        : new Date(0).toISOString();
    return {
      id: "opening",
      shares: typeof data.shares === "number" ? data.shares : 0,
      price: typeof data.costBasis === "number" ? data.costBasis : null,
      date:
        typeof data.purchaseDate === "string"
          ? data.purchaseDate
          : addedAt.slice(0, 10),
      createdAt: addedAt,
      opening: true,
    };
  }

  private toLot(id: string, data: DocumentData): Lot {
    return {
      id,
      shares: data.shares as number,
      price: typeof data.price === "number" ? data.price : null,
      date: data.date as string,
      createdAt: data.createdAt as string,
      ...(data.opening === true ? { opening: true } : {}),
    };
  }

  @Get("portfolio")
  async list(@CurrentUser() uid: string): Promise<{ holdings: HoldingDoc[] }> {
    const snap = await this.holdingsCol(uid).get();
    return {
      holdings: snap.docs.map((d) => this.toHoldingDoc(d.id, d.data())),
    };
  }

  /**
   * Records ONE purchase. Adding a ticker the user already holds appends a lot
   * and recomputes the holding's share count and average cost, instead of
   * overwriting it. All reads and writes run in one transaction, so two quick
   * buys of the same ticker cannot lose each other's shares.
   */
  @Post("portfolio/holdings")
  async add(
    @CurrentUser() uid: string,
    @Body()
    body: {
      ticker?: string;
      shares?: number;
      /** Price paid per share for this purchase. */
      price?: number;
      /** Legacy name for `price`, still sent by older app builds. */
      costBasis?: number;
      purchaseDate?: string;
      positionSize?: string;
      conviction?: string;
    },
  ): Promise<HoldingDoc> {
    const ticker = (body.ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(ticker))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    // Omitted entirely → an older build that never had the field: keep its
    // legacy default of 10. Sent but not a sane positive number → error.
    let shares = 10;
    if (body.shares !== undefined) {
      if (
        typeof body.shares !== "number" ||
        !Number.isFinite(body.shares) ||
        body.shares <= 0 ||
        body.shares > MAX_SHARES
      )
        throw new BadRequestException(
          `shares must be a number greater than 0 and at most ${MAX_SHARES}`,
        );
      shares = body.shares;
    }
    const rawPrice = body.price ?? body.costBasis;
    let price: number | null = null;
    if (rawPrice !== undefined && rawPrice !== null) {
      if (
        typeof rawPrice !== "number" ||
        !Number.isFinite(rawPrice) ||
        rawPrice <= 0 ||
        rawPrice > MAX_PRICE
      )
        throw new BadRequestException(
          `price must be a number greater than 0 and at most ${MAX_PRICE}`,
        );
      price = rawPrice;
    }
    const date = parsePurchaseDate(body.purchaseDate) ?? utcToday();
    const now = new Date().toISOString();

    const holdingRef = this.holdingsCol(uid).doc(ticker);
    const lotsRef = this.lotsCol(uid, ticker);
    const newLotRef = lotsRef.doc();

    return this.firebase.firestore.runTransaction(async (tx) => {
      // Firestore transactions need every read before the first write.
      const holdingSnap = await tx.get(holdingRef);
      const lotsSnap = await tx.get(lotsRef);
      const existing = holdingSnap.data() ?? null;

      const lots: Lot[] = lotsSnap.docs.map((d) => this.toLot(d.id, d.data()));
      if (existing && lots.length === 0) {
        const opening = this.openingLot(existing);
        if (opening.shares > 0) {
          lots.push(opening);
          const { id, ...fields } = opening;
          tx.set(lotsRef.doc(id), fields);
        }
      }
      const newLotFields = { shares, price, date, createdAt: now };
      lots.push({ id: newLotRef.id, ...newLotFields });
      tx.set(newLotRef, newLotFields);

      const summary = summarizeLots(lots);
      const positionSize: PositionSize =
        (existing?.positionSize as PositionSize | undefined) ??
        (POSITION_SIZES.includes(body.positionSize as PositionSize)
          ? (body.positionSize as PositionSize)
          : "Medium");
      const conviction: Conviction =
        (existing?.conviction as Conviction | undefined) ??
        (CONVICTIONS.includes(body.conviction as Conviction)
          ? (body.conviction as Conviction)
          : "Medium");
      const holding = {
        ticker,
        shares: summary.shares,
        costBasis: summary.avgCost,
        purchaseDate: summary.firstDate,
        lastPurchaseDate: summary.lastDate,
        lotCount: summary.lotCount,
        positionSize,
        conviction,
        addedAt: (existing?.addedAt as string | undefined) ?? now,
        updatedAt: now,
      };
      tx.set(holdingRef, holding);
      return this.toHoldingDoc(ticker, holding);
    });
  }

  /** Purchase history for one holding: summary plus every lot, newest first. */
  @Get("portfolio/holdings/:ticker/lots")
  async history(
    @CurrentUser() uid: string,
    @Param("ticker") rawTicker: string,
  ): Promise<HoldingHistory> {
    const ticker = rawTicker.toUpperCase().trim();
    if (!TICKER_RE.test(ticker))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    const holdingRef = this.holdingsCol(uid).doc(ticker);
    const [holdingSnap, lotsSnap] = await Promise.all([
      holdingRef.get(),
      this.lotsCol(uid, ticker).get(),
    ]);
    let lots = lotsSnap.docs.map((d) => this.toLot(d.id, d.data()));
    const holdingData = holdingSnap.data();
    if (!holdingData)
      throw new NotFoundException(`${ticker} is not in this portfolio`);
    if (lots.length === 0) lots = [this.openingLot(holdingData)];
    return {
      ticker,
      summary: summarizeLots(lots),
      lots: withRunningTotals(lots),
    };
  }

  @Delete("portfolio/holdings/:ticker")
  async remove(
    @CurrentUser() uid: string,
    @Param("ticker") ticker: string,
  ): Promise<{ ok: true }> {
    // recursiveDelete also removes the `lots` subcollection; a plain delete()
    // would leave orphaned lots that reappear if the ticker is re-added.
    await this.firebase.firestore.recursiveDelete(
      this.holdingsCol(uid).doc(ticker.toUpperCase().trim()),
    );
    return { ok: true };
  }
}
