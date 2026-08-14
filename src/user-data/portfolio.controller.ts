import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser } from "../common/current-user.decorator";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
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
  /** Average purchase price per share. Null when the user hasn't entered one —
   *  unrealized P&L is only shown for holdings that carry a basis. */
  costBasis: number | null;
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

  @Get("portfolio")
  async list(@CurrentUser() uid: string): Promise<{ holdings: HoldingDoc[] }> {
    const snap = await this.holdingsCol(uid).get();
    return {
      holdings: snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ticker: (data.ticker as string) ?? d.id,
          shares: (data.shares as number) ?? 0,
          positionSize: (data.positionSize as PositionSize) ?? "Medium",
          conviction: (data.conviction as Conviction) ?? "Medium",
          costBasis: typeof data.costBasis === "number" ? data.costBasis : null,
        };
      }),
    };
  }

  @Post("portfolio/holdings")
  async add(
    @CurrentUser() uid: string,
    @Body()
    body: {
      ticker?: string;
      shares?: number;
      positionSize?: string;
      conviction?: string;
      costBasis?: number;
    },
  ): Promise<HoldingDoc> {
    const ticker = (body.ticker ?? "").toUpperCase().trim();
    if (!TICKER_RE.test(ticker))
      throw new BadRequestException("ticker must be 1-10 chars, A-Z0-9.-");
    const positionSize = POSITION_SIZES.includes(
      body.positionSize as PositionSize,
    )
      ? (body.positionSize as PositionSize)
      : "Medium";
    const conviction = CONVICTIONS.includes(body.conviction as Conviction)
      ? (body.conviction as Conviction)
      : "Medium";
    // No shares input exists in the UI's Add Holding form yet — 10 matches the
    // hardcoded default the frontend has always written.
    const shares =
      typeof body.shares === "number" && body.shares > 0 ? body.shares : 10;
    // Optional average cost per share; absent/invalid → null (no basis stored).
    const costBasis =
      typeof body.costBasis === "number" && body.costBasis > 0
        ? body.costBasis
        : null;

    await this.holdingsCol(uid).doc(ticker).set({
      ticker,
      shares,
      positionSize,
      conviction,
      costBasis,
      addedAt: new Date().toISOString(),
    });
    return { id: ticker, ticker, shares, positionSize, conviction, costBasis };
  }

  @Delete("portfolio/holdings/:ticker")
  async remove(
    @CurrentUser() uid: string,
    @Param("ticker") ticker: string,
  ): Promise<{ ok: true }> {
    await this.holdingsCol(uid).doc(ticker.toUpperCase().trim()).delete();
    return { ok: true };
  }
}
