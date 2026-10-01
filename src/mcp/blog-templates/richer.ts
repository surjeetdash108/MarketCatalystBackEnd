import type { BlogTheme } from "../../blogs/blogs-admin.service";
import { esc, type BlogComposeInput } from "./types";

/**
 * The "richer" template: adapted from
 * `MarketCatalystUI/public/admin/presets/preset-1-article.html` (hero image,
 * share/TOC sidebars, stat grid, FAQ accordion, CTA card, "latest posts"
 * strip, light/dark theme toggle).
 *
 * Two adaptations were required to make it safe to publish as a `format:
 * "html"` post body rather than a standalone page:
 *
 * 1. **Self-scoped selectors.** The preset's own stylesheet is written with
 *    BARE selectors (`.card{...}`, `h1{...}`, `body{...}`) meant for a
 *    standalone page. The two live "simple"-template posts this repo already
 *    reverse-engineered self-scope every rule under `.post-doc` — the site
 *    does not appear to auto-namespace an uploaded stylesheet, it publishes
 *    the `<style>` block verbatim next to the extracted body. An unscoped
 *    `.card`/`h1`/`body` rule would therefore leak onto the SITE's own chrome
 *    around the article, not just the article itself. Every selector below
 *    is prefixed `.post-doc` to match that proven-safe convention.
 *
 * 2. **Dropped JS-dependent chrome.** The preset's own `<script>` builds the
 *    TOC list, the reading-progress bar, the image lightbox, the share-link
 *    hrefs and the light/dark toggle client-side, at load — but per the
 *    console's own publishing guidance, `<script>` never executes on the
 *    live site. Reusing that markup here would ship a permanently-empty TOC,
 *    dead share icons and a non-functional toggle. So: no header/nav/toggle
 *    (that's the site's own chrome, not part of a post body anyway), no
 *    `.share` sidebar, no lightbox, no hero image (the site already renders
 *    `coverImageUrl` as its own hero above `.post-doc` — see simple.ts), no
 *    "latest posts" strip (no data source for one from a single tool call),
 *    no `.cta-card` (a "Subscribe" button with no working submit handler is
 *    worse than no button). The `.toc` sidebar IS kept, but built statically
 *    by `composeRicherBody` from the body's own `<h2 id="...">` headings —
 *    the same content the client script would have read, just resolved at
 *    compose time instead of load time.
 */
