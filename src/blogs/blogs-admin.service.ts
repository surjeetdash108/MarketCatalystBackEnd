import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { marked } from "marked";
import TurndownService from "turndown";
import { randomUUID } from "crypto";
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
export type Zone = "edu" | "recap" | "research";

/** The three canonical blog types (see BlogType in the website data layer). */
type BlogType = "educational" | "recap" | "research";

/** zone → canonical type (what gets stored). */
const ZONE_TO_TYPE: Record<Zone, BlogType> = {
  edu: "educational",
  recap: "recap",
  research: "research",
};

/** canonical type → zone (what the GET view reports). */
const TYPE_TO_ZONE: Record<BlogType, Zone> = {
  educational: "edu",
  recap: "recap",
  research: "research",
};

/** Source-document kinds the post page can draw. */
export type SourceKind = "pdf" | "docx";

/**
 * How a post's body is authored, and therefore how the reader's page renders it.
 *
 * SEPARATE from `type`, which is the board zone (educational | recap | research)
 * and decides WHERE a post appears, not what it is. The two were nearly
 * conflated; keeping them apart means the existing posts need no migration.
 *
 *  "pdf" / "doc" — a source document is the article; the page draws the file.
 *  "html"        — authored markup, rendered with its own saved CSS.
 *  "text"        — prose/markdown, rendered with the site's own styling.
 */
export type BlogFormat = "html" | "text" | "pdf" | "doc";

const BLOG_FORMATS = new Set<BlogFormat>(["html", "text", "pdf", "doc"]);

/**
 * Pulls <style> blocks out of authored HTML into their own field.
 *
 * The body is sanitised before storage and `style` is not an allowed tag, so
 * CSS left inline would simply be deleted and the post would render unstyled.
 * Extracting it first keeps the design, and keeps it somewhere the reader's
 * page can scope before applying — see the Website's scopeCss.
 */
export function extractCss(html: string): { html: string; css: string[] } {
  const css: string[] = [];
  const stripped = html.replace(
    /<style\b[^>]*>([\s\S]*?)<\/style>/gi,
    (_m, body: string) => {
      const t = String(body).trim();
      if (t) css.push(t);
      return "";
    },
  );
  return { html: stripped, css };
}

/**
 * Accepted upload types, keyed by the MIME the browser puts in the data URI.
 * An allowlist rather than a sniff: this decides what gets written into
 * Storage, so it should only ever admit the two the reader can render.
 */
/**
 * Largest source document accepted, matching the console's own check.
 *
 * Enforced here as well because the console's limit is a courtesy to the admin,
 * not a control: this is the side that decodes the base64 and holds the whole
 * buffer in memory before writing it to Storage. Express caps the JSON body at
 * 32 MB, and base64 inflates a file by 4/3 — 20 MB arrives as ~26.7 MB — so a
 * larger file would be refused by the body parser with a much blunter error.
 */
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

