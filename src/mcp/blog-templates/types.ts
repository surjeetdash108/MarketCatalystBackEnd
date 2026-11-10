/**
 * The two article designs MCP-created posts can compose against — see the
 * plan's "What the two live posts actually reveal" / "richer template"
 * sections. `preset-2-blog-page.html` is deliberately not offered here: it is
 * the console's blog-INDEX layout, not a single-article one.
 */
export type BlogTemplateId = "simple" | "richer";

export const BLOG_TEMPLATE_IDS: BlogTemplateId[] = ["simple", "richer"];

export function isBlogTemplateId(v: unknown): v is BlogTemplateId {
  return v === "simple" || v === "richer";
}

/** What create_blog_post / update_blog_post accept, before composition. */
export interface BlogComposeInput {
  title: string;
  dek: string;
  author?: string;
  kick?: string;
  read?: string;
  /** Inner content only — see get_blog_style_guide for the chosen template's class vocabulary. */
  bodyHtml: string;
}

function escapeHtml(s: string | number | null | undefined): string {
  return String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

export { escapeHtml as esc };
