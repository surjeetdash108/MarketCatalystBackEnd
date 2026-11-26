/** The one slug rule for posts (moved out of blogs-admin.service so tests and
 *  helpers can use it without loading the service's dependencies). */

/**
 * Longest slug. "https://marketcatalyst.ai/posts/" is 32 characters and the SEO
 * audit flags URLs over 115, so this leaves room for a "-2" duplicate suffix.
 * Keep in step with MAX_SLUG_CHARS in the website's lib/seo/shorten.ts.
 */
export const MAX_SLUG_LENGTH = 80;

/** A post's base slug from its title (before any "-2" duplicate suffix). Exported
 *  so a job can print the post's own URL in the article before creating it. */
export function blogSlug(input: string): string {
  const slug = String(input)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= MAX_SLUG_LENGTH) return slug;

  // Cut between words, and never leave a phrase hanging on "...-revenue-to".
  const words = slug.split("-");
  while (
    words.length > 1 &&
    (words.join("-").length > MAX_SLUG_LENGTH ||
      /^(a|an|the|of|to|in|on|at|for|with|and|or|as|by|from|than|over|amid|after|while|but|s)$/.test(
        words[words.length - 1]!,
      ))
  ) {
    words.pop();
  }
  return words.join("-");
}
