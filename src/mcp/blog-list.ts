import type { BlogAdminView } from "../blogs/blogs-admin.service";

/**
 * list_blog_posts returns a page of summaries, never bodies: the full list
 * (every post's HTML + CSS) passed Cloud Run's 32 MB response limit, so the
 * tool failed with a 500 and the live API ran out of memory building it.
 */
export function summarizePosts(
  posts: BlogAdminView[],
  opts: { limit?: number; offset?: number; status?: "Published" | "Draft"; query?: string } = {},
) {
  const q = opts.query?.trim().toLowerCase();
  const filtered = posts.filter(
    (p) => (!opts.status || p.status === opts.status) && (!q || p.title.toLowerCase().includes(q)),
  );
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
  return {
    total: filtered.length,
    offset,
    limit,
    posts: filtered.slice(offset, offset + limit).map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      zone: p.zone,
      author: p.author,
      date: p.date,
      publishedAt: p.publishedAt,
      createdAt: p.createdAt,
      format: p.format,
      heroImageUrl: p.heroImageUrl,
      editorsChoice: p.editorsChoice,
    })),
  };
}