const RICHER_CSS = `
.post-doc{
  --bg:#f5f8fd; --surface:#ffffff; --surface-2:#ffffff;
  --line:rgba(24,52,105,.13); --line-2:rgba(24,52,105,.24);
  --ink:#0b1430; --body:#33425f; --mute:#5a6b8c; --dim:#8291ad;
  --accent:#0a7ea3; --blue:#3b63e8; --purple:#7c3fe4;
  --up:#0a8f5f; --down:#c53a4e; --amber:#b06a00;
  --shadow:0 1px 2px rgba(16,34,70,.05), 0 8px 24px rgba(16,34,70,.05);
  --shadow-hi:0 2px 4px rgba(16,34,70,.06), 0 14px 38px rgba(16,34,70,.08);
}
.post-doc, .post-doc *{box-sizing:border-box}
.post-doc{margin:0;background:var(--bg);color:var(--ink);
  font:400 16px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif}
.post-doc .num{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
.post-doc .wrap{max-width:1180px;margin:0 auto;padding:0 22px}
.post-doc a{color:inherit;text-decoration:none}
.post-doc :focus-visible{outline:2px solid var(--blue);outline-offset:3px;border-radius:4px}

.post-doc .art-head{padding:24px 0 32px;border-bottom:1px solid var(--line)}
.post-doc .eyebrow{font:600 12px/1 ui-monospace,monospace;letter-spacing:.22em;text-transform:uppercase;color:var(--purple)}
.post-doc h1{font-size:clamp(29px,4.6vw,46px);line-height:1.1;letter-spacing:-.025em;margin:16px 0;font-weight:700;max-width:22ch}
.post-doc .dek{font-size:18.5px;color:var(--mute);max-width:64ch;margin:0}
.post-doc .chips{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0 0}
.post-doc .chip{padding:6px 12px;border:1px solid var(--line-2);border-radius:999px;font-size:12.5px;color:var(--mute)}
.post-doc .meta{display:flex;align-items:center;gap:11px;margin-top:22px;font-size:13.5px;color:var(--dim);flex-wrap:wrap}
.post-doc .avatar{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font:700 12px/1 inherit;
  color:#fff;background:linear-gradient(135deg,var(--blue),var(--purple))}
.post-doc .meta b{color:var(--ink);font-weight:600}
.post-doc .meta .sep{width:3px;height:3px;border-radius:50%;background:var(--line-2)}

.post-doc .layout{display:grid;grid-template-columns:minmax(0,1fr) 232px;gap:38px;padding:38px 0 10px;align-items:start}
@media(max-width:1040px){.post-doc .layout{grid-template-columns:1fr}.post-doc .toc{display:none}}

.post-doc .toc{position:sticky;top:24px}
.post-doc .toc h4{margin:0 0 12px;font:600 11px/1 ui-monospace,monospace;letter-spacing:.18em;text-transform:uppercase;color:var(--dim)}
.post-doc .toc ol{list-style:none;margin:0;padding:0;border-left:1px solid var(--line)}
.post-doc .toc li a{display:block;padding:8px 0 8px 15px;margin-left:-1px;border-left:2px solid transparent;
  font-size:13.5px;line-height:1.35;color:var(--mute)}
.post-doc .toc li a:hover{color:var(--ink)}

.post-doc .post-body{max-width:70ch;font-size:17px;line-height:1.75;color:var(--body)}
.post-doc .post-body>*:first-child{margin-top:0}
.post-doc .post-body h2{font-size:26px;line-height:1.25;letter-spacing:-.015em;color:var(--ink);margin:44px 0 14px;scroll-margin-top:24px}
.post-doc .post-body h3{font-size:19.5px;line-height:1.35;color:var(--ink);margin:32px 0 10px;scroll-margin-top:24px}
.post-doc .post-body h2+h3{margin-top:20px}
.post-doc .post-body p{margin:0 0 18px}
.post-doc .post-body a{color:var(--blue);text-decoration:underline;text-underline-offset:3px}
.post-doc .post-body strong{color:var(--ink)}
.post-doc .post-body ul,.post-doc .post-body ol{margin:0 0 20px;padding-left:22px}
.post-doc .post-body li{margin:9px 0}
.post-doc .post-body li::marker{color:var(--blue)}
.post-doc .post-body img{max-width:100%;height:auto;border-radius:12px;border:1px solid var(--line);margin:8px 0 20px}
.post-doc .post-body hr{border:0;border-top:1px solid var(--line);margin:34px 0}
.post-doc .post-body blockquote{margin:26px 0;padding:2px 0 2px 20px;border-left:2px solid var(--purple);color:var(--mute);font-size:16.5px}
.post-doc .post-body .t-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 0 22px}
.post-doc .post-body table{width:100%;border-collapse:collapse;font-size:14.5px;margin:8px 0 22px;min-width:460px}
.post-doc .post-body th,.post-doc .post-body td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:right}
.post-doc .post-body th:first-child,.post-doc .post-body td:first-child{text-align:left;color:var(--mute);font-weight:500}
.post-doc .post-body thead th{font:600 11px/1 ui-monospace,monospace;letter-spacing:.13em;text-transform:uppercase;color:var(--mute);border-bottom:1px solid var(--line-2)}
.post-doc .up{color:var(--up)}.post-doc .down{color:var(--down)}

.post-doc .figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line);
  border:1px solid var(--line);border-radius:13px;overflow:hidden;margin:8px 0 26px;box-shadow:var(--shadow)}
.post-doc .figs div{background:var(--surface-2);padding:16px 16px 14px}
.post-doc .figs .l{font:600 10.5px/1 ui-monospace,monospace;letter-spacing:.15em;text-transform:uppercase;color:var(--mute)}
.post-doc .figs .v{font-size:24px;font-weight:700;color:var(--ink);margin:8px 0 4px}
.post-doc .figs .s{font-size:12.5px;color:var(--dim)}

.post-doc .callout{border:1px solid var(--line);border-left:2px solid var(--blue);border-radius:0 12px 12px 0;
  background:var(--surface);padding:18px 20px;margin:26px 0;font-size:15.5px;color:var(--mute);box-shadow:var(--shadow)}
.post-doc .callout b{color:var(--ink)}
.post-doc .disclaimer{margin:40px 0 0;padding:18px 20px;border:1px dashed var(--line-2);border-radius:12px;
  font-size:13px;line-height:1.6;color:var(--dim)}
.post-doc .disclaimer b{color:var(--mute)}

.post-doc .faq{margin:46px 0 0;max-width:70ch}
.post-doc .faq h2{font-size:24px;margin:0 0 16px;letter-spacing:-.015em}
.post-doc details{border-top:1px solid var(--line)}
.post-doc details:last-of-type{border-bottom:1px solid var(--line)}
.post-doc summary{cursor:pointer;list-style:none;padding:16px 34px 16px 0;position:relative;font-weight:600;font-size:16px;color:var(--ink)}
.post-doc summary::-webkit-details-marker{display:none}
.post-doc summary::after{content:"+";position:absolute;right:6px;top:14px;font:400 22px/1 inherit;color:var(--blue)}
.post-doc details[open] summary::after{content:"–"}
.post-doc details p{margin:0 0 18px;color:var(--mute);font-size:15.5px;max-width:66ch}
`;

