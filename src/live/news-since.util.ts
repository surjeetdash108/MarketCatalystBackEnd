/**
 * `GET /live/news?ticker=X&since=<ISO>` — incremental poll. The client already
 * holds the ticker's history, so it only needs articles that arrived after the
 * newest timestamp it has seen.
 *
 * The cursor is `createdAt` — stamped once when the news job first writes an
 * article and preserved on every re-write (firestore-batch.util). It is NOT
 * `updatedAt`: the job re-stamps `updatedAt` on each ticker's newest articles
 * every run, so that field would make unchanged articles look new on every
 * poll. `updatedAt`/`publishedAt` are fallbacks for docs without a `createdAt`.
 */

/** Parses the `since` query value: undefined when absent, null when unusable. */
export function parseSince(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** The article's cursor time in ms (0 when it carries no usable timestamp). */
export function newsStamp(a: Record<string, unknown>): number {
  for (const k of ["createdAt", "updatedAt", "publishedAt"]) {
    const v = a[k];
    if (typeof v === "string") {
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return 0;
}

/** Articles strictly newer than `sinceMs` by their cursor time. */
export function articlesSince(
  articles: Record<string, unknown>[],
  sinceMs: number,
): Record<string, unknown>[] {
  return articles.filter((a) => newsStamp(a) > sinceMs);
}

/** True when a Firestore error means the composite index isn't deployed yet. */
export function isMissingIndexError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return (
    e?.code === 9 ||
    /FAILED_PRECONDITION|requires an index/i.test(String(e?.message ?? ""))
  );
}
