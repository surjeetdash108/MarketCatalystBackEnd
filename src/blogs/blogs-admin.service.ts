import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { marked } from "marked";
import TurndownService from "turndown";
import { FirebaseAdminService } from "../common/firebase-admin.provider";

/**
 * Admin CRUD over the SAME Firestore `blogs` collection the public website
 * renders from (../MarketCatalystWebsite/lib/blog/posts.ts is the owner of the
 * canonical doc shape). Every write here produces a doc that
 * getPublishedPosts()/BlogBoard read unchanged.
 *
 * The console's editor speaks a different vocabulary ("zone", "dek", "kick",
 * "html", capitalised status, a "Mon D" date). This service is the translation
 * layer between that console shape and the canonical post shape — including the
 * HTML↔Markdown conversion, since the console edits HTML but the canonical
 * `content` field is Markdown.
 */

const POSTS = "blogs";
const SLUGS = "slugs";

/** The four zones the console understands. */
export type Zone = "lead" | "stock" | "edu" | "news";

/** The four canonical blog types (see BlogType in the website data layer). */
type BlogType = "featured" | "stock" | "educational" | "market";

/** zone → canonical type (what gets stored). */
const ZONE_TO_TYPE: Record<Zone, BlogType> = {
  lead: "featured",
  stock: "stock",
  edu: "educational",
  news: "market",
};

/** canonical type → zone (what the GET view reports). */
const TYPE_TO_ZONE: Record<BlogType, Zone> = {
  featured: "lead",
  stock: "stock",
  educational: "edu",
  market: "news",
};

/** The shape the console's editor consumes. */
export interface BlogAdminView {
  id: string;
  zone: Zone;
  rank: number;
  kick: string;
  title: string;
  dek: string;
  author: string;
  read: string;
  html: string;
  status: "Published" | "Draft";
  date: string;
}

