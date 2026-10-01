import type { BlogTheme } from "../../blogs/blogs-admin.service";
import { esc, type BlogComposeInput } from "./types";

/**
 * The "simple" template: the design actually live at marketcatalyst.ai today
 * (scoped `.post-doc` when the site renders it), reverse-engineered
 * byte-for-byte from two live posts rather than from the repo's own
 * (unused-in-production) preset files. Both posts carried this exact
 * stylesheet verbatim, confirming it is the one shared design, not a
 * one-off.
 *
 * A note on the hero image: it is NOT part of this body. The site renders
 * `coverImageUrl` (the top-level `heroImageUrl` field on the post) as its own
 * `.article-hero` block above `.post-doc` — embedding another `<img>` inside
 * the composed body here would show the reader two hero images.
 *
 * Do-not-invent-classes: `.toc`, `.faq-item`/`.faq-q`/`.faq-a`, `.vsa-list`,
 * `.mistake-list`, `.retest-steps`, `.risk-box`, `.timeline*`,
 * `.bullbear-wrap`, `.example-chart`, `td.neg`, `td.amber` all appear in the
 * two live posts this was reverse-engineered from, and NONE of them has a
 * matching rule below — they render as plain unstyled text. Deliberately
 * left out of this stylesheet rather than "fixed", so get_blog_style_guide
 * can hold them up as the cautionary example.
 */
