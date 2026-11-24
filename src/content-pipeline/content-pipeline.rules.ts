import { BadRequestException } from "@nestjs/common";

/**
 * Content pipeline: one admin submission becomes up to three items, one per
 * destination. Blog items are written by Claude from the notes and wait for an
 * admin to approve them; Pulse and Live Feed items post as entered.
 *
 * This file holds the pure rules (validation, parsing, mapping) so they can be
 * tested without Firestore, Pub/Sub or the Claude API.
 */

export const CONTENT_ITEMS = "content_items";
export const LIVE_FEED_POSTS = "live_feed_posts";

export type ContentKind = "blog" | "pulse" | "feed";
export type ContentStatus =
  "queued" | "writing" | "review" | "posted" | "failed";

/** Blog sections the pipeline writes for: the blog's existing labels only. */
export const BLOG_SECTIONS = {
  Recap: { zone: "recap", kick: "Recap" },
  News: { zone: "news", kick: "News" },
  Earnings: { zone: "earnings", kick: "Earnings" },
  Educational: { zone: "edu", kick: "Educational" },
} as const;
export type BlogSection = keyof typeof BLOG_SECTIONS;

export const NOTES_MAX = 20_000;
export const HEADER_MAX = 200;
export const FEED_BODY_MAX = 4_000;
/** Pulse posts are one text field of at most 500 characters (PulseService). */
export const PULSE_TEXT_MAX = 500;
export const REVIEW_NOTE_MAX = 2_000;
export const MAX_TICKERS = 10;
/** After this many failed writing attempts a blog item is marked failed. */
export const MAX_WRITE_ATTEMPTS = 3;

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

export interface BlogInput {
  section: BlogSection;
  headline: string | null;
  tickers: string[];
  notes: string;
  links: string[];
}
export interface PulseInput {
  header: string;
  body: string;
  ticker: string | null;
}
export interface FeedInput {
  header: string;
  body: string;
  tickers: string[];
}
export interface Submission {
  blog: BlogInput | null;
  pulse: PulseInput | null;
  feed: FeedInput | null;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** "LCID, $UBER tsla" or ["LCID"] → ["LCID","UBER","TSLA"]; rejects anything that isn't a ticker. */
export function cleanTickers(v: unknown): string[] {
  const raw = Array.isArray(v)
    ? v.map(String)
    : typeof v === "string"
      ? v.split(/[\s,]+/)
      : [];
  const out: string[] = [];
  for (const r of raw) {
    const t = r.trim().replace(/^\$/, "").toUpperCase();
    if (!t) continue;
    if (!TICKER_RE.test(t))
      throw new BadRequestException(`"${r.trim()}" isn't a valid ticker.`);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TICKERS)
    throw new BadRequestException(`Up to ${MAX_TICKERS} tickers.`);
  return out;
}

function cleanLinks(v: unknown): string[] {
  const raw = Array.isArray(v)
    ? v.map(String)
    : typeof v === "string"
      ? v.split(/\s+/)
      : [];
  return raw
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      let u: URL;
      try {
        u = new URL(s);
      } catch {
        throw new BadRequestException(`"${s}" isn't a link.`);
      }
      if (u.protocol !== "https:" && u.protocol !== "http:")
        throw new BadRequestException(`"${s}" isn't a web link.`);
      return u.toString();
    })
    .slice(0, 20);
}

function required(v: unknown, what: string, max: number): string {
  const s = text(v);
  if (!s) throw new BadRequestException(`${what} is required.`);
  if (s.length > max)
    throw new BadRequestException(
      `${what} is limited to ${max.toLocaleString()} characters.`,
    );
  return s;
}

/** Validates a POST /api/admin/content body. At least one destination is required. */
export function cleanSubmission(body: unknown): Submission {
  const b = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;
  const obj = (k: string) =>
    b[k] && typeof b[k] === "object" ? (b[k] as Record<string, unknown>) : null;
  const blogRaw = obj("blog");
  const pulseRaw = obj("pulse");
  const feedRaw = obj("feed");
  if (!blogRaw && !pulseRaw && !feedRaw)
    throw new BadRequestException("Pick at least one place to post.");

  let blog: BlogInput | null = null;
  if (blogRaw) {
    const section = text(blogRaw.section) as BlogSection;
    if (!(section in BLOG_SECTIONS))
      throw new BadRequestException(
        `Section must be one of ${Object.keys(BLOG_SECTIONS).join(", ")}.`,
      );
    const headline = text(blogRaw.headline);
    if (headline.length > HEADER_MAX)
      throw new BadRequestException(
        `Working headline is limited to ${HEADER_MAX} characters.`,
      );
    blog = {
      section,
      headline: headline || null,
      tickers: cleanTickers(blogRaw.tickers),
      notes: required(blogRaw.notes, "Notes for the blog article", NOTES_MAX),
      links: cleanLinks(blogRaw.links),
    };
  }

  let pulse: PulseInput | null = null;
  if (pulseRaw) {
    const header = required(pulseRaw.header, "Pulse header", HEADER_MAX);
    const bodyText = required(pulseRaw.body, "Pulse body", PULSE_TEXT_MAX);
    if (pulseText(header, bodyText).length > PULSE_TEXT_MAX)
      throw new BadRequestException(
        `Pulse header and body together are limited to ${PULSE_TEXT_MAX} characters.`,
      );
    const tickers = cleanTickers(pulseRaw.ticker ?? pulseRaw.tickers);
    pulse = { header, body: bodyText, ticker: tickers[0] ?? null };
  }

  let feed: FeedInput | null = null;
  if (feedRaw) {
    feed = {
      header: required(feedRaw.header, "Live Feed header", HEADER_MAX),
      body: required(feedRaw.body, "Live Feed body", FEED_BODY_MAX),
      tickers: cleanTickers(feedRaw.tickers ?? feedRaw.ticker),
    };
  }
  return { blog, pulse, feed };
}

/** Pulse has no separate header field: the post is the header, a blank line, then the body. */
export function pulseText(header: string, body: string): string {
  return `${header}\n\n${body}`;
}

export interface FeedBullet {
  label: string;
  text: string;
}

/**
 * A Live Feed body → its summary and bullets. The summary is every line that
 * isn't a bullet; a bullet starts with *, - or •, and "Label: text" splits at
 * the first colon when the label is short. Markdown asterisks are dropped.
 */
export function parseFeedBody(body: string): {
  summary: string;
  bullets: FeedBullet[];
} {
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // "*text*" alone is an italic line (the summary), not a bullet: a bullet's
  // marker is followed by a space.
  const isBullet = (l: string) => /^[*\-•]\s+/.test(l);
  const clean = (l: string) =>
    l
      .replace(/^[*\-•]\s*/, "")
      .replace(/\*/g, "")
      .trim();
  const summary = lines
    .filter((l) => !isBullet(l))
    .map(clean)
    .join(" ");
  const bullets = lines.filter(isBullet).map((l) => {
    const t = clean(l);
    const i = t.indexOf(":");
    return i > 0 && i <= 40
      ? { label: t.slice(0, i + 1), text: t.slice(i + 1).trim() }
      : { label: "", text: t };
  });
  return { summary, bullets };
}

export function cleanReviewNote(v: unknown): string {
  const s = text(v);
  if (!s) throw new BadRequestException("Say what to change.");
  if (s.length > REVIEW_NOTE_MAX)
    throw new BadRequestException(
      `The note is limited to ${REVIEW_NOTE_MAX.toLocaleString()} characters.`,
    );
  return s;
}
