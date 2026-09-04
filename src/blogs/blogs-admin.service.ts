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

/**
 * The blog's shared look, in one document.
 *
 * Every authored post is written against the same stylesheet, so keeping a copy
 * on each post meant N copies of one design: a change had to be re-uploaded to
 * every post, and two posts could silently disagree about what the site looks
 * like. One document, last upload wins.
 *
 * It also holds the external stylesheets and scripts the design references.
 * Those are RECORDED here, not trusted — the reader's page decides what it is
 * willing to load, and the site's CSP has the final say.
 */
const THEME = "blog_theme";
const THEME_DOC = "current";

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

/** The shared design, lifted out of an authored document. */
export interface BlogTheme {
  /** Every <style> block, in document order. */
  css: string[];
  /** Stylesheet URLs the document linked to. */
  links: string[];
  /** Script URLs the document loaded. */
  scripts: string[];
  /** Inline <script> bodies. Recorded, never executed — see the reader's page. */
  inlineScripts: string[];
}

/**
 * Splits an authored document into the part that belongs to THIS post and the
 * part that belongs to every post.
 *
 * The admin writes one complete page, but only its <body> is about this
 * article. The <style>, the fonts and the framework it loads are the site's
 * blog design, and every later post is written against the same one — so they
 * are lifted out here and stored once (see THEME), not copied onto each post.
 *
 * The body is also reduced to its own contents: keeping <html>/<head> would
 * publish the document title and meta tags as loose text on the page, because
 * the sanitizer drops the tags and keeps what is inside them.
 */
export function extractTheme(input: string): { html: string; theme: BlogTheme } {
  const theme: BlogTheme = { css: [], links: [], scripts: [], inlineScripts: [] };
  let html = input;

  html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, body: string) => {
    const t = String(body).trim();
    if (t) theme.css.push(t);
    return "";
  });

  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_m, attrs: string, body: string) => {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(String(attrs));
    if (src) theme.scripts.push(src[1]);
    else {
      const t = String(body).trim();
      if (t) theme.inlineScripts.push(t);
    }
    return "";
  });

  html = html.replace(/<link\b([^>]*)>/gi, (_m, attrs: string) => {
    const a = String(attrs);
    // preconnect/dns-prefetch point at a host, not a stylesheet — recording
    // them would put bare origins in the list the reader's page reads.
    if (/rel\s*=\s*["']?stylesheet/i.test(a)) {
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(a);
      if (href) theme.links.push(href[1]);
    }
    return "";
  });

  // Only the body is this post. A document with no <body> is already a fragment.
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  if (body) html = body[1];
  else html = html.replace(/<\/?(?:html|head)\b[^>]*>/gi, "");

  return { html: html.trim(), theme };
}

/**
 * Puts an html post back together: the body it stores, wrapped in the design it
 * publishes with.
 *
 * The inverse of extractTheme, and the reason it exists: a saved post keeps
 * ONLY its <body>, because the design belongs to every post and is stored once.
 * Read back as-is, the console's source box showed a bare fragment of the file
 * that was uploaded — the <style>, the fonts and the scripts simply gone — so
 * the editor disagreed with both the file and the preview it had just shown.
 *
 * Not a byte-for-byte copy of the uploaded file: <title> and <meta> are not
 * stored (extractTheme drops them so they cannot publish as loose text), and
 * whitespace between the head elements is regenerated. It IS the whole
 * publishable document — everything that decides how the article renders.
 *
 * Stable across a re-save: feeding this back through extractTheme yields the
 * same body and the same theme, so opening a post and saving it unchanged
 * writes it unchanged.
 *
 * A post whose design was never captured stays a bare fragment rather than
 * gaining an empty shell — that is what the editor sent, and what it expects
 * to get back.
 */
