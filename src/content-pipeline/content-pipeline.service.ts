import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { BlogsAdminService } from "../blogs/blogs-admin.service";
import { PulseService } from "../pulse/pulse.service";
import {
  composeArticleDocument,
  readLine,
  type BlogArticle,
} from "./blog-article";
import {
  BlogWriterService,
  WriterKeyMissingError,
} from "./blog-writer.service";
import { ContentQueueService } from "./content-queue.service";
import {
  BLOG_SECTIONS,
  CONTENT_ITEMS,
  LIVE_FEED_POSTS,
  MAX_WRITE_ATTEMPTS,
  cleanReviewNote,
  cleanSubmission,
  parseFeedBody,
  pulseText,
  type BlogSection,
  type ContentKind,
  type ContentStatus,
  type FeedBullet,
} from "./content-pipeline.rules";

/** A writing claim older than this is treated as abandoned (worker restarted mid-write). */
const STALE_WRITING_MS = 15 * 60_000;
/** One writer run stops taking new items after this long and wakes itself again. */
const RUN_BUDGET_MS = 8 * 60_000;
const LIVE_FEED_LIMIT = 50;

/** content_items/{id} as stored. */
interface ItemDoc {
  kind: ContentKind;
  status: ContentStatus;
  note: string;
  batchId: string;
  submittedBy: string;
  createdAt: string;
  updatedAt: string;
  tickers: string[];
  // blog
  section?: BlogSection;
  headline?: string | null;
  notes?: string;
  links?: string[];
  attempts?: number;
  writingStartedAt?: string | null;
  reviewNote?: string | null;
  article?: BlogArticle | null;
  model?: string | null;
  blogPostId?: string | null;
  // pulse / feed
  header?: string;
  body?: string;
  pulsePostId?: string | null;
  feedPostId?: string | null;
  postedAt?: string | null;
  error?: string | null;
}

/** What the admin screens get for each row. */
export interface ContentItemView {
  id: string;
  kind: ContentKind;
  status: ContentStatus;
  note: string;
  title: string;
  where: string;
  section: BlogSection | null;
  tickers: string[];
  createdAt: string;
  updatedAt: string;
  postedAt: string | null;
  error: string | null;
  blogPostId: string | null;
}

/** A Live Feed post, as Intraday commentary reads it. */
export interface LiveFeedPost {
  id: string;
  header: string;
  summary: string;
  bullets: FeedBullet[];
  tickers: string[];
  createdAt: string;
}

function whereOf(d: ItemDoc): string {
  if (d.kind === "blog") return `Blog · ${d.section ?? ""}`.trim();
  return d.kind === "pulse" ? "Market Catalyst Pulse" : "Live Feed";
}

function titleOf(d: ItemDoc): string {
  if (d.kind !== "blog") return d.header ?? "";
  if (d.article?.title) return d.article.title;
  if (d.headline) return d.headline;
  const first =
    (d.notes ?? "")
      .split("\n")
      .map((l) => l.replace(/[*_]/g, "").trim())
      .find(Boolean) ?? "";
  return first.length > 90 ? `${first.slice(0, 88)}…` : first;
}

function view(id: string, d: ItemDoc): ContentItemView {
  return {
    id,
    kind: d.kind,
    status: d.status,
    note: d.note ?? "",
    title: titleOf(d),
    where: whereOf(d),
    section: d.section ?? null,
    tickers: d.tickers ?? [],
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    postedAt: d.postedAt ?? null,
    error: d.error ?? null,
    blogPostId: d.blogPostId ?? null,
  };
}

/**
 * The content pipeline. An admin submits once; each destination becomes its
 * own content_items row:
 *  - Pulse and Live Feed post immediately, as entered (no AI step).
 *  - Blog rows are queued; the worker's content-blog-writer job (woken over
 *    Pub/Sub) writes them one at a time with Claude from the notes only and
 *    saves each as a Draft blog post marked "review". An admin approves it
 *    (it publishes) or sends it back with a note (it is rewritten).
 */
@Injectable()
export class ContentPipelineService {
  private readonly logger = new Logger(ContentPipelineService.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly blogs: BlogsAdminService,
    private readonly pulse: PulseService,
    private readonly writer: BlogWriterService,
    private readonly queue: ContentQueueService,
  ) {}

  private get items() {
    return this.firebase.firestore.collection(CONTENT_ITEMS);
  }
  private get feedPosts() {
    return this.firebase.firestore.collection(LIVE_FEED_POSTS);
  }

