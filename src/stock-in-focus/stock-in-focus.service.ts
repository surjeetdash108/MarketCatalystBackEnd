import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";

/**
 * Stock in Focus: the desk's one editorial note a day about a single company,
 * posted from the admin console, shown as the last "What Matters Now" slide and
 * kept in an archive every signed-in user can browse.
 *
 * It is the desk's own writing about what is worth looking at, NOT a
 * recommendation or a pick, and the user-facing surfaces say so.
 *
 * ONE ENTRY PER DAY. The document id IS the New York calendar day
 * (YYYY-MM-DD), so a second post for a day is a conflict (edit it instead), the
 * archive sorts on a single field with no composite index, and "the stock of
 * the day" has exactly one answer. The day is fixed once created: moving an
 * entry to another day is delete + re-post, not an edit.
 *
 * The browser never touches the collection: reads and writes go through here.
 */

export const STOCK_IN_FOCUS_COLLECTION = "stock_in_focus";
export const HEADLINE_MAX = 140;
export const NOTE_MAX = 1200;
export const ARCHIVE_DEFAULT = 30;
export const ARCHIVE_MAX = 400;
/** The slide re-reads the latest entry at most this often per instance. */
const LATEST_TTL_MS = 60_000;

/** Same shape Pulse accepts, so a ticker valid there is valid here. */
const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface StockInFocusEntry {
  /** New York calendar day, YYYY-MM-DD. Also the document id. */
  day: string;
  ticker: string;
  headline: string;
  /** The desk's note. May be empty. */
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface StockInFocusBody {
  day?: unknown;
  ticker?: unknown;
  headline?: unknown;
  note?: unknown;
}

/** YYYY-MM-DD on the New York calendar. */
export function etDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function isRealDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const d = new Date(`${day}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

/**
 * Validates and normalises a create/update body. `partial` (an edit) allows any
 * field to be missing; a create needs a ticker and a headline. Throws a
 * BadRequestException with a sentence the console shows as is.
 */
export function cleanStockInFocusBody(
  body: StockInFocusBody,
  partial: boolean,
  now: Date = new Date(),
): Partial<Pick<StockInFocusEntry, "day" | "ticker" | "headline" | "note">> {
  const out: Partial<Pick<StockInFocusEntry, "day" | "ticker" | "headline" | "note">> = {};

  if (body.ticker !== undefined || !partial) {
    const t =
      typeof body.ticker === "string"
        ? body.ticker.trim().replace(/^\$/, "").toUpperCase()
        : "";
    if (!t) throw new BadRequestException("Pick the stock this note is about.");
    if (!TICKER_RE.test(t)) throw new BadRequestException("That ticker isn't valid.");
    out.ticker = t;
  }

  if (body.headline !== undefined || !partial) {
    const h = typeof body.headline === "string" ? body.headline.replace(/\s+/g, " ").trim() : "";
    if (!h) throw new BadRequestException("Write a headline.");
    if (h.length > HEADLINE_MAX)
      throw new BadRequestException(`The headline is limited to ${HEADLINE_MAX} characters.`);
    out.headline = h;
  }

  if (body.note !== undefined || !partial) {
    const n = typeof body.note === "string" ? body.note.trim() : "";
    if (n.length > NOTE_MAX)
      throw new BadRequestException(`The note is limited to ${NOTE_MAX} characters.`);
    out.note = n;
  }

  if (body.day !== undefined && body.day !== null && body.day !== "") {
    const day = typeof body.day === "string" ? body.day.trim() : "";
    if (!isRealDay(day)) throw new BadRequestException("That date isn't valid.");
    // A future day would sit hidden and then surface on its own: the desk posts
    // for today or backfills, it does not schedule.
    if (day > etDay(now)) throw new BadRequestException("The date can't be in the future.");
    out.day = day;
  }

  return out;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function toEntry(day: string, d: Record<string, unknown>): StockInFocusEntry {
  const createdAt = str(d.createdAt);
  return {
    day,
    ticker: str(d.ticker),
    headline: str(d.headline),
    note: str(d.note),
    createdAt,
    updatedAt: str(d.updatedAt) || createdAt,
  };
}

@Injectable()
export class StockInFocusService {
  private latestCache: { at: number; value: StockInFocusEntry | null } | null = null;

  constructor(private readonly firebase: FirebaseAdminService) {}

  private get col() {
    return this.firebase.firestore.collection(STOCK_IN_FOCUS_COLLECTION);
  }

  /** Newest day first. */
  async list(limit = ARCHIVE_DEFAULT): Promise<StockInFocusEntry[]> {
    const n = Math.min(Math.max(Math.floor(limit) || ARCHIVE_DEFAULT, 1), ARCHIVE_MAX);
    const snap = await this.col.orderBy("day", "desc").limit(n).get();
    return snap.docs.map((d) => toEntry(d.id, d.data()));
  }

  /**
   * The newest entry, or null. Cached briefly per instance (the carousel asks on
   * every dashboard load) and dropped on any write here. A write on ANOTHER
   * instance is only seen when the TTL runs out, which is why the TTL is short.
   */
  async latest(now = Date.now()): Promise<StockInFocusEntry | null> {
    if (this.latestCache && now - this.latestCache.at < LATEST_TTL_MS) return this.latestCache.value;
    const [first] = await this.list(1);
    this.latestCache = { at: now, value: first ?? null };
    return this.latestCache.value;
  }

  private invalidate(): void {
    this.latestCache = null;
  }

  /** `day` defaults to today (New York). One entry per day: a second one is a conflict. */
  async create(body: StockInFocusBody, now = new Date()): Promise<StockInFocusEntry> {
    const clean = cleanStockInFocusBody(body, false, now);
    const day = clean.day ?? etDay(now);
    const ref = this.col.doc(day);
    if ((await ref.get()).exists) {
      throw new ConflictException(
        "There is already a Stock in Focus for that day. Edit it, or delete it first.",
      );
    }
    const at = now.toISOString();
    // `day` is ALSO a field, not only the id: the archive orders on it, and
    // Firestore leaves a document out of an orderBy on a field it does not have.
    const doc = {
      day,
      ticker: clean.ticker as string,
      headline: clean.headline as string,
      note: clean.note ?? "",
      createdAt: at,
      updatedAt: at,
    };
    await ref.set(doc);
    this.invalidate();
    return toEntry(day, doc);
  }

  /** Edits keep the day and the original post time. */
  async update(day: string, body: StockInFocusBody, now = new Date()): Promise<StockInFocusEntry> {
    if (!isRealDay(day)) throw new NotFoundException("Entry not found.");
    const ref = this.col.doc(day);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException("Entry not found.");
    const { day: newDay, ...clean } = cleanStockInFocusBody(body, true, now);
    if (newDay !== undefined && newDay !== day) {
      throw new BadRequestException(
        "An entry can't move to another day. Delete it and post it again for that day.",
      );
    }
    const patch = { ...clean, updatedAt: now.toISOString() };
    await ref.update(patch);
    this.invalidate();
    return toEntry(day, { ...snap.data(), ...patch });
  }

  async remove(day: string): Promise<{ ok: true }> {
    if (!isRealDay(day)) throw new NotFoundException("Entry not found.");
    const ref = this.col.doc(day);
    if (!(await ref.get()).exists) throw new NotFoundException("Entry not found.");
    await ref.delete();
    this.invalidate();
    return { ok: true };
  }
}