const SIMPLE_CSS = `
:where(.post-doc), :where(.post-doc *), :where(.post-doc *::before), :where(.post-doc *::after) { box-sizing: border-box; }
:where(.post-doc) { width: 100%; margin: 0; }
:where(.post-doc img), :where(.post-doc svg), :where(.post-doc video) { max-width: 100%; height: auto; }
:where(.post-doc pre) { overflow-x: auto; }
:where(.post-doc table) { border-collapse: collapse; }
/* The wrapper put around every table below. Inert at full width; it is what
   lets a wide table scroll instead of widening the page. */
:where(.post-doc) .post-doc-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; }

.post-doc{
    --cream: #F3EFE7;
    --white: #FFFFFF;
    --ink: #1A1A1A;
    --gray-text: #5B6472;
    --blue: #2563EB;
    --border: #E4DFD3;
    --pill-border: #D9D3C4;
    --green: #0F9D58;
    --red: #C0392B;
  }.post-doc, .post-doc *{ box-sizing: border-box; }.post-doc{
    margin: 0;
    background: var(--cream);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: var(--ink);
  }.post-doc header{
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 48px;
    background: var(--cream);
  }.post-doc .logo{
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 800;
    font-size: 20px;
  }.post-doc nav a{
    color: var(--ink);
    text-decoration: none;
    font-size: 16px;
    margin-left: 32px;
  }.post-doc main{
    max-width: 900px;
    margin: 0 auto;
    padding: 24px 24px 80px;
  }.post-doc .back-btn{
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--white);
    border: 1px solid var(--pill-border);
    border-radius: 24px;
    padding: 10px 20px;
    font-weight: 700;
    font-size: 15px;
    color: var(--ink);
    text-decoration: none;
    margin-bottom: 24px;
  }.post-doc .card{
    background: var(--white);
    border-radius: 24px;
    padding: 56px 64px 48px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }.post-doc .eyebrow{
    color: var(--blue);
    font-weight: 800;
    letter-spacing: 1.5px;
    font-size: 14px;
    margin-bottom: 16px;
  }.post-doc h1{
    font-size: 44px;
    line-height: 1.12;
    font-weight: 800;
    margin: 0 0 24px;
    letter-spacing: -0.5px;
  }.post-doc .subtitle{
    color: var(--gray-text);
    font-size: 20px;
    line-height: 1.5;
    margin: 0 0 28px;
    max-width: 660px;
  }.post-doc .tag{
    display: inline-block;
    border: 1px solid var(--pill-border);
    border-radius: 20px;
    padding: 6px 18px;
    font-size: 15px;
    color: var(--gray-text);
    margin-bottom: 24px;
  }.post-doc .meta{
    color: #8A8F98;
    font-size: 15px;
    margin-bottom: 40px;
  }.post-doc .meta span{ margin: 0 8px; }.post-doc .meta span:first-child{ margin-left: 0; }.post-doc hr.rule{
    border: none;
    border-top: 1px solid var(--border);
    margin: 0 0 40px;
  }.post-doc .article p{
    font-size: 18px;
    line-height: 1.7;
    color: #2B2F36;
    margin: 0 0 22px;
  }.post-doc .article h2{
    font-size: 26px;
    font-weight: 800;
    margin: 44px 0 16px;
    letter-spacing: -0.3px;
  }.post-doc .stat-strip{
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin: 8px 0 36px;
  }.post-doc .stat-box{
    background: #F7F5EF;
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 20px 16px;
    text-align: center;
  }.post-doc .stat-box .num{
    font-size: 28px;
    font-weight: 800;
    color: var(--blue);
    line-height: 1.1;
  }.post-doc .stat-box .label{
    font-size: 13px;
    color: var(--gray-text);
    margin-top: 6px;
  }.post-doc .callout{
    background: #F7F5EF;
    border: 1px solid var(--border);
    border-left: 4px solid var(--blue);
    border-radius: 10px;
    padding: 20px 24px;
    margin: 28px 0;
    font-size: 17px;
    line-height: 1.6;
  }.post-doc .warning{
    background: #FDF7EE;
    border: 1px solid #F0E1BE;
    border-left: 4px solid #C98A1E;
    border-radius: 10px;
    padding: 20px 24px;
    margin: 32px 0;
    font-size: 16px;
    line-height: 1.6;
    color: #5B4A26;
  }.post-doc .bar-chart{
    margin: 24px 0 40px;
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 24px 24px 8px;
    background: #FCFBF8;
  }.post-doc .bar-chart-title{
    font-size: 14px;
    font-weight: 700;
    color: var(--gray-text);
    margin-bottom: 18px;
    letter-spacing: 0.3px;
    text-transform: uppercase;
  }.post-doc .bar-row{
    display: grid;
    grid-template-columns: 50px 1fr 64px;
    align-items: center;
    gap: 12px;
    margin-bottom: 10px;
  }.post-doc .bar-row .year{
    font-size: 14px;
    color: var(--gray-text);
    font-weight: 600;
  }.post-doc .bar-track{
    position: relative;
    height: 20px;
    background: transparent;
  }.post-doc .bar-fill{
    position: absolute;
    top: 0;
    height: 20px;
    border-radius: 4px;
    background: var(--green);
  }.post-doc .bar-fill.negative{
    background: var(--red);
  }.post-doc .bar-row .val{
    font-size: 14px;
    font-weight: 700;
    text-align: right;
    color: var(--green);
  }.post-doc .bar-row .val.negative{ color: var(--red); }.post-doc table{
    width: 100%;
    border-collapse: collapse;
    margin: 24px 0 36px;
    font-size: 15px;
  }.post-doc th{
    text-align: left;
    font-size: 13px;
    letter-spacing: 0.5px;
    color: var(--gray-text);
    font-weight: 700;
    padding: 10px 12px;
    border-bottom: 2px solid var(--border);
  }.post-doc td{
    padding: 12px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }.post-doc td.metric{ font-weight: 700; color: var(--ink); }.post-doc td.pos{ color: var(--green); font-weight: 700; }.post-doc .takeaway-list{
    margin: 0 0 22px;
    padding-left: 20px;
  }.post-doc .takeaway-list li{
    font-size: 18px;
    line-height: 1.7;
    color: #2B2F36;
    margin-bottom: 14px;
  }.post-doc .takeaway-list strong{ color: var(--ink); }.post-doc .disclaimer{
    margin-top: 48px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
  }.post-doc .disclaimer p{
    font-size: 13px;
    line-height: 1.6;
    color: #9A9FA8;
    margin: 0 0 10px;
  }.post-doc .ai-note{
    font-size: 11px;
    color: #B4B8BF;
    margin: 0;
  }@media (max-width: 640px){.post-doc header{ padding: 16px 20px; }.post-doc .card{ padding: 32px 24px; }.post-doc h1{ font-size: 30px; }.post-doc .subtitle{ font-size: 17px; }.post-doc .stat-strip{ grid-template-columns: 1fr; }.post-doc table{ font-size: 13px; }.post-doc th, .post-doc td{ padding: 8px 6px; }.post-doc .bar-row{ grid-template-columns: 40px 1fr 52px; }}

/* At EVERY width: a direct child of the document cannot be wider than the
   document. This is the fixed-width wrapper case — width:1200px on the outer
   .wrap — and it was the gap in the first version of this net, which only
   clamped below 760px: a 1200px page still overflowed every laptop and tablet
   between 761px and 1199px, which is most of them. Restricting it to direct
   children keeps it off the deliberately-wider decorations (a full-bleed band,
   a negative-margin rule) that live deeper in a design. */
.post-doc > * { max-width: 100% !important; }

@media (max-width: 1024px) {
  /* A flex or grid child defaults to min-width:auto, so it refuses to shrink
     below its content and pushes its whole row wider than the screen — the
     single most common reason an uploaded page overflows. */
  .post-doc * { min-width: 0 !important; }
  /* Clamps fixed pixel widths further in, not just at the top level. */
  .post-doc * { max-width: 100% !important; }
}
@media (max-width: 760px) {
.post-doc :where(img, svg, video, canvas) { height: auto !important; }
  /* A long ticker or URL cannot widen its column.

     break-word, NOT anywhere, and deliberately not on headings or links:
     overflow-wrap:anywhere also shrinks an element's MIN-CONTENT width, and
     combined with the min-width:0 above that let a flex item collapse to the
     width of one character — the brand lockup in a document's own header
     rendered as "M / ar / k / et / UI", one letter per line. break-word breaks
     the same long words but leaves intrinsic sizing alone, so a flex row still
     reserves the space its content needs. */
  .post-doc :where(p, li, td, th, dd, blockquote, figcaption) { overflow-wrap: break-word; }
  /* white-space:nowrap is the one overflow the rest of this net cannot
     reach. max-width does not shorten a line that refuses to break, so a
     nowrap headline ran straight out of the column — and because .post-doc
     clips (blog-doc.css), it was CUT OFF rather than merely wide: the reader
     lost the end of the sentence with no way to scroll to it.

     Excludes td/th and pre deliberately. Tabular data and code are the cases
     where nowrap is meant, and both already have somewhere to go — every table
     is wrapped in .post-doc-scroll and pre gets overflow-x:auto (BASELINE
     above), so they scroll inside their own box instead of being clipped. */
  .post-doc :where(h1, h2, h3, h4, h5, h6, p, li, dd, blockquote, figcaption, a, span, div, strong, em) {
    white-space: normal !important;
  }
  /* A sticky nav inside the document must not also pin under the site header. */
  .post-doc :where(header, nav) { position: static !important; }
}
@media (max-width: 560px) {
  /* Phone width: a multi-column track cannot fit, whatever it was set to.
     minmax(0,1fr) rather than 1fr so a long unbreakable string in a cell
     still cannot force the track wider than the column. */
  .post-doc :where(div, section, main, article, aside, ul, ol) {
    grid-template-columns: minmax(0, 1fr) !important;
  }
  /* A row of fixed-width cards wraps instead of overflowing.

     Content containers only — NOT header/footer/nav. Those hold brand lockups
     and nav bars that a design gives a fixed height, so wrapping them pushed
     the second half of a logo out through the bottom of its own header. A card
     row is what needs to wrap; site chrome already has the design's own
     handling, and where it does not, min-width:0 above is enough. */
  .post-doc :where(div, section, ul, ol) { flex-wrap: wrap; }
}
`;

