import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { FirebaseAdminService } from "../common/firebase-admin.provider";

/**
 * Market Catalyst Pulse: short posts the admin writes from the console
 * (/admin/blogs → Market Catalyst Pulse), shown on every user's dashboard,
 * newest first. One Firestore collection, `pulse_posts`; the browser never
 * touches it — reads and writes go through this service.
 */

export const PULSE_COLLECTION = "pulse_posts";
/** How many posts the dashboard card shows (newest first). */
export const PULSE_LIMIT = 50;
export const PULSE_TEXT_MAX = 500;
/** How far back a search looks (newest first). */
export const PULSE_SEARCH_SCAN = 500;
export const DEFAULT_NAME = "MarketCatalyst";
export const DEFAULT_HANDLE = "MarketCatalyst";

export interface PulsePost {
  id: string;
  text: string;
  /** Optional ticker tag (upper case), e.g. "NVDA". */
  ticker: string | null;
  name: string;
  handle: string;
  /** ISO time the post was published. */
  createdAt: string;
  updatedAt: string;
}

export interface PulseBody {
  text?: unknown;
  ticker?: unknown;
  name?: unknown;
  handle?: unknown;
}

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const HANDLE_RE = /^[A-Za-z0-9_]{1,30}$/;

/** Validates and normalises a create/update body. `partial` allows missing fields. */
export function cleanPulseBody(
  body: PulseBody,
  partial: boolean,
  maxText: number = PULSE_TEXT_MAX,
): Partial<Omit<PulsePost, "id" | "createdAt" | "updatedAt">> {
  const out: Partial<Omit<PulsePost, "id" | "createdAt" | "updatedAt">> = {};
  if (body.text !== undefined || !partial) {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw new BadRequestException("Write something to post.");
    if (text.length > maxText)
      throw new BadRequestException(
        `Posts are limited to ${maxText} characters.`,
      );
    out.text = text;
  }
  if (body.ticker !== undefined || !partial) {
    const raw =
      typeof body.ticker === "string"
        ? body.ticker.trim().replace(/^\$/, "").toUpperCase()
        : "";
    if (raw && !TICKER_RE.test(raw))
      throw new BadRequestException("That ticker isn't valid.");
    out.ticker = raw || null;
  }
  if (body.name !== undefined || !partial) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length > 40)
      throw new BadRequestException("Name is limited to 40 characters.");
    out.name = name || DEFAULT_NAME;
  }
  if (body.handle !== undefined || !partial) {
    const handle =
      typeof body.handle === "string"
        ? body.handle.trim().replace(/^@/, "")
        : "";
    if (handle && !HANDLE_RE.test(handle))
      throw new BadRequestException(
        "Handle: letters, numbers and _ only (up to 30).",
      );
    out.handle = handle || DEFAULT_HANDLE;
  }
  return out;
}

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" && v ? v : fallback;

function toPost(id: string, d: Record<string, unknown>): PulsePost {
  const createdAt = str(d.createdAt);
  return {
    id,
    text: str(d.text),
    ticker: str(d.ticker) || null,
    name: str(d.name, DEFAULT_NAME),
    handle: str(d.handle, DEFAULT_HANDLE),
    createdAt,
    updatedAt: str(d.updatedAt, createdAt),
  };
}

@Injectable()
export class PulseService {
  constructor(private readonly firebase: FirebaseAdminService) {}

  private get col() {
    return this.firebase.firestore.collection(PULSE_COLLECTION);
  }

  /** Newest first. */
  async list(limit = PULSE_LIMIT): Promise<PulsePost[]> {
    const snap = await this.col.orderBy("createdAt", "desc").limit(limit).get();
    return snap.docs.map((d) => toPost(d.id, d.data()));
  }

  /**
   * Posts matching every word of `q` in the text or ticker ("$NVDA" or
   * "nvda"), newest first (cards no longer show the name or handle), from the last PULSE_SEARCH_SCAN
   * posts. Firestore has no text search and the collection is small, so this
   * filters in memory. An empty query is the plain list.
   */
  async search(q: string, limit = PULSE_LIMIT): Promise<PulsePost[]> {
    const words = q
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/^[$@#]+/, "").trim())
      .filter(Boolean)
      .slice(0, 8);
    if (words.length === 0) return this.list(limit);
    const posts = await this.list(PULSE_SEARCH_SCAN);
    return posts
      .filter((p) => {
        const hay =
          `${p.text} ${p.ticker ?? ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .slice(0, limit);
  }

  /** `unlimited` drops the 500-character cap (admin Content pipeline posts). */
  async create(
    body: PulseBody,
    now = new Date(),
    opts: { unlimited?: boolean } = {},
  ): Promise<PulsePost> {
    const clean = cleanPulseBody(
      body,
      false,
      opts.unlimited ? Infinity : PULSE_TEXT_MAX,
    );
    const id = randomUUID();
    const at = now.toISOString();
    const doc = { ...clean, createdAt: at, updatedAt: at };
    await this.col.doc(id).set(doc);
    return toPost(id, doc);
  }

  /** Edits keep the original publish time, so a post never jumps to the top. */
  async update(
    id: string,
    body: PulseBody,
    now = new Date(),
    opts: { unlimited?: boolean } = {},
  ): Promise<PulsePost> {
    const ref = this.col.doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException("Post not found.");
    const clean = cleanPulseBody(body, true, opts.unlimited ? Infinity : PULSE_TEXT_MAX);
    const patch = { ...clean, updatedAt: now.toISOString() };
    await ref.update(patch);
    return toPost(id, { ...snap.data(), ...patch });
  }

  async remove(id: string): Promise<{ ok: true }> {
    const ref = this.col.doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException("Post not found.");
    await ref.delete();
    return { ok: true };
  }
}