/** Request body for POST/PATCH — every field optional at the wire, validated below. */
export interface BlogAdminBody {
  zone?: string;
  rank?: unknown;
  kick?: string;
  title?: string;
  dek?: string;
  author?: string;
  read?: string;
  html?: string;
  status?: string;
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

@Injectable()
export class BlogsAdminService {
  private readonly logger = new Logger(BlogsAdminService.name);
  private readonly turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });

  constructor(private readonly firebase: FirebaseAdminService) {}

  private get col() {
    return this.firebase.firestore.collection(POSTS);
  }

  // ── conversions ──────────────────────────────────────────────────────────

  /** Canonical Markdown `content` → HTML, for the console editor to load. */
  private markdownToHtml(markdown: string): string {
    if (!markdown) return "";
    // marked is synchronous by default; force it so the return is a string.
    return marked.parse(markdown, { async: false }) as string;
  }

  /** Console editor HTML → canonical Markdown `content`, for writes. */
  private htmlToMarkdown(html: string): string {
    if (!html) return "";
    return this.turndown.turndown(html);
  }

  private formatDate(ts: Timestamp | null | undefined): string {
    if (!ts) return "";
    const d = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts as unknown as string);
    if (Number.isNaN(d.getTime())) return "";
    return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }

  private slugify(input: string): string {
    return String(input)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 200);
  }

  /**
   * Firestore has no unique-field constraint. Slugify the title, and if that
   * slug is already used by a different `blogs` doc, append -2, -3, … until a
   * free one is found. A `slugs/{slug}` index doc is claimed on create (and
   * released on delete) so the website's own admin (which enforces uniqueness
   * through that same index) stays consistent with what we write.
   */
  private async generateUniqueSlug(title: string): Promise<string> {
    const base = this.slugify(title) || "post";
    let candidate = base;
    let n = 2;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const snap = await this.col.where("slug", "==", candidate).limit(1).get();
      if (snap.empty) return candidate;
      candidate = `${base}-${n}`;
      n += 1;
    }
  }

  // ── validation ───────────────────────────────────────────────────────────

  private validateZone(zone: unknown, required: boolean): Zone | undefined {
    if (zone === undefined || zone === null || zone === "") {
      if (required) throw new BadRequestException("zone is required");
      return undefined;
    }
    if (typeof zone !== "string" || !(zone in ZONE_TO_TYPE)) {
      throw new BadRequestException(
        `zone must be one of: ${Object.keys(ZONE_TO_TYPE).join(", ")}`,
      );
    }
    return zone as Zone;
  }

  private validateTitle(title: unknown, required: boolean): string | undefined {
    if (title === undefined) {
      if (required) throw new BadRequestException("title is required");
      return undefined;
    }
    if (typeof title !== "string" || title.trim() === "") {
      throw new BadRequestException("title is required");
    }
    return title.trim();
  }

  /** Returns a numeric rank, or undefined when not provided. Non-numeric → 400. */
  private validateRank(rank: unknown): number | undefined {
    if (rank === undefined || rank === null || rank === "") return undefined;
    const n = Number(rank);
    if (!Number.isFinite(n)) {
      throw new BadRequestException("rank must be numeric");
    }
    return n;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** ALL blogs (any status), newest first, mapped to the console editor shape. */
  async list(): Promise<BlogAdminView[]> {
    const snap = await this.col.get();
    const rows = snap.docs.map((doc) => {
      const data = doc.data();
      const createdMs =
        data.createdAt instanceof Timestamp ? data.createdAt.toMillis() : 0;
      return { view: this.toView(doc.id, data), sortKey: createdMs };
    });
    // Sort in memory (not via orderBy, which would silently drop docs missing
    // the field) — newest created first.
    rows.sort((a, b) => b.sortKey - a.sortKey);
    return rows.map((r) => r.view);
  }

  private toView(id: string, data: FirebaseFirestore.DocumentData): BlogAdminView {
    const type = (data.type as BlogType) ?? "featured";
    const zone = TYPE_TO_ZONE[type] ?? "lead";
    const categories: string[] = Array.isArray(data.categories)
      ? data.categories
      : [];
    return {
      id,
      zone,
      rank: typeof data.rank === "number" ? data.rank : 999,
      kick: categories[0] ?? "",
      title: data.title ?? "",
      dek: data.excerpt ?? "",
      author: data.author ?? "",
      read: data.read ?? "",
      html: this.markdownToHtml(data.content ?? ""),
      status: data.status === "published" ? "Published" : "Draft",
      date: this.formatDate(data.publishedAt),
    };
  }

  // ── writes ───────────────────────────────────────────────────────────────

  async create(body: BlogAdminBody): Promise<{ id: string }> {
    const title = this.validateTitle(body.title, true)!;
    const zone = this.validateZone(body.zone, true)!;
    const rank = this.validateRank(body.rank);

    const type = ZONE_TO_TYPE[zone];
    const kick = typeof body.kick === "string" ? body.kick : "";
    const published = String(body.status ?? "").toLowerCase() === "published";
    const now = FieldValue.serverTimestamp();

    const ref = this.col.doc();
    const slug = await this.generateUniqueSlug(title);

    await ref.set({
      title,
      slug,
      excerpt: typeof body.dek === "string" ? body.dek : "",
      content: this.htmlToMarkdown(typeof body.html === "string" ? body.html : ""),
      status: published ? "published" : "draft",
      type,
      rank: rank ?? 999,
      authorId: "console-admin",
      editorId: "console-admin",
      categories: kick ? [kick] : [],
      tags: [],
      coverImageUrl: null,
      seo: {
        metaTitle: null,
        metaDescription: null,
        ogImageUrl: null,
        canonicalUrl: null,
      },
      publishedAt: published ? now : null,
      createdAt: now,
      updatedAt: now,
      // Console-only extras — the website's reader ignores unknown fields.
      author: typeof body.author === "string" ? body.author : "",
      kicker: kick,
      read: typeof body.read === "string" ? body.read : "",
    });

    // Claim the slug index doc so the website's admin uniqueness check agrees.
    await this.firebase.firestore
      .collection(SLUGS)
      .doc(slug)
      .set({ postId: ref.id });

    return { id: ref.id };
  }

  async update(id: string, body: BlogAdminBody): Promise<{ id: string }> {
    const ref = this.col.doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException("blog not found");
    const existing = snap.data()!;

    // Validate any provided fields (partial update — all optional here).
    const title = this.validateTitle(body.title, false);
    const zone = this.validateZone(body.zone, false);
    const rank = this.validateRank(body.rank);

    const update: Record<string, unknown> = {
      editorId: "console-admin",
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (title !== undefined) update.title = title;
    if (zone !== undefined) update.type = ZONE_TO_TYPE[zone];
    if (rank !== undefined) update.rank = rank;
    if (body.dek !== undefined) update.excerpt = String(body.dek ?? "");
    if (body.html !== undefined) {
      update.content = this.htmlToMarkdown(String(body.html ?? ""));
    }
    if (body.kick !== undefined) {
      const kick = String(body.kick ?? "");
      update.categories = kick ? [kick] : [];
      update.kicker = kick;
    }
    if (body.author !== undefined) update.author = String(body.author ?? "");
    if (body.read !== undefined) update.read = String(body.read ?? "");

    if (body.status !== undefined) {
      const published = String(body.status).toLowerCase() === "published";
      update.status = published ? "published" : "draft";
      // publishedAt is set once, on the first transition to published.
      if (published && !existing.publishedAt) {
        update.publishedAt = FieldValue.serverTimestamp();
      }
    }

    await ref.update(update);
    return { id };
  }

  async remove(id: string): Promise<{ id: string }> {
    const ref = this.col.doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException("blog not found");
    const slug = snap.data()?.slug as string | undefined;

    await ref.delete();
    // Release the slug index doc so the slug can be reused.
    if (slug) {
      await this.firebase.firestore
        .collection(SLUGS)
        .doc(slug)
        .delete()
        .catch(() => undefined);
    }
    return { id };
  }
}