const SOURCE_KINDS: Record<string, { id: SourceKind; ext: string; mime: string }> = {
  "application/pdf": { id: "pdf", ext: "pdf", mime: "application/pdf" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    id: "docx",
    ext: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
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
  /**
   * The source document the post was published from, when there was one.
   *
   * The `pdf*` names predate Word support and now mean "the source document"
   * of whichever kind `sourceKind` names — kept as-is so the posts already in
   * Firestore keep resolving without a migration.
   */
  pdfUrl: string | null;
  pdfName: string | null;
  /** PDF only. Word pagination depends on the renderer, so it is not known here. */
  pdfPages: number | null;
  pdfAspect: number | null;
  /** Absent on posts written before Word support, which were all PDFs. */
  sourceKind: SourceKind | null;
  /** How the body is authored — see BlogFormat. */
  format: BlogFormat;
  /** Stylesheets for an html post, already split out of the body. */
  css: string[];
  /** Hero image shown above the article. */
  heroImageUrl: string | null;
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
  /** Raw source document (PDF or Word) as a data URI — hoisted to Storage on
   *  write, never stored in Firestore (either is far past the 1 MB cap). */
  pdfDataUri?: string;
  pdfName?: string;
  /** Page count and page shape, read from the file at import. The post page
   *  sizes its embed to the WHOLE document from these, so the reader scrolls
   *  the page instead of a small scrolling box. */
  pdfPages?: unknown;
  pdfAspect?: unknown;
  format?: unknown;
  css?: unknown;
  heroImageUrl?: unknown;
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

  /**
   * Format, body and stylesheets, resolved together.
   *
   * They are interdependent: only an html post keeps CSS, and only an html post
   * needs it split out of the body. Deciding them in one place stops create and
   * update drifting apart on a rule that has to hold for both.
   */
  private resolveFormat(body: BlogAdminBody, html: string): {
    format: BlogFormat;
    html: string;
    css: string[];
  } {
    /* A document names its own format, from the media type in the data URI —
       "pdf" for everything with a file attached would label a Word import as a
       PDF, and the console would then open it in the wrong editor. */
    const fromDoc =
      typeof body.pdfDataUri === "string" && body.pdfDataUri
        ? SOURCE_KINDS[body.pdfDataUri.slice(5, body.pdfDataUri.indexOf(";"))]?.id === "docx"
          ? "doc"
          : "pdf"
        : null;
    const format: BlogFormat = BLOG_FORMATS.has(body.format as BlogFormat)
      ? (body.format as BlogFormat)
      : (fromDoc ?? "text");
    if (format !== "html") return { format, html, css: [] };

    // Stylesheets sent by the client, plus any still embedded in the body.
    const sent = Array.isArray(body.css)
      ? (body.css as unknown[]).filter((c): c is string => typeof c === "string" && !!c.trim())
      : [];
    const pulled = extractCss(html);
    return { format, html: pulled.html, css: [...sent, ...pulled.css] };
  }

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

  /**
   * Stores the source PDF in Storage and returns its download URL.
   *
   * A research PDF is the DESIGNED artifact — its tables, KPI cards and layout
   * exist only in the file. The console's importer reads the text with pdf.js
   * and groups it by Y position, which emits one <p> per visual line: a table
   * row collapses into a paragraph and a wrapped cell into the next one, so the
   * structure cannot survive. Keeping the original alongside the extracted text
   * is what lets the reader see the document as published while the text stays
   * available for search engines and previews.
   *
   * Same tokenised-URL pattern as externalizeImages below.
   */
  private async storeSourceDoc(
    dataUri: string,
    blogId: string,
  ): Promise<{ url: string; kind: SourceKind } | null> {
    const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUri.trim());
    if (!m) return null;
    const kind = SOURCE_KINDS[m[1].toLowerCase()];
    // An unrecognised type is dropped rather than stored: the post page only
    // knows how to draw these two, and a file it cannot render would leave the
    // article blank with no indication why.
    if (!kind) return null;

    const buf = Buffer.from(m[2], "base64");
    if (buf.byteLength > MAX_SOURCE_BYTES) {
      throw new Error(
        `source_too_large: ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB exceeds the ` +
          `${MAX_SOURCE_BYTES / 1024 / 1024} MB limit`,
      );
    }
    const token = randomUUID();
    const path = `blog-docs/${blogId}/${randomUUID()}.${kind.ext}`;
    try {
      await this.firebase.bucket.file(path).save(buf, {
        contentType: kind.mime,
        metadata: {
          // inline so a browser renders it rather than forcing a download —
          // the post page reads this URL directly.
          contentDisposition: "inline",
          metadata: { firebaseStorageDownloadTokens: token },
        },
        resumable: false,
      });
    } catch (err) {
      throw new Error(`source_upload_failed: ${path}: ${(err as Error).message}`);
    }
    return {
      url: `https://firebasestorage.googleapis.com/v0/b/market-catalyst-502415.firebasestorage.app/o/${encodeURIComponent(
        path,
      )}?alt=media&token=${token}`,
      kind: kind.id,
    };
  }

  /**
   * Firestore caps a single document at 1 MB. The console embeds uploaded
   * images as base64 `data:` URIs inside the blog `content`, so an image-heavy
   * post (a 9 MB Word doc becomes ~3.1 MB of content) exceeds that cap and the
   * write throws. This extracts every embedded image, uploads it to Firebase
   * Storage under `blog-images/{blogId}/`, and rewrites each data URI to a
   * public download URL — leaving `content` as just text + URLs, safely under
   * 1 MB, with no ceiling on image size.
   */
  private async externalizeImages(
    content: string,
    blogId: string,
  ): Promise<string> {
    if (!content) return content;

    // data:image/<subtype>;base64,<base64data>
    const re = /data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)/g;

    const matches = [...content.matchAll(re)];
    if (matches.length === 0) return content;

    const replacements = await Promise.all(
      matches.map(async (m, i) => {
        const dataUri = m[0];
        const subtype = m[1];
        const base64 = m[2];
        const ext =
          subtype === "jpeg"
            ? "jpg"
            : subtype === "svg+xml"
              ? "svg"
              : subtype;
        const buf = Buffer.from(base64, "base64");
        const token = randomUUID();
        const path = `blog-images/${blogId}/${i}-${randomUUID()}.${ext}`;
        try {
          await this.firebase.bucket.file(path).save(buf, {
            contentType: `image/${subtype}`,
            metadata: {
              metadata: { firebaseStorageDownloadTokens: token },
            },
            resumable: false,
          });
        } catch (err) {
          throw new Error(
            `image_upload_failed: ${path}: ${(err as Error).message}`,
          );
        }
        const url = `https://firebasestorage.googleapis.com/v0/b/market-catalyst-502415.firebasestorage.app/o/${encodeURIComponent(
          path,
        )}?alt=media&token=${token}`;
        return { dataUri, url };
      }),
    );

    let out = content;
    for (const { dataUri, url } of replacements) {
      // Replace this exact data URI occurrence. split/join replaces every
      // identical copy (duplicated images share one upload's URL — fine).
      out = out.split(dataUri).join(url);
    }
    return out;
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
    // An html post already stores HTML; every other format stores Markdown.
    // Running the Markdown parser over authored markup does not leave it alone
    // — a block indented four spaces becomes a code block, and text between
    // tags gets wrapped in paragraphs — so the console would load back a
    // mangled copy of the document and re-save it.
    const storedFormat = BLOG_FORMATS.has(data.format as BlogFormat)
      ? (data.format as BlogFormat)
      : typeof data.pdfUrl === "string"
        ? data.sourceKind === "docx" ? "doc" : "pdf"
        : "text";
    const type = (data.type as BlogType) ?? "educational";
    const zone = TYPE_TO_ZONE[type] ?? "edu";
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
      html:
        storedFormat === "html"
          ? (data.content ?? "")
          : this.markdownToHtml(data.content ?? ""),
      status: data.status === "published" ? "Published" : "Draft",
      date: this.formatDate(data.publishedAt),
      pdfUrl: typeof data.pdfUrl === "string" ? data.pdfUrl : null,
      pdfName: typeof data.pdfName === "string" ? data.pdfName : null,
      pdfPages: typeof data.pdfPages === "number" ? data.pdfPages : null,
      pdfAspect: typeof data.pdfAspect === "number" ? data.pdfAspect : null,
      // Every post written before Word support was a PDF, so an absent kind on
      // a post that HAS a source document means pdf; absent with no document
      // means there is nothing to draw.
      sourceKind:
        data.sourceKind === "docx" || data.sourceKind === "pdf"
          ? data.sourceKind
          : typeof data.pdfUrl === "string"
            ? "pdf"
            : null,
      // Posts written before formats existed carry none. A stored source
      // document tells us what they are; anything else is prose, which is what
      // `content` has always held.
      format: storedFormat,
      css: Array.isArray(data.css)
        ? (data.css as unknown[]).filter((c): c is string => typeof c === "string")
        : [],
      heroImageUrl: typeof data.coverImageUrl === "string" ? data.coverImageUrl : null,
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

    // An html post stores its markup AS WRITTEN. Running it through turndown —
    // which is right for every other format, because `content` is Markdown —
    // would flatten exactly the structure the author chose the format for.
    // Either way, embedded base64 images are hoisted to Storage so the stored
    // content never carries a data URI (Firestore's 1 MB cap).
    const resolved = this.resolveFormat(body, typeof body.html === "string" ? body.html : "");
    const content = await this.externalizeImages(
      resolved.format === "html" ? resolved.html : this.htmlToMarkdown(resolved.html),
      ref.id,
    );

    const source = typeof body.pdfDataUri === "string" && body.pdfDataUri
      ? await this.storeSourceDoc(body.pdfDataUri, ref.id)
      : null;
    const pdfUrl = source?.url ?? null;

    await ref.set({
      title,
      slug,
      excerpt: typeof body.dek === "string" ? body.dek : "",
      content,
      status: published ? "published" : "draft",
      type,
      rank: rank ?? 999,
      authorId: "console-admin",
      editorId: "console-admin",
      categories: kick ? [kick] : [],
      tags: [],
      coverImageUrl:
        typeof body.heroImageUrl === "string" && body.heroImageUrl.trim()
          ? body.heroImageUrl.trim()
          : null,
      format: resolved.format,
      css: resolved.css,
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
      // Source PDF, when the article was published from one.
      pdfUrl,
      pdfName: pdfUrl && typeof body.pdfName === "string" ? body.pdfName : null,
      pdfPages: pdfUrl && Number.isFinite(Number(body.pdfPages)) ? Number(body.pdfPages) : null,
      pdfAspect: pdfUrl && Number.isFinite(Number(body.pdfAspect)) ? Number(body.pdfAspect) : null,
      sourceKind: source?.kind ?? null,
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
    if (body.html !== undefined || body.format !== undefined || body.css !== undefined) {
      // Same rule as create: html keeps its markup, everything else becomes
      // Markdown. Resolved together because the format decides both.
      const r = this.resolveFormat(body, String(body.html ?? ""));
      update.format = r.format;
      update.css = r.css;
      if (body.html !== undefined) {
        update.content = await this.externalizeImages(
          r.format === "html" ? r.html : this.htmlToMarkdown(r.html),
          id,
        );
      }
    }
    if (body.heroImageUrl !== undefined) {
      update.coverImageUrl =
        typeof body.heroImageUrl === "string" && body.heroImageUrl.trim()
          ? body.heroImageUrl.trim()
          : null;
    }
    if (body.kick !== undefined) {
      const kick = String(body.kick ?? "");
      update.categories = kick ? [kick] : [];
      update.kicker = kick;
    }
    if (typeof body.pdfDataUri === "string" && body.pdfDataUri) {
      const source = await this.storeSourceDoc(body.pdfDataUri, id);
      if (source) {
        update.pdfUrl = source.url;
        update.sourceKind = source.kind;
        update.pdfName = typeof body.pdfName === "string" ? body.pdfName : null;
        // Word has no page count until something renders it, so these stay
        // null there rather than carrying a stale PDF's numbers forward.
        update.pdfPages = Number.isFinite(Number(body.pdfPages)) ? Number(body.pdfPages) : null;
        update.pdfAspect = Number.isFinite(Number(body.pdfAspect)) ? Number(body.pdfAspect) : null;
      }
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
    // Remove this post's uploaded files (best-effort). The source document was
    // previously left behind on delete — a leak worth closing now that a Word
    // upload can be tens of megabytes. `blog-pdfs/` is the pre-rename location
    // and is still swept so older posts clean up too.
    await Promise.all(
      [`blog-images/${id}/`, `blog-docs/${id}/`, `blog-pdfs/${id}/`].map((prefix) =>
        this.firebase.bucket.deleteFiles({ prefix }).catch(() => undefined),
      ),
    );
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
