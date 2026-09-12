import { SIMPLE_DEAD_CLASSES, SIMPLE_STYLE_CLASSES } from "./simple";
import { RICHER_DEAD_FEATURES, RICHER_STYLE_CLASSES } from "./richer";
import type { BlogTemplateId } from "./types";

const SHARED_CONSTRAINTS = [
  "title and dek (summary/excerpt) are both required — the backend rejects a create/update without them.",
  "A hero image (heroImageUrl) is optional and is rendered by the site itself above the article — never add your own <img> hero inside bodyHtml.",
  "The composed document is capped at 700KB — keep inline images to a reasonable few; prefer upload_blog_image and reference the returned URL instead of embedding huge base64 data.",
  "Embedded base64 images (data:image/png|jpeg|jpg|gif|webp;base64,...) are hoisted to Storage automatically — you may inline them, but an already-hosted URL is simpler and counts against the size cap far less.",
  "<script> tags never execute on the live page — do not rely on client-side JS for anything that must actually work.",
  "The stylesheet already handles small screens down to ~360px width — do not add your own media queries or fixed pixel widths.",
  "New posts always save as a Draft (create_blog_post/update_blog_post force this regardless of any status you pass) — call publish_blog_post as a separate, explicit step to make a post live.",
];

const SIMPLE_EXAMPLE = `<p>Opening paragraph of the article, inside the .article wrapper.</p>

<div class="stat-strip">
  <div class="stat-box"><div class="num">+2.4%</div><div class="label">S&amp;P 500</div></div>
  <div class="stat-box"><div class="num">-0.8%</div><div class="label">Nasdaq</div></div>
  <div class="stat-box"><div class="num">61%</div><div class="label">Advancers</div></div>
</div>

<h2>A section heading</h2>
<p>More prose.</p>

<div class="callout"><b>Worth flagging.</b> One sentence of context that deserves a highlighted box.</div>

<div class="table-scroll"><div class="post-doc-scroll">
<table>
  <thead><tr><th>Ticker</th><th>Price</th><th>Change</th></tr></thead>
  <tbody><tr><td class="metric">NVDA</td><td>$182.40</td><td class="pos">+3.1%</td></tr></tbody>
</table>
</div></div>`;

const RICHER_EXAMPLE = `<p>Opening paragraph, inside .post-body.</p>

<div class="figs">
  <div><div class="l">Revenue</div><div class="v num">$96.22B</div><div class="s"><span class="up">+106% y/y</span></div></div>
  <div><div class="l">Gross margin</div><div class="v num">75.0%</div><div class="s">+2.5 pts y/y</div></div>
</div>

<h2 id="quarter">The quarter in one line</h2>
<p>More prose. This heading gets picked up automatically into the "On this page" sidebar because it has an id.</p>

<div class="callout"><b>Worth flagging.</b> One sentence of context.</div>

<h2 id="faq">Frequently Asked Questions</h2>
<div class="faq">
  <details open><summary>A question a reader would ask?</summary><p>A direct answer.</p></details>
</div>`;

function guideFor(template: BlogTemplateId): string {
  if (template === "simple") {
    return [
      `## "simple" template — the design actually live at marketcatalyst.ai`,
      ``,
      `Styled classes (safe to use):`,
      ...SIMPLE_STYLE_CLASSES.map((c) => `- ${c}`),
      ``,
      `Do NOT invent classes beyond this list. These appear in real (older) posts but have ZERO matching CSS and render as plain unstyled text — a cautionary example, not something to imitate:`,
      ...SIMPLE_DEAD_CLASSES.map((c) => `- ${c}`),
      ``,
      `Worked example (bodyHtml — goes inside the .article wrapper, which the tool adds for you):`,
      "```html",
      SIMPLE_EXAMPLE,
      "```",
    ].join("\n");
  }
  return [
    `## "richer" template — hero/stat-grid/FAQ layout, adapted from preset-1-article.html`,
    ``,
    `Styled classes (safe to use):`,
    ...RICHER_STYLE_CLASSES.map((c) => `- ${c}`),
    ``,
    `Not available in this template (present in the original design file, but either removed or non-functional once JS is stripped for the live site):`,
    ...RICHER_DEAD_FEATURES.map((c) => `- ${c}`),
    ``,
    `The "On this page" sidebar is generated automatically from any <h2 id="..."> heading in your bodyHtml — give real ids to every <h2>, and don't try to build the sidebar yourself.`,
    ``,
    `Worked example (bodyHtml — goes inside the .post-body wrapper, which the tool adds for you):`,
    "```html",
    RICHER_EXAMPLE,
    "```",
  ].join("\n");
}

/** The full text returned by the get_blog_style_guide tool. */
export function buildStyleGuide(template?: BlogTemplateId): string {
  const sections =
    template === "simple"
      ? [guideFor("simple")]
      : template === "richer"
        ? [guideFor("richer")]
        : [guideFor("simple"), guideFor("richer")];

  return [
    ...sections,
    ``,
    `## Constraints that apply to every template`,
    ...SHARED_CONSTRAINTS.map((c) => `- ${c}`),
  ].join("\n");
}