export function composeDocument(body: string, theme: BlogTheme): string {
  const head = [
    ...theme.links.map((href) => `<link rel="stylesheet" href="${href}">`),
    ...theme.css.map((css) => `<style>
${css}
</style>`),
    ...theme.scripts.map((src) => `<script src="${src}"></script>`),
  ];
  /* Recorded, never executed by the reader — but the admin authored them, so
     they belong in the document the editor shows and re-saves. At the END OF
     THE BODY, not in the head: an inline script in an authored page is there to
     act on the markup above it, and hoisting it into the head would show the
     admin a document that reads as if it ran before its own content existed. */
  const tail = theme.inlineScripts.map((js) => `<script>
${js}
</script>`);
  if (!head.length && !tail.length) return body;
  return `<!doctype html>
<html>
<head>
${head.join("\n")}
</head>
<body>
${body}
${tail.join("\n")}
</body>
</html>`;
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

/**
 * Ceiling for the verbatim document kept on an html post.
 *
 * Firestore caps a document at 1 MB TOTAL, and this field sits alongside the
 * body, the excerpt and the rest. Refused here with a message naming the size,
 * rather than letting the write fail with Firestore's own opaque error after
 * the images have already been uploaded.
 */
const MAX_DOC_HTML_BYTES = 700 * 1024;

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
  /**
   * The body to edit. For an html post this is the WHOLE document — the stored
   * body recomposed with the shared design (see composeDocument) — so the
   * source box shows what was uploaded rather than a fragment of it. Every
   * other format returns HTML converted from the stored Markdown.
   */
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
  /** Hero image shown above the article. */
  heroImageUrl: string | null;
  /**
   * The shared blog design, resolved from THEME and returned with every html
   * post.
   *
   * `html` stores only the post's <body> — extractTheme lifts the <style>, the
   * stylesheet links and the scripts out on write, so a post read back had no
   * design at all and the console previewed a saved article as unstyled markup.
   * The theme was write-only: saveTheme() wrote it and nothing ever read it.
   *
   * Empty for every other format. Prose publishes with the site's own styling,
   * so handing a text post the blog stylesheet would preview it with a design
   * it will never publish with.
   */
  css: string[];
  links: string[];
  scripts: string[];
}

