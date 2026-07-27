import { BadRequestException, Controller, Delete, Get, Param, Post, Body, UseGuards } from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { CurrentUser } from '../common/current-user.decorator';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { FirebaseAuthGuard } from '../common/firebase-auth.guard';
import { setWithCreatedAt } from '../common/firestore-batch.util';

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

/**
 * Per-user watchlist — replaces watchlist.tsx's direct Firestore
 * `setDoc`/`arrayUnion`/`arrayRemove` against `users/{uid}/watchlists/default`.
 * Every read/write is scoped to the verified `uid` from FirebaseAuthGuard,
 * never a client-supplied one — same pattern as StockNotesController.
 */
@Controller('api')
@UseGuards(FirebaseAuthGuard)
export class WatchlistController {
  constructor(private readonly firebase: FirebaseAdminService) {}

  private ref(uid: string) {
    return this.firebase.firestore.doc(`users/${uid}/watchlists/default`);
  }

  @Get('watchlist')
  async get(@CurrentUser() uid: string): Promise<{ tickers: string[] }> {
    const snap = await this.ref(uid).get();
    return { tickers: (snap.data()?.tickers as string[] | undefined) ?? [] };
  }

  @Post('watchlist/tickers')
  async add(@CurrentUser() uid: string, @Body() body: { ticker?: string }): Promise<{ tickers: string[] }> {
    const ticker = (body.ticker ?? '').toUpperCase().trim();
    if (!TICKER_RE.test(ticker)) throw new BadRequestException('ticker must be 1-10 chars, A-Z0-9.-');

    await setWithCreatedAt(this.firebase.firestore, this.ref(uid), {
      name: 'My Watchlist',
      tickers: FieldValue.arrayUnion(ticker),
    });
    return this.get(uid);
  }

  @Delete('watchlist/tickers/:ticker')
  async remove(@CurrentUser() uid: string, @Param('ticker') ticker: string): Promise<{ tickers: string[] }> {
    const symbol = ticker.toUpperCase().trim();
    await this.ref(uid).set({ tickers: FieldValue.arrayRemove(symbol) }, { merge: true });
    return this.get(uid);
  }
}