export const SIMPLE_THEME: BlogTheme = {
  css: [SIMPLE_CSS],
  links: [],
  scripts: [],
  inlineScripts: [],
};

/** Styled classes a `simple`-template body may use — see get_blog_style_guide. */
export const SIMPLE_STYLE_CLASSES = [
  ".eyebrow",
  "h1",
  ".subtitle",
  ".tag",
  ".meta",
  "hr.rule",
  ".article (p, h2)",
  ".stat-strip / .stat-box (.num, .label)",
  ".callout",
  ".warning",
  ".bar-chart / .bar-chart-title / .bar-row (.year, .bar-track, .bar-fill, .negative, .val)",
  "table / th / td (td.metric, td.pos)",
  ".takeaway-list",
  ".disclaimer",
  ".ai-note",
];

/** Classes seen in live posts with NO matching CSS — do not reuse these. */
export const SIMPLE_DEAD_CLASSES = [
  ".toc / .toc-title",
  ".faq-item / .faq-q / .faq-a",
  ".vsa-list (dl/dt/dd)",
  ".mistake-list",
  ".retest-steps",
  ".risk-box",
  ".timeline*",
  ".bullbear-wrap",
  ".example-chart",
  "td.neg",
  "td.amber",
];

/**
 * Wraps the agent's own `.article`-scoped content in the fixed masthead
 * every `simple` post shares (eyebrow/title/subtitle/meta/rule), producing
 * the `<body>` fragment `composeDocument()` then wraps in `<style>`.
 */
export function composeSimpleBody(input: BlogComposeInput): string {
  const metaParts = [input.read, input.author].filter((v) => v && v.trim());
  const meta = metaParts.map((v) => `<span>${esc(v)}</span>`).join("·");

  return `<div><main>
  <div class="card">
    <div class="card-body">
    <div class="eyebrow">${esc(input.kick || "MARKETCATALYST")}</div>
    <h1>${esc(input.title)}</h1>
    <p class="subtitle">${esc(input.dek)}</p>
    ${meta ? `<div class="meta">${meta}</div>` : ""}
    <hr class="rule" />
    <div class="article">
${input.bodyHtml}
    </div>
    </div>
  </div>
</main></div>`;
}
