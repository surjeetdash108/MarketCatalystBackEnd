import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Timestamp } from 'firebase-admin/firestore';
import { CurrentUser } from '../common/current-user.decorator';
import { FirebaseAdminService } from '../common/firebase-admin.provider';
import { FirebaseAuthGuard } from '../common/firebase-auth.guard';

const SYM_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

interface StockNote {
  id: string;
  sym: string;
  name: string;
  comment: string;
  createdAt: string;
}

/**
 * Per-user chart notes on a stock — replaces stock.tsx's direct Firestore
 * `addDoc`/`getDocs`/`deleteDoc` against `stock_comments`. Every read/write is
 * scoped to the verified `uid` from FirebaseAuthGuard, never a client-supplied
 * one, so a user can only ever see or delete their own notes (see
 * firebase-auth.guard.ts's doc-comment, which names this controller
 * explicitly as the reason the guard exists).
 */
@Controller('api')
@UseGuards(FirebaseAuthGuard)
export class StockNotesController {
  constructor(private readonly firebase: FirebaseAdminService) {}

  @Get('stock-notes')
  async list(@CurrentUser() uid: string, @Query('sym') sym: string | undefined): Promise<StockNote[]> {
    const symbol = (sym ?? '').toUpperCase().trim();
    if (!SYM_RE.test(symbol)) throw new BadRequestException('sym must be 1-10 chars, A-Z0-9.-');

    // The deployed composite index for stock_comments is (uid, sym, createdAt
    // ASCENDING) — ordering DESCENDING here would need a second index Firestore
    // doesn't have (FAILED_PRECONDITION). Query in the direction the index
    // supports and reverse in memory instead, same fix as useOhlcvBars.ts's
    // ohlcv_bars query used on the frontend for the identical situation.
    const snap = await this.firebase.firestore
      .collection('stock_comments')
      .where('uid', '==', uid)
      .where('sym', '==', symbol)
      .orderBy('createdAt', 'asc')
      .get();

    return snap.docs.reverse().map((d) => {
      const data = d.data();
      return {
        id: d.id,
        sym: data.sym as string,
        name: data.name as string,
        comment: data.comment as string,
        createdAt: (data.createdAt as Timestamp).toDate().toISOString(),
      };
    });
  }

  @Post('stock-notes')
  async create(
    @CurrentUser() uid: string,
    @Body() body: { sym?: string; name?: string; comment?: string },
  ): Promise<StockNote> {
    const symbol = (body.sym ?? '').toUpperCase().trim();
    const name = (body.name ?? '').trim() || symbol;
    const comment = (body.comment ?? '').trim();
    if (!SYM_RE.test(symbol)) throw new BadRequestException('sym must be 1-10 chars, A-Z0-9.-');
    if (!comment) throw new BadRequestException('comment is required');

    const now = Timestamp.now();
    const ref = await this.firebase.firestore.collection('stock_comments').add({
      uid,
      sym: symbol,
      name,
      comment,
      createdAt: now,
    });
    return { id: ref.id, sym: symbol, name, comment, createdAt: now.toDate().toISOString() };
  }

  @Delete('stock-notes/:id')
  async remove(@CurrentUser() uid: string, @Param('id') id: string): Promise<{ ok: true }> {
    const ref = this.firebase.firestore.collection('stock_comments').doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException('Note not found');
    if (snap.data()?.uid !== uid) throw new ForbiddenException('Not your note');
    await ref.delete();
    return { ok: true };
  }
}