  private async load(id: string): Promise<ItemDoc> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
      throw new BadRequestException("Invalid item id.");
    const snap = await this.items.doc(id).get();
    if (!snap.exists) throw new NotFoundException("That item doesn't exist.");
    return snap.data() as ItemDoc;
  }

  private async patch(id: string, patch: Partial<ItemDoc>): Promise<void> {
    await this.items
      .doc(id)
      .set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true });
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async submit(
    body: unknown,
    actor: string,
  ): Promise<{ items: ContentItemView[] }> {
    const sub = cleanSubmission(body);
    const now = new Date().toISOString();
    const batchId = this.items.doc().id;
    const base = {
      batchId,
      submittedBy: actor,
      createdAt: now,
      updatedAt: now,
      error: null,
      postedAt: null,
    };
    const out: ContentItemView[] = [];

    if (sub.pulse) {
      const ref = this.items.doc();
      let doc: ItemDoc = {
        ...base,
        kind: "pulse",
        status: "posted",
        note: "",
        tickers: sub.pulse.ticker ? [sub.pulse.ticker] : [],
        header: sub.pulse.header,
        body: sub.pulse.body,
      };
      try {
        const post = await this.pulse.create(
          {
            text: pulseText(sub.pulse.header, sub.pulse.body),
            ticker: sub.pulse.ticker ?? "",
          },
          undefined,
          { unlimited: true },
        );
        doc = {
          ...doc,
          pulsePostId: post.id,
          postedAt: post.createdAt,
          note: "Posted to Market Catalyst Pulse",
        };
      } catch (err) {
        doc = {
          ...doc,
          status: "failed",
          note: "Couldn't post to Pulse",
          error: (err as Error).message,
        };
      }
      await ref.set(doc);
      out.push(view(ref.id, doc));
    }

    if (sub.feed) {
      const ref = this.items.doc();
      let doc: ItemDoc = {
        ...base,
        kind: "feed",
        status: "posted",
        note: "",
        tickers: sub.feed.tickers,
        header: sub.feed.header,
        body: sub.feed.body,
      };
      try {
        const feedId = await this.postToFeed(
          sub.feed.header,
          sub.feed.body,
          sub.feed.tickers,
          ref.id,
        );
        doc = {
          ...doc,
          feedPostId: feedId,
          postedAt: new Date().toISOString(),
          note: "Posted to Live Feed",
        };
      } catch (err) {
        doc = {
          ...doc,
          status: "failed",
          note: "Couldn't post to Live Feed",
          error: (err as Error).message,
        };
      }
      await ref.set(doc);
      out.push(view(ref.id, doc));
    }

    if (sub.blog) {
      const ref = this.items.doc();
      const ahead = (
        await this.items.where("status", "==", "queued").get()
      ).docs.filter((d) => (d.data() as ItemDoc).kind === "blog").length;
      const doc: ItemDoc = {
        ...base,
        kind: "blog",
        status: "queued",
        note: this.writer.enabled
          ? ahead === 0
            ? "Next in line"
            : `#${ahead + 1} in line`
          : "AI key not set (ANTHROPIC_API_KEY). Add it, then press Retry.",
        tickers: sub.blog.tickers,
        section: sub.blog.section,
        headline: sub.blog.headline,
        notes: sub.blog.notes,
        links: sub.blog.links,
        attempts: 0,
        writingStartedAt: null,
        reviewNote: null,
        article: null,
        model: null,
        blogPostId: null,
      };
      await ref.set(doc);
      out.push(view(ref.id, doc));
      if (this.writer.enabled) await this.queue.wake(ref.id, "submitted");
    }
    return { items: out };
  }

  private async postToFeed(
    header: string,
    body: string,
    tickers: string[],
    itemId: string,
  ): Promise<string> {
    const { summary, bullets } = parseFeedBody(body);
    const ref = this.feedPosts.doc();
    await ref.set({
      header,
      summary,
      bullets,
      body,
      tickers,
      itemId,
      createdAt: new Date().toISOString(),
    });
    return ref.id;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async list(
    limit = 200,
  ): Promise<{ items: ContentItemView[]; aiEnabled: boolean; model: string }> {
    const snap = await this.items
      .orderBy("createdAt", "desc")
      .limit(Math.min(Math.max(limit, 1), 500))
      .get();
    return {
      items: snap.docs.map((d) => view(d.id, d.data() as ItemDoc)),
      aiEnabled: this.writer.enabled,
      model: this.writer.model,
    };
  }

  /** One item with what the preview needs: the input, and for a written blog item the article as it will appear. */
  async get(id: string) {
    const d = await this.load(id);
    const feed = d.kind === "blog" ? null : parseFeedBody(d.body ?? "");
    return {
      item: view(id, d),
      input: {
        notes: d.notes ?? null,
        headline: d.headline ?? null,
        links: d.links ?? [],
        header: d.header ?? null,
        body: d.body ?? null,
        summary: feed?.summary ?? null,
        bullets: feed?.bullets ?? [],
      },
      reviewNote: d.reviewNote ?? null,
      article: d.article ?? null,
      previewHtml: d.article
        ? composeArticleDocument(
            d.article,
            readLine(new Date(), d.article.readMinutes),
          )
        : null,
      model: d.model ?? null,
    };
  }

  async liveFeed(limit = LIVE_FEED_LIMIT): Promise<LiveFeedPost[]> {
    const snap = await this.feedPosts
      .orderBy("createdAt", "desc")
      .limit(Math.min(Math.max(limit, 1), 100))
      .get();
    return snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        header: String(d.header ?? ""),
        summary: String(d.summary ?? ""),
        bullets: Array.isArray(d.bullets) ? (d.bullets as FeedBullet[]) : [],
        tickers: Array.isArray(d.tickers) ? (d.tickers as string[]) : [],
        createdAt: String(d.createdAt ?? ""),
      };
    });
  }

  // ── Review ────────────────────────────────────────────────────────────────

  async approve(id: string): Promise<ContentItemView> {
    const d = await this.load(id);
    if (
      d.kind !== "blog" ||
      d.status !== "review" ||
      !d.article ||
      !d.blogPostId
    )
      throw new BadRequestException(
        "Only a written blog article waiting for review can be approved.",
      );
    const at = new Date();
    const read = readLine(at, d.article.readMinutes);
    await this.blogs.update(d.blogPostId, {
      status: "published",
      read,
      html: composeArticleDocument(d.article, read),
      format: "html",
    });
    const patch: Partial<ItemDoc> = {
      status: "posted",
      postedAt: at.toISOString(),
      note: `Approved and posted to the Blog under ${d.section}`,
      error: null,
    };
    await this.patch(id, patch);
    return view(id, { ...d, ...patch });
  }

  async sendBack(id: string, rawNote: unknown): Promise<ContentItemView> {
    const note = cleanReviewNote(rawNote);
    const d = await this.load(id);
    if (d.kind !== "blog" || d.status !== "review")
      throw new BadRequestException(
        "Only a blog article waiting for review can be sent back.",
      );
    const patch: Partial<ItemDoc> = {
      status: "queued",
      reviewNote: note,
      attempts: 0,
      note: "Sent back: waiting to be rewritten",
      error: null,
    };
    await this.patch(id, patch);
    await this.queue.wake(id, "sent-back");
    return view(id, { ...d, ...patch });
  }

  async retry(id: string): Promise<ContentItemView> {
    const d = await this.load(id);
    if (d.kind === "blog") {
      if (d.status !== "failed" && d.status !== "queued")
        throw new BadRequestException(
          "Only a failed or waiting blog item can be retried.",
        );
      const patch: Partial<ItemDoc> = {
        status: "queued",
        attempts: 0,
        error: null,
        note: this.writer.enabled
          ? "Back in the queue"
          : "AI key not set (ANTHROPIC_API_KEY). Add it, then press Retry.",
      };
      await this.patch(id, patch);
      if (this.writer.enabled) await this.queue.wake(id, "retry");
      return view(id, { ...d, ...patch });
    }
    if (d.status !== "failed")
      throw new BadRequestException("Only a failed item can be retried.");
    let patch: Partial<ItemDoc>;
    try {
      if (d.kind === "pulse") {
        const post = await this.pulse.create(
          {
            text: pulseText(d.header ?? "", d.body ?? ""),
            ticker: d.tickers[0] ?? "",
          },
          undefined,
          { unlimited: true },
        );
        patch = {
          status: "posted",
          pulsePostId: post.id,
          postedAt: post.createdAt,
          note: "Posted to Market Catalyst Pulse",
          error: null,
        };
      } else {
        const feedId = await this.postToFeed(
          d.header ?? "",
          d.body ?? "",
          d.tickers ?? [],
          id,
        );
        patch = {
          status: "posted",
          feedPostId: feedId,
          postedAt: new Date().toISOString(),
          note: "Posted to Live Feed",
          error: null,
        };
      }
    } catch (err) {
      patch = { error: (err as Error).message, note: "Retry failed" };
    }
    await this.patch(id, patch);
    return view(id, { ...d, ...patch });
  }

  // ── Writer (worker: content-blog-writer job) ──────────────────────────────

  /**
   * Writes queued blog items one at a time, oldest first, until none are left
   * or the run budget is used (then it wakes itself again). Safe to call
   * concurrently: each item is claimed in a transaction.
   */
  async processQueue(): Promise<{
    written: number;
    failed: number;
    waiting: number;
    status: string;
  }> {
    const started = Date.now();
    await this.releaseStaleClaims();
    const queued = await this.queuedBlogIds();
    if (queued.length === 0)
      return { written: 0, failed: 0, waiting: 0, status: "idle" };
    if (!this.writer.enabled) {
      const note = new WriterKeyMissingError().message;
      for (const id of queued)
        await this.items.doc(id).set({ note }, { merge: true });
      return {
        written: 0,
        failed: 0,
        waiting: queued.length,
        status: "no-ai-key",
      };
    }

    let written = 0;
    let failed = 0;
    for (;;) {
      const [next] = await this.queuedBlogIds();
      if (!next) break;
      if (Date.now() - started > RUN_BUDGET_MS) {
        await this.queue.wake(next, "next");
        break;
      }
      const claimed = await this.claim(next);
      if (!claimed) continue;
      const result = await this.writeOne(next, claimed);
      if (result === "written") written++;
      else if (result === "failed") failed++;
      else if (result === "no-key") break;
    }
    const waiting = (await this.queuedBlogIds()).length;
    return { written, failed, waiting, status: "done" };
  }

  private async queuedBlogIds(): Promise<string[]> {
    const snap = await this.items.where("status", "==", "queued").get();
    return snap.docs
      .filter((d) => (d.data() as ItemDoc).kind === "blog")
      .sort((a, b) =>
        String((a.data() as ItemDoc).createdAt).localeCompare(
          String((b.data() as ItemDoc).createdAt),
        ),
      )
      .map((d) => d.id);
  }

  private async releaseStaleClaims(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_WRITING_MS).toISOString();
    const snap = await this.items.where("status", "==", "writing").get();
    for (const doc of snap.docs) {
      const d = doc.data() as ItemDoc;
      if ((d.writingStartedAt ?? "") < cutoff) {
        await this.patch(doc.id, {
          status: "queued",
          note: "Writing was interrupted; back in the queue",
          writingStartedAt: null,
        });
      }
    }
  }

  /** queued → writing, atomically. Returns the item, or null if someone else took it. */
  private async claim(id: string): Promise<ItemDoc | null> {
    const ref = this.items.doc(id);
    return this.firebase.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.data() as ItemDoc | undefined;
      if (!d || d.status !== "queued" || d.kind !== "blog") return null;
      const now = new Date().toISOString();
      tx.set(
        ref,
        {
          status: "writing",
          writingStartedAt: now,
          updatedAt: now,
          note: d.reviewNote ? "Rewriting with your note" : "Writing with AI",
        },
        { merge: true },
      );
      return d;
    });
  }

  private async writeOne(
    id: string,
    d: ItemDoc,
  ): Promise<"written" | "failed" | "retry" | "no-key"> {
    const section = d.section ?? "News";
    try {
      const { article, model } = await this.writer.write({
        section,
        headline: d.headline ?? null,
        tickers: d.tickers ?? [],
        notes: d.notes ?? "",
        links: d.links ?? [],
        reviewNote: d.reviewNote ?? null,
        previous: d.reviewNote ? (d.article ?? null) : null,
      });
      const read = readLine(new Date(), article.readMinutes);
      const html = composeArticleDocument(article, read);
      const meta = BLOG_SECTIONS[section];
      let blogPostId = d.blogPostId ?? null;
      const fields = {
        zone: meta.zone,
        kick: meta.kick,
        title: article.title,
        dek: article.dek,
        read,
        author: "",
        format: "html",
        html,
        status: "draft",
      };
      if (blogPostId) await this.blogs.update(blogPostId, fields);
      else blogPostId = (await this.blogs.create(fields)).id;
      await this.patch(id, {
        status: "review",
        article,
        model,
        blogPostId,
        writingStartedAt: null,
        error: null,
        note: "Written by AI · ready for review",
      });
      this.logger.log(
        `content item ${id} written (${section}) → draft ${blogPostId}`,
      );
      return "written";
    } catch (err) {
      if (err instanceof WriterKeyMissingError) {
        await this.patch(id, {
          status: "queued",
          writingStartedAt: null,
          note: err.message,
        });
        return "no-key";
      }
      const attempts = (d.attempts ?? 0) + 1;
      const message = (err as Error).message;
      this.logger.warn(
        `content item ${id} write attempt ${attempts} failed: ${message}`,
      );
      if (attempts >= MAX_WRITE_ATTEMPTS) {
        await this.patch(id, {
          status: "failed",
          attempts,
          writingStartedAt: null,
          error: message,
          note: `Failed after ${attempts} tries`,
        });
        return "failed";
      }
      await this.patch(id, {
        status: "queued",
        attempts,
        writingStartedAt: null,
        error: message,
        note: `Retrying (attempt ${attempts + 1} of ${MAX_WRITE_ATTEMPTS})`,
      });
      return "retry";
    }
  }
}
