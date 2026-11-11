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
} from "@nestjs/common";
import {
  DocumentSnapshot,
  QueryDocumentSnapshot,
  Timestamp,
} from "firebase-admin/firestore";
import { CurrentUser } from "../common/current-user.decorator";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { FirebaseAuthGuard } from "../common/firebase-auth.guard";

const SYM_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

interface StockNote {
  id: string;
  sym: string;
  name: string;
  comment: string;
  createdAt: string;
}

interface StockNotesPage {
  items: StockNote[];
  /** Pass back as `?cursor=` for the next page; null when there are no more. */
  nextCursor: string | null;
}

function toStockNote(d: QueryDocumentSnapshot | DocumentSnapshot): StockNote {
  const data = d.data() ?? {};
  return {
    id: d.id,
    sym: data.sym as string,
    name: data.name as string,
    comment: data.comment as string,
    createdAt: (data.createdAt as Timestamp).toDate().toISOString(),
  };
}

/**
 * Per-user chart notes on a stock — replaces stock.tsx's direct Firestore
 * `addDoc`/`getDocs`/`deleteDoc` against `stock_comments`. Every read/write is
 * scoped to the verified `uid` from FirebaseAuthGuard, never a client-supplied
 * one, so a user can only ever see or delete their own notes (see
 * firebase-auth.guard.ts's doc-comment, which names this controller
 * explicitly as the reason the guard exists).
 */
@Controller("api")
@UseGuards(FirebaseAuthGuard)
export class StockNotesController {
  constructor(private readonly firebase: FirebaseAdminService) {}

  @Get("stock-notes")
  async list(
    @CurrentUser() uid: string,
    @Query("sym") sym: string | undefined,
  ): Promise<StockNote[]> {
    const symbol = (sym ?? "").toUpperCase().trim();
    if (!SYM_RE.test(symbol))
      throw new BadRequestException("sym must be 1-10 chars, A-Z0-9.-");

    // The deployed composite index for stock_comments is (uid, sym, createdAt
    // ASCENDING) — ordering DESCENDING here would need a second index Firestore
    // doesn't have (FAILED_PRECONDITION). Query in the direction the index
    // supports and reverse in memory instead, same fix as useOhlcvBars.ts's
    // ohlcv_bars query used on the frontend for the identical situation.
    const snap = await this.firebase.firestore
      .collection("stock_comments")
      .where("uid", "==", uid)
      .where("sym", "==", symbol)
      .orderBy("createdAt", "asc")
      .get();

    return snap.docs.reverse().map(toStockNote);
  }

  /**
   * Every note the caller owns, across all tickers, newest first — backs the
   * profile / My Workspace "Chart Notes" view. Cursor-paginated (cursor = the
   * last note id of the previous page); the client groups by `sym` for the
   * per-ticker layout.
   *
   * Deliberately needs no composite index: the query is a lone `uid` equality
   * (served by Firestore's automatic single-field index) and the newest-first
   * sort + paging happen in memory. The trade-off is that every page reads all
   * of the caller's notes — fine at per-user note volumes; if that ever grows
   * large, move to a (uid ASC, createdAt DESC) index with `startAfter`.
   */
  @Get("stock-notes/all")
  async listAll(
    @CurrentUser() uid: string,
    @Query("limit") limitRaw: string | undefined,
    @Query("cursor") cursor: string | undefined,
  ): Promise<StockNotesPage> {
    const limit =
      limitRaw === undefined
        ? DEFAULT_PAGE_SIZE
        : Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
      throw new BadRequestException(
        `limit must be an integer between 1 and ${MAX_PAGE_SIZE}`,
      );

    const snap = await this.firebase.firestore
      .collection("stock_comments")
      .where("uid", "==", uid)
      .get();

    // Newest first; id tie-break keeps the order (and so the cursor) stable
    // when two notes share a createdAt.
    const notes = snap.docs
      .map(toStockNote)
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? b.id.localeCompare(a.id)
          : b.createdAt.localeCompare(a.createdAt),
      );

    let start = 0;
    if (cursor) {
      // Only the caller's own notes are in `notes`, so an unknown id or
      // another user's id both land here — reject rather than silently
      // restarting from page 1.
      const idx = notes.findIndex((n) => n.id === cursor);
      if (idx === -1) throw new BadRequestException("Invalid cursor");
      start = idx + 1;
    }

    const items = notes.slice(start, start + limit);
    const hasMore = start + limit < notes.length;
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  }

  @Post("stock-notes")
  async create(
    @CurrentUser() uid: string,
    @Body() body: { sym?: string; name?: string; comment?: string },
  ): Promise<StockNote> {
    const symbol = (body.sym ?? "").toUpperCase().trim();
    const name = (body.name ?? "").trim() || symbol;
    const comment = (body.comment ?? "").trim();
    if (!SYM_RE.test(symbol))
      throw new BadRequestException("sym must be 1-10 chars, A-Z0-9.-");
    if (!comment) throw new BadRequestException("comment is required");

    const now = Timestamp.now();
    const ref = await this.firebase.firestore.collection("stock_comments").add({
      uid,
      sym: symbol,
      name,
      comment,
      createdAt: now,
    });
    return {
      id: ref.id,
      sym: symbol,
      name,
      comment,
      createdAt: now.toDate().toISOString(),
    };
  }

  @Delete("stock-notes/:id")
  async remove(
    @CurrentUser() uid: string,
    @Param("id") id: string,
  ): Promise<{ ok: true }> {
    const ref = this.firebase.firestore.collection("stock_comments").doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException("Note not found");
    if (snap.data()?.uid !== uid) throw new ForbiddenException("Not your note");
    await ref.delete();
    return { ok: true };
  }
}
