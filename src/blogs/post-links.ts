/**
 * Internal post links checked and corrected when a post is saved (26 Nov 2026
 * audit, B-01 / B-16).
 *
 * Writers (the blog MCP connector, the admin console) build "Readers also
 * read" and related links from a post's TITLE. A post is served at its stored
 * slug, which is cut to MAX_SLUG_LENGTH between words and may carry a "-2"
 * suffix, so a link rebuilt from a long title 404s (60 such targets, 170
 * links, on Nov 26). Every /posts/{slug} link is therefore resolved against
 * the stored slugs: an exact match stays, a full-length slug is rewritten to
 * the slug the post is served at, and anything else is reported so a
 * published post never ships a dead link.
 */

/** Published (live) posts by stored slug. */
export type SlugIndex = Map<string, { published: boolean }>;

/** `https://marketcatalyst.ai/posts/x`, `//marketcatalyst.ai/posts/x`, `/posts/x`. */
const LINK =
  /href=(["'])((?:https?:)?(?:\/\/(?:www\.)?marketcatalyst\.ai)?\/posts\/([a-z0-9-]+)\/?)([?#][^"']*)?\1/gi;

export interface LinkReport {
  html: string;
  /** Full-length or stale slugs rewritten to the live slug. */
  rewritten: Array<{ from: string; to: string }>;
  /** Links that point at no live post. */
  dead: string[];
}

/**
 * @param shorten the site's own slug rule (blogSlug), so a full-length slug
 *   maps to the slug its title produced.
 */
export function resolvePostLinks(
  html: string,
  index: SlugIndex,
  shorten: (s: string) => string,
): LinkReport {
  const rewritten: LinkReport["rewritten"] = [];
  const dead = new Set<string>();
  const out = html.replace(
    LINK,
    (whole, q: string, url: string, slug: string, tail: string | undefined) => {
      const live = (s: string) => index.get(s)?.published === true;
      if (live(slug)) return whole;
      const short = shorten(slug);
      if (short !== slug && live(short)) {
        rewritten.push({ from: slug, to: short });
        return `href=${q}${url.replace(`/posts/${slug}`, `/posts/${short}`)}${tail ?? ""}${q}`;
      }
      dead.add(url);
      return whole;
    },
  );
  return { html: out, rewritten, dead: [...dead] };
}