/**
 * The article exactly as its author wrote it, when the post has one.
 *
 * WHY this exists alongside the theme: extractTheme lifts every design into ONE
 * shared document, last upload wins. That is right for a house style, but it
 * means two posts CANNOT have two designs — uploading a second file silently
 * redefines the first post's look — and the head of the file (title, meta,
 * element order) was never stored at all. A post could therefore never be
 * reproduced as uploaded.
 *
 * So an html post now keeps its own document, verbatim, and that is what the
 * editor loads and the reader should draw. The only edit is that embedded
 * base64 images are hoisted to Storage (Firestore's 1 MB cap makes storing them
 * inline impossible) — every byte of markup, CSS and structure is untouched.
 */

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
    theme: BlogTheme | null;
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
    if (format !== "html") return { format, html, theme: null };

    const pulled = extractTheme(html);
    // A document that carried no design at all leaves the stored theme alone —
    // pasting a bare fragment must not wipe the site's blog styling.
    const carries =
      pulled.theme.css.length ||
      pulled.theme.links.length ||
      pulled.theme.scripts.length ||
      pulled.theme.inlineScripts.length;
    return { format, html: pulled.html, theme: carries ? pulled.theme : null };
  }

  /**
   * Stores the shared blog design. Last upload wins, by intent: there is one
   * blog look, and the most recent document defines it.
   */
  private async saveTheme(theme: BlogTheme): Promise<void> {
    try {
      await this.firebase.firestore
        .collection(THEME)
        .doc(THEME_DOC)
        .set({ ...theme, updatedAt: FieldValue.serverTimestamp() }, { merge: false });
    } catch (err) {
      // The post is the thing being published; a theme write failing should not
      // lose it. Logged loudly because every later post inherits this.
      this.logger.error(`blog theme write failed: ${(err as Error).message}`);
    }
  }

  /**
   * Reads the shared design back. The counterpart to saveTheme — without it the
   * theme document is write-only and no reader can reproduce what an html post
   * publishes with.
   *
   * Read ONCE per list() and passed into every row, not per document: it is one
   * document shared by every post, so a per-row read would be N identical
   * Firestore reads for one value.
   */
  private async loadTheme(): Promise<BlogTheme> {
    const empty: BlogTheme = { css: [], links: [], scripts: [], inlineScripts: [] };
    try {
      const snap = await this.firebase.firestore
        .collection(THEME)
        .doc(THEME_DOC)
        .get();
      if (!snap.exists) return empty;
      const d = snap.data() ?? {};
      const arr = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      return {
        css: arr(d.css),
        links: arr(d.links),
        scripts: arr(d.scripts),
        inlineScripts: arr(d.inlineScripts),
      };
    } catch (err) {
      // A missing design must not blank the board: the list is the thing being
      // read, and every row is still valid without it.
      this.logger.error(`blog theme read failed: ${(err as Error).message}`);
      return empty;
    }
  }

  /** The shared design on its own, for the editor's Design row. */
  async theme(): Promise<BlogTheme> {
    return this.loadTheme();
  }

  /**
   * The verbatim document to store for an html post.
   *
   * Only base64 images are rewritten — they cannot live in Firestore — and the
   * rewrite happens on the WHOLE document so an image referenced from the head
   * or from inline CSS is hoisted too, not just those in the body.
   */
  private async prepareDocument(raw: string, blogId: string): Promise<string> {
    const doc = await this.externalizeImages(raw, blogId);
    const bytes = Buffer.byteLength(doc, "utf8");
    if (bytes > MAX_DOC_HTML_BYTES) {
      throw new BadRequestException(
        `document_too_large: the article is ${(bytes / 1024).toFixed(0)} KB, over the ` +
          `${MAX_DOC_HTML_BYTES / 1024} KB limit for a single post. Move large inline ` +
          `data (fonts, base64 media) to a URL.`,
      );
    }
    return doc;
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
  /**
   * A hero image arrives either as a URL someone pasted or as a file the admin
   * picked, which reaches us as a data URI. The second cannot be stored as-is:
   * a real image base64-encoded is far past Firestore's 1 MB document cap, and
   * the post would fail to write.
   *
   * externalizeImages already uploads data URIs and hands back their Storage
   * URL, and leaves anything else untouched — so a pasted URL passes straight
   * through and a picked file is hoisted, by one code path.
   */
  private async resolveHero(value: unknown, blogId: string): Promise<string | null> {
    if (typeof value !== "string" || !value.trim()) return null;
    const resolved = await this.externalizeImages(value.trim(), blogId);
    // A data URI the uploader did not recognise (an unsupported image type)
    // comes back unchanged — storing it would blow the document cap.
    return resolved.startsWith("data:") ? null : resolved;
  }

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

  /**
   * "Aug 29 · 16:05 ET".
   *
   * The stored value has always carried the time — publishedAt is a server
   * timestamp — but this dropped it, so the console could not tell two posts
   * published on the same day apart, which is the ordinary case for a recap
   * plus a research note.
   *
   * Rendered in New York rather than the server's zone: Cloud Run runs in UTC,
   * so a 16:05 close read back as 20:05 and a late-evening post appeared to be
   * on the following day.
   */
  private formatDate(ts: Timestamp | null | undefined): string {
    if (!ts) return "";
    const d = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts as unknown as string);
    if (Number.isNaN(d.getTime())) return "";
    const et = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const at = (t: string) => et.find((p) => p.type === t)?.value ?? "";
    return `${at("month")} ${at("day")} · ${at("hour")}:${at("minute")} ET`;
  }

  /**
   * A written post must arrive complete: headline, summary, hero image.
   *
   * All three are load-bearing on the reader's side — the summary is the
   * standfirst under the headline and the card excerpt on the board, and the
   * hero is both the article image and the board thumbnail. A post missing any
   * of them publishes a visibly broken card, so it is refused here rather than
   * discovered later.
   *
   * Documents are exempt: a PDF or Word post is its own cover and its own
   * opening line.
   */
  private requireAuthoredFields(body: BlogAdminBody): void {
    const format = body.format;
    if (format !== "html" && format !== "text") return;

    const missing: string[] = [];
    if (!String(body.title ?? "").trim()) missing.push("title");
    if (!String(body.dek ?? "").trim()) missing.push("summary");
    const hero = typeof body.heroImageUrl === "string" ? body.heroImageUrl.trim() : "";
    if (!hero) missing.push("hero image");
    if (missing.length) {
      throw new BadRequestException(`missing required field(s): ${missing.join(", ")}`);
    }
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
    // One read for the whole list — the design is a single shared document, so
    // resolving it per row would be N identical reads for one value.
    const [snap, theme] = await Promise.all([this.col.get(), this.loadTheme()]);
    const rows = snap.docs.map((doc) => {
      const data = doc.data();
      const createdMs =
        data.createdAt instanceof Timestamp ? data.createdAt.toMillis() : 0;
      return { view: this.toView(doc.id, data, theme), sortKey: createdMs };
    });
    // Sort in memory (not via orderBy, which would silently drop docs missing
    // the field) — newest created first.
    rows.sort((a, b) => b.sortKey - a.sortKey);
    return rows.map((r) => r.view);
  }

  /**
   * Which stylesheet an html post publishes with.
   *
   * A post stores its own (see create()); one written before that field existed
   * has only the shared theme, and a post whose document carried no <style> at
   * all has neither, which is also the shared theme's case — an authored
   * fragment is written against the house design.
   */
  private designFor(
    data: FirebaseFirestore.DocumentData,
    theme: BlogTheme,
  ): { css: string[]; links: string[]; scripts: string[] } {
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
    const own = arr(data.css);
    if (own.length) {
      return { css: own, links: arr(data.themeLinks), scripts: arr(data.themeScripts) };
    }
    return { css: theme.css, links: theme.links, scripts: theme.scripts };
  }

  private toView(
    id: string,
    data: FirebaseFirestore.DocumentData,
    theme: BlogTheme,
  ): BlogAdminView {
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
    // Resolved once: it decides both what the editor's Design row shows and,
    // for a post with no stored document, what composeDocument rebuilds with.
    const design =
      storedFormat === "html"
        ? this.designFor(data, theme)
        : { css: [], links: [], scripts: [] };
    return {
      id,
      zone,
      rank: typeof data.rank === "number" ? data.rank : 999,
      kick: categories[0] ?? "",
      title: data.title ?? "",
      dek: data.excerpt ?? "",
      author: data.author ?? "",
      read: data.read ?? "",
      // An html post is handed back as the whole document — body plus the
      // design it publishes with — because that is what the editor's source
      // box sent and what its preview renders verbatim. See composeDocument.
      html:
        storedFormat === "html"
          ? // The post's own document when it has one. composeDocument is the
            // fallback for posts written before documents were kept per post:
            // they exist only as a body plus the shared theme, so that is the
            // closest reproduction available for them.
            typeof data.documentHtml === "string" && data.documentHtml
            ? data.documentHtml
            // Rebuilt with the post's OWN design, not the newest upload's —
            // recomposing against the shared theme is why opening an older post
            // showed a different article than the one that was published.
            : composeDocument(data.content ?? "", { ...design, inlineScripts: [] })
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
      heroImageUrl: typeof data.coverImageUrl === "string" ? data.coverImageUrl : null,
      /* The post's OWN design when it has one, and only then the shared theme.
         The shared theme is last-upload-wins, so preferring it here showed the
         console an article drawn with a different post's stylesheet — exactly
         what the reader saw. It stays as the fallback for posts written before
         the design was kept per post; those have nothing else. */
      ...design,
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

    this.requireAuthoredFields(body);

    const ref = this.col.doc();
    const slug = await this.generateUniqueSlug(title);

    // An html post stores its markup AS WRITTEN. Running it through turndown —
    // which is right for every other format, because `content` is Markdown —
    // would flatten exactly the structure the author chose the format for.
    // Either way, embedded base64 images are hoisted to Storage so the stored
    // content never carries a data URI (Firestore's 1 MB cap).
    const rawHtml = typeof body.html === "string" ? body.html : "";
    const resolved = this.resolveFormat(body, rawHtml);
    // Still written: the shared theme is what the site styles its own blog
    // furniture with, and older posts have nothing else. It is no longer what
    // reproduces THIS post — documentHtml is.
    if (resolved.theme) await this.saveTheme(resolved.theme);
    /* The article as authored, kept whole so the post can be reproduced exactly
       — head, element order and its own CSS included. See BlogAdminView.html.

       The body is then split OUT OF the prepared document rather than uploaded
       separately: both contain the same images, so hoisting each on its own
       would upload every image twice and leave the two copies pointing at
       different URLs. */
    const documentHtml =
      resolved.format === "html" ? await this.prepareDocument(rawHtml, ref.id) : null;
    /* The post's OWN design, split off the same prepared document as its body.
       This is what the reader draws — not the shared theme, which the next
       upload overwrites. See the `css` field below. */
    const own = documentHtml !== null ? extractTheme(documentHtml) : null;
    const content =
      own !== null
        ? own.html
        : await this.externalizeImages(this.htmlToMarkdown(resolved.html), ref.id);

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
      coverImageUrl: await this.resolveHero(body.heroImageUrl, ref.id),
      format: resolved.format,
      documentHtml,
      /* The stylesheet THIS post publishes with, kept on the post.

         It used to live only in the one shared THEME document, which every
         later upload overwrote — so a post published in March was redrawn with
         April's stylesheet, and any rule whose selectors did not match its
         markup simply stopped applying. That is a published article changing
         shape on its own, which is the one thing a blog must not do.

         The shared theme is still written (below, and still the fallback for
         posts that predate this field), but it is no longer what decides how a
         given article looks. */
      css: own ? own.theme.css : [],
      themeLinks: own ? own.theme.links : [],
      themeScripts: own ? own.theme.scripts : [],
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
    if (body.html !== undefined || body.format !== undefined) {
      // Same rule as create: html keeps its markup, everything else becomes
      // Markdown. Resolved together because the format decides both.
      const rawHtml = String(body.html ?? "");
      const r = this.resolveFormat(body, rawHtml);
      update.format = r.format;
      if (r.theme) await this.saveTheme(r.theme);
      if (body.html !== undefined) {
        // Kept in step with the body: a post edited into another format must
        // not keep a stale document, or it would reproduce as the old article.
        // Same single-upload rule as create — the body comes out of the
        // prepared document, not from a second pass over the same images.
        const doc = r.format === "html" ? await this.prepareDocument(rawHtml, id) : null;
        update.documentHtml = doc;
        const own = doc !== null ? extractTheme(doc) : null;
        update.content =
          own !== null
            ? own.html
            : await this.externalizeImages(this.htmlToMarkdown(r.html), id);
        // Kept in step with the body for the same reason it is: a post edited
        // out of html format must not keep the stylesheet of the article it
        // used to be. See the field docs in create().
        update.css = own ? own.theme.css : [];
        update.themeLinks = own ? own.theme.links : [];
        update.themeScripts = own ? own.theme.scripts : [];
      }
    }
    if (body.heroImageUrl !== undefined) {
      update.coverImageUrl = await this.resolveHero(body.heroImageUrl, id);
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
