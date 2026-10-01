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
  OversellError,
  summarizeLots,
  TxnType,
  withRunningTotals,
} from "./portfolio-lots";

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Firestore auto-ids, plus the fixed "opening" id of a migrated holding. */
const TXN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Upper bound on shares per transaction — rejects typos like extra zeros. */
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
  /** Average cost per share of the open position (average-cost method).
   *  Null when the position is closed or no buy carries a price. */
  costBasis: number | null;
  /** Realized P/L from all sells of this holding. */
  realizedPL: number;
  /** Date of the FIRST transaction, YYYY-MM-DD. Null for a pre-transactions
   *  holding saved without a date. */
  purchaseDate: string | null;
}

interface HoldingHistory {
  ticker: string;
  summary: LotSummary;
  /** Buys and sells, newest first, each with the position right after it. */
  transactions: LotWithRunning[];
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
/** "2026-09-08" → "Sep 8, 2026", for error messages users read. */
function displayDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
function qtyText(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
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
function parseTradeDate(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !DATE_RE.test(value))
    throw new BadRequestException("trade date must be YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new BadRequestException("trade date is not a valid date");
  if (value < "1900-01-01")
    throw new BadRequestException("trade date is too far in the past");
  if (date.getTime() > Date.now() + 24 * 60 * 60 * 1000)
    throw new BadRequestException("trade date cannot be in the future");
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
      realizedPL: typeof data.realizedPL === "number" ? data.realizedPL : 0,
      purchaseDate:
        typeof data.purchaseDate === "string" ? data.purchaseDate : null,
    };
  }

  /**
   * A holding saved before transactions existed has totals but no `lots`
   * docs. Treat those totals as one buy so its history and average still make
   * sense. The id is fixed, so writing it later is idempotent.
   */
  private openingLot(data: DocumentData): Lot {
    const addedAt =
      typeof data.addedAt === "string"
        ? data.addedAt
        : new Date(0).toISOString();
    return {
      id: "opening",
      type: "buy",
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
      // Lots written before sells existed have no type — they are all buys.
      type: data.type === "sell" ? "sell" : "buy",
      shares: data.shares as number,
      price: typeof data.price === "number" ? data.price : null,
      date: data.date as string,
      createdAt: data.createdAt as string,
      ...(data.opening === true ? { opening: true } : {}),
    };
  }

  /**
   * Replays a holding's transactions, turning an oversell into a message the
   * user can act on. `action` says what caused it: recording a new sale, or
   * deleting a buy a later sale depended on.
   */
  private replayOrReject(
    lots: Lot[],
    ticker: string,
    action: "add" | "delete",
  ): LotSummary {
    try {
      return summarizeLots(lots);
    } catch (e) {
      if (!(e instanceof OversellError)) throw e;
      const held = qtyText(e.held);
      const sold = qtyText(e.attempted);
      const when = displayDate(e.date);
      throw new BadRequestException(
        action === "add"
          ? `You held ${held} shares of ${ticker} on ${when}, so you can't sell ${sold}.`
          : `This can't be deleted: your sale of ${sold} ${ticker} shares on ${when} ` +
              `would then be more than the ${held} you held. Delete that sale first.`,
      );
    }
  }