export const RICHER_THEME: BlogTheme = {
  css: [RICHER_CSS],
  links: [],
  scripts: [],
  inlineScripts: [],
};

export const RICHER_STYLE_CLASSES = [
  ".art-head (.eyebrow, h1, .dek, .chips>.chip, .meta>.avatar)",
  ".post-body (h2, h3, p, ul/ol, blockquote, img, hr, table+.t-scroll, .up/.down)",
  ".figs (a 2-4up stat grid: div > .l label, .v value, .s sub-label)",
  ".callout",
  ".disclaimer",
  ".faq > <details><summary>...</summary><p>...</p></details> (native accordion, no JS needed)",
];

export const RICHER_DEAD_FEATURES = [
  "hero image markup (the site renders heroImageUrl separately — do not add your own <img> hero)",
  ".share sidebar / share icons (client-script only, removed)",
  "reading-progress bar / #themeBtn light-dark toggle (client-script only, removed)",
  "image lightbox (client-script only, removed)",
  ".cta-card / .latest posts strip (no working submit handler / no data source, removed)",
];

function extractHeadings(
  bodyHtml: string,
): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  const re = /<h2\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyHtml))) {
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    if (text) out.push({ id: m[1], text });
  }
  return out;
}

/**
 * Wraps the agent's own `.post-body`-scoped content (with real `<h2
 * id="...">` anchors) in the art-head masthead and a statically-built TOC
 * sidebar, producing the `<body>` fragment `composeDocument()` then wraps in
 * `<style>`.
 */
export function composeRicherBody(input: BlogComposeInput): string {
  const metaParts: string[] = [];
  if (input.author) {
    const initials = input.author
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join("");
    metaParts.push(
      `<span class="avatar">${esc(initials)}</span><b>${esc(input.author)}</b>`,
    );
  }
  if (input.read)
    metaParts.push(
      `${input.author ? '<span class="sep"></span>' : ""}${esc(input.read)}`,
    );
  const meta = metaParts.length
    ? `<div class="meta">${metaParts.join("")}</div>`
    : "";

  const headings = extractHeadings(input.bodyHtml);
  const article = `<article><div class="post-body">
${input.bodyHtml}
</div></article>`;
  const body = headings.length
    ? `<div class="layout">
    ${article}
    <aside class="toc" aria-label="On this page">
      <h4>On this page</h4>
      <ol>${headings.map((h) => `<li><a href="#${esc(h.id)}">${h.text}</a></li>`).join("")}</ol>
    </aside>
  </div>`
    : article;

  return `<div class="wrap">
  <div class="art-head">
    <div class="eyebrow">${esc(input.kick || "MARKETCATALYST")}</div>
    <h1>${esc(input.title)}</h1>
    <p class="dek">${esc(input.dek)}</p>
    ${meta}
  </div>
  ${body}
</div>`;
}