  /** The holding doc written after any change to its transactions. */
  private holdingFields(
    ticker: string,
    summary: LotSummary,
    existing: DocumentData | null,
    now: string,
    fallback: { positionSize?: string; conviction?: string } = {},
  ) {
    const positionSize: PositionSize =
      (existing?.positionSize as PositionSize | undefined) ??
      (POSITION_SIZES.includes(fallback.positionSize as PositionSize)
        ? (fallback.positionSize as PositionSize)
        : "Medium");
    const conviction: Conviction =
      (existing?.conviction as Conviction | undefined) ??
      (CONVICTIONS.includes(fallback.conviction as Conviction)
        ? (fallback.conviction as Conviction)
        : "Medium");
    return {
      ticker,
      shares: summary.shares,
      costBasis: summary.avgCost,
      realizedPL: summary.realizedPL,
      purchaseDate: summary.firstDate,
      lastTransactionDate: summary.lastDate,
      lotCount: summary.lotCount,
      positionSize,
      conviction,
      addedAt: (existing?.addedAt as string | undefined) ?? now,
      updatedAt: now,
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
   * Records ONE buy or sell. A buy of a new ticker creates the holding; any
   * other transaction is appended to the holding's `lots` and the whole
   * history is replayed to recompute shares, average cost and realized P/L.
   * A sell that would exceed the shares held on its trade date (including a
   * back-dated one) is rejected. Reads and writes share one Firestore
   * transaction, so two quick trades of the same ticker cannot race.
   */
  @Post("portfolio/holdings")
  async add(
    @CurrentUser() uid: string,
    @Body()
    body: {
      ticker?: string;
      /** "buy" (default) or "sell". */
      type?: string;
      shares?: number;
      /** Price per share for this transaction. */
      price?: number;
      /** Legacy name for `price`, still sent by older app builds. */
      costBasis?: number;
      tradeDate?: string;
      /** Legacy name for `tradeDate`. */
      purchaseDate?: string;
      positionSize?: string;
      conviction?: string;
    },
  ): Promise<HoldingDoc> {
    const ticker = (body.ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(ticker))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    if (body.type !== undefined && body.type !== "buy" && body.type !== "sell")
      throw new BadRequestException('type must be "buy" or "sell"');
    const type: TxnType = body.type === "sell" ? "sell" : "buy";
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
    // A sale's price is what realized P/L is computed from — never optional.
    if (type === "sell" && price === null)
      throw new BadRequestException("price is required for a sell");
    const date =
      parseTradeDate(body.tradeDate ?? body.purchaseDate) ?? utcToday();
    const now = new Date().toISOString();

    const holdingRef = this.holdingsCol(uid).doc(ticker);
    const lotsRef = this.lotsCol(uid, ticker);
    const newLotRef = lotsRef.doc();

    return this.firebase.firestore.runTransaction(async (tx) => {
      // Firestore transactions need every read before the first write.
      const holdingSnap = await tx.get(holdingRef);
      const lotsSnap = await tx.get(lotsRef);
      const existing = holdingSnap.data() ?? null;
      if (type === "sell" && !existing)
        throw new BadRequestException(
          `You don't hold ${ticker}, so it can't be sold.`,
        );

      const lots: Lot[] = lotsSnap.docs.map((d) => this.toLot(d.id, d.data()));
      if (existing && lots.length === 0) {
        const opening = this.openingLot(existing);
        if (opening.shares > 0) {
          lots.push(opening);
          const { id, ...fields } = opening;
          tx.set(lotsRef.doc(id), fields);
        }
      }
      const newLotFields = { type, shares, price, date, createdAt: now };
      lots.push({ id: newLotRef.id, ...newLotFields });

      const summary = this.replayOrReject(lots, ticker, "add");
      tx.set(newLotRef, newLotFields);
      const holding = this.holdingFields(ticker, summary, existing, now, body);
      tx.set(holdingRef, holding);
      return this.toHoldingDoc(ticker, holding);
    });
  }

  /**
   * Deletes ONE transaction and replays the rest to recompute the holding.
   * Refused when it would leave a later sale larger than the shares held on
   * its date (deleting a buy that sale depended on). Deleting the only
   * transaction removes the holding, since nothing would be left of it.
   */
  @Delete("portfolio/holdings/:ticker/transactions/:txnId")
  async deleteTransaction(
    @CurrentUser() uid: string,
    @Param("ticker") rawTicker: string,
    @Param("txnId") txnId: string,
  ): Promise<{ holding: HoldingDoc | null }> {
    const ticker = rawTicker.toUpperCase().trim();
    if (!TICKER_RE.test(ticker))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    if (!TXN_ID_RE.test(txnId))
      throw new BadRequestException("invalid transaction id");
    const holdingRef = this.holdingsCol(uid).doc(ticker);
    const lotsRef = this.lotsCol(uid, ticker);
    const now = new Date().toISOString();

    return this.firebase.firestore.runTransaction(async (tx) => {
      const holdingSnap = await tx.get(holdingRef);
      const lotsSnap = await tx.get(lotsRef);
      const existing = holdingSnap.data();
      if (!existing)
        throw new NotFoundException(`${ticker} is not in this portfolio`);

      let lots = lotsSnap.docs.map((d) => this.toLot(d.id, d.data()));
      // A holding from before transactions existed has no lot docs: its only
      // transaction is the synthesized opening buy.
      const stored = lots.length > 0;
      if (!stored) lots = [this.openingLot(existing)];
      if (!lots.some((l) => l.id === txnId))
        throw new NotFoundException("transaction not found");

      const remaining = lots.filter((l) => l.id !== txnId);
      if (remaining.length === 0) {
        if (stored) tx.delete(lotsRef.doc(txnId));
        tx.delete(holdingRef);
        return { holding: null };
      }
      const summary = this.replayOrReject(remaining, ticker, "delete");
      tx.delete(lotsRef.doc(txnId));
      const holding = this.holdingFields(ticker, summary, existing, now);
      tx.set(holdingRef, holding);
      return { holding: this.toHoldingDoc(ticker, holding) };
    });
  }

  /** Transaction history for one holding: summary plus every buy and sell,
   *  newest first. */
  @Get("portfolio/holdings/:ticker/transactions")
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
      transactions: withRunningTotals(lots),
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
