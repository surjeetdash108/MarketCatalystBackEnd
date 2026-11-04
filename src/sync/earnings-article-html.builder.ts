/**
 * Builder for MarketCatalyst Earnings Articles conforming strictly to the
 * marketcatalyst-earnings-article skill specification.
 *
 * Emits:
 * 1. bodyHtml: Content matching the house format (JSON-LD, lede, stat-strip,
 *    scorecard, "By our calculation", industry bullets, profit/outlook, watch, sources,
 *    style, related cards, and disclaimer).
 * 2. fullPageHtml: Standalone preview document ready for browser rendering or download.
 */

export interface EarningsScorecardRow {
  parameter: string; // e.g. "Adjusted EPS", "Revenue"
  expected: string; // e.g. "$1.65", "$104.80B"
  actual: string; // e.g. "$2.09", "$108.40B"
  beatMissText: string; // e.g. "Beat by 27%", "Miss by 3.5%", "In line"
  beatMissClass?: "pos" | "dn" | "";
}

export interface EarningsChangeRow {
  metric: string; // "Adjusted EPS", "Revenue"
  yoyText: string | null; // "&#9650; 31%" or "&#9660; 19%"
  yoyClass: "pos" | "dn" | "";
  qoqText?: string | null; // "&#9650; 14%" or null
  qoqClass?: "pos" | "dn" | "";
}

export interface EarningsStatBox {
  num: string;
  label: string;
  color: "#1E8449" | "#C0392B" | "#2563EB"; // Green | Red | Blue
}

export interface RelatedCard {
  pill: "News" | "Earnings" | "Research" | "Recap";
  title: string;
  /** Short link text for the "Related coverage" sentence, e.g. the company name. */
  linkText?: string;
  url: string;
  readTime: string;
}

export interface EarningsArticleInput {
  company: string;
  ticker: string;
  period: string; // e.g. "Q3 2026" or "fiscal Q4 2026"
  priorPeriod?: string; // e.g. "Q2 2026"
  announcedDateFormatted: string; // e.g. "Nov. 4, 2026"
  announcedIsoDate: string; // e.g. "2026-11-04T12:00:00-05:00"
  /** Set on a later edit; datePublished stays announcedIsoDate (skill §7). */
  modifiedIsoDate?: string;
  slug: string;
  stripCode: string; // e.g. "ubr", "emr", "khc"

  // Metadata
  title: string;
  dek: string;
  metaDescription: string;
  readTime: string; // e.g. "4 min read"

  // Body Content
  lede: string; // Two sentences, <=60 words
  /** "Shares fell 7.0% in after-hours trading as of 4:40 p.m. ET, …" — only with a time (skill rule 7). */
  stockMove?: string | null;
  /** Colour of the share-move callout: green up, red down. */
  stockMoveTone?: "pos" | "dn";
  statBoxes: [EarningsStatBox, EarningsStatBox, EarningsStatBox];
  scorecardRows: EarningsScorecardRow[];
  changeRows: EarningsChangeRow[];
  hasQoq?: boolean;
  /** false drops the YoY column (no verified year-ago quarter). */
  hasYoy?: boolean;
  /** Empty or absent leaves the paragraph out. */
  byOurCalculation?: string; // Paragraph starting with "By our calculation,"
  industrySections: Array<{
    title: string;
    bullets: Array<{
      label: string;
      text: string;
    }>;
  }>;
  /** Left out of the page when it has no bullets — a section is complete or absent. */
  profitOutlookSection?: {
    title?: string;
    bullets: Array<{
      label: string;
      text: string;
    }>;
  };
  whatToWatchBullets: Array<{
    label: string;
    text: string;
  }>;
  sourcesText: string;
  relatedCards: [RelatedCard, RelatedCard, RelatedCard, RelatedCard];
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function buildEarningsJsonLd(input: EarningsArticleInput): string {
  const data = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: input.title,
    description: input.metaDescription,
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": `https://marketcatalyst.ai/posts/${input.slug}`,
    },
    about: {
      "@type": "Corporation",
      name: input.company,
      tickerSymbol: input.ticker,
    },
    image: "https://marketcatalyst.ai/og-image.jpg",
    author: {
      "@type": "Organization",
      name: "MarketCatalyst",
    },
    publisher: {
      "@type": "Organization",
      name: "MarketCatalyst",
      logo: {
        "@type": "ImageObject",
        url: "https://marketcatalyst.ai/logo-mark.webp",
      },
    },
    datePublished: input.announcedIsoDate,
    dateModified: input.modifiedIsoDate ?? input.announcedIsoDate,
  };
  return JSON.stringify(data, null, 2);
}

export function buildEarningsBodyHtml(input: EarningsArticleInput): string {
  const jsonLd = buildEarningsJsonLd(input);

  const statBoxesHtml = input.statBoxes
    .map(
      (b) =>
        `  <div class="stat-box"><div class="num">${esc(b.num)}</div><div class="label">${esc(b.label)}</div></div>`,
    )
    .join("\n");

  const scorecardRowsHtml = input.scorecardRows
    .map((r) => {
      const cls = r.beatMissClass ? ` class="${r.beatMissClass}"` : "";
      return `    <tr><td class="metric">${esc(r.parameter)}</td><td>${esc(r.expected)}</td><td>${esc(r.actual)}</td><td${cls}>${esc(r.beatMissText)}</td></tr>`;
    })
    .join("\n");

  // A column is shown only when every row has it, so no cell is ever blank.
  const hasQoq = input.hasQoq !== false && input.changeRows.length > 0 && input.changeRows.every((r) => r.qoqText != null);
  const hasYoy = input.hasYoy !== false && input.changeRows.length > 0 && input.changeRows.every((r) => r.yoyText != null);
  const changeRowsHtml = input.changeRows
    .map((r) => {
      const yoyTd = hasYoy ? `<td${r.yoyClass ? ` class="${r.yoyClass}"` : ""}>${r.yoyText}</td>` : "";
      const qoqTd = hasQoq ? `<td${r.qoqClass ? ` class="${r.qoqClass}"` : ""}>${r.qoqText}</td>` : "";
      return `    <tr><td class="metric">${esc(r.metric)}</td>${yoyTd}${qoqTd}</tr>`;
    })
    .join("\n");
  const changeGridHtml =
    hasYoy || hasQoq
      ? `<div class="yoy-wrap">
<div class="table-scroll"><div class="post-doc-scroll">
<table>
  <thead><tr><th>Change</th>${hasYoy ? "<th>YoY</th>" : ""}${hasQoq ? "<th>QoQ</th>" : ""}</tr></thead>
  <tbody>
${changeRowsHtml}
  </tbody>
</table>
</div></div>
</div>`
      : "";
  const scorecardHtml = input.scorecardRows.length
    ? `<h2 id="scorecard">${esc(input.period)} scorecard</h2>
<div class="table-scroll"><div class="post-doc-scroll">
<table>
  <thead><tr><th>Parameters</th><th>Expected</th><th>Actual</th><th>Beat/Miss</th></tr></thead>
  <tbody>
${scorecardRowsHtml}
  </tbody>
</table>
</div></div>`
    : "";

  const industrySectionsHtml = input.industrySections
    .filter((sec) => sec.bullets.length > 0)
    .map((sec, i) => {
      const bulletsHtml = sec.bullets
        .map((b) => `  <li><b>${esc(b.label)}.</b> ${esc(b.text)}</li>`)
        .join("\n");
      return `<h2 id="sec${i + 1}">${esc(sec.title)}</h2>\n<ul>\n${bulletsHtml}\n</ul>`;
    })
    .join("\n\n");

  const profitBullets = input.profitOutlookSection?.bullets ?? [];
  const profitHtml = profitBullets.length
    ? `<h2 id="profit">${esc(input.profitOutlookSection?.title || "Profit, cash flow and outlook")}</h2>\n<ul>\n${profitBullets
        .map((b) => `  <li><b>${esc(b.label)}.</b> ${esc(b.text)}</li>`)
        .join("\n")}\n</ul>`
    : "";

  const watchBulletsHtml = input.whatToWatchBullets
    .map((b) => `  <li><b>${esc(b.label)}.</b> ${esc(b.text)}</li>`)
    .join("\n");

  const relatedCardsHtml = input.relatedCards
    .map(
      (c) => `    <a class="mc-ra-card" href="${esc(c.url)}">
      <span class="mc-ra-pill">${esc(c.pill)}</span>
      <h3 class="mc-ra-card-title">${esc(c.title)}</h3>
      <div class="mc-ra-meta"><span>${esc(c.readTime)}</span><span class="mc-ra-go">Read &rarr;</span></div>
    </a>`,
    )
    .join("\n");

  const links = input.relatedCards.map(
    (c) => `<a href="${esc(c.url)}">${esc(c.linkText ?? c.title.split(":")[0].trim())}</a>`,
  );
  const relatedLinksSentence =
    links.length > 1 ? `${links.slice(0, -1).join(", ")} and ${links[links.length - 1]}` : links.join("");

  return `<script type="application/ld+json">
${jsonLd}
</script>

<p>${esc(input.lede)}</p>
${input.stockMove ? `\n<p class="stock-move">${esc(input.stockMove)}</p>\n` : ""}
<div class="stat-strip" id="${input.stripCode}-strip">
${statBoxesHtml}
</div>

${scorecardHtml}
${changeGridHtml}
${input.byOurCalculation ? `<p>${esc(input.byOurCalculation)}</p>` : ""}

${industrySectionsHtml}

${profitHtml}

<h2 id="watch">What to watch</h2>
<ul>
${watchBulletsHtml}
  <li><b>Related coverage.</b> See our reports on ${relatedLinksSentence}.</li>
</ul>

<p><b>Sources:</b> ${esc(input.sourcesText)}</p>

<style>
  .post-doc .meta { margin-bottom: 14px !important; }
  .post-doc hr.rule { margin: 0 0 22px !important; }
  .post-doc td.dn { color: #C0392B; font-weight: 700; }
  .post-doc td.pos { color: #1E8449; font-weight: 700; }
  .post-doc .yoy-wrap { margin-top: 32px; margin-bottom: 8px; }
${input.stockMove ? `  .post-doc .stock-move { margin: 4px 0 22px; padding: 10px 14px; background: ${input.stockMoveTone === "pos" ? "#EEF7F1" : "#FDF2F0"}; border-left: 4px solid ${input.stockMoveTone === "pos" ? "#1E8449" : "#C0392B"}; border-radius: 6px; }\n` : ""}  #${input.stripCode}-strip .stat-box:nth-child(1) .num { color: ${input.statBoxes[0].color} !important; }
  #${input.stripCode}-strip .stat-box:nth-child(2) .num { color: ${input.statBoxes[1].color} !important; }
  #${input.stripCode}-strip .stat-box:nth-child(3) .num { color: ${input.statBoxes[2].color} !important; }
  .mc-ra { margin: 40px 0 8px; padding-top: 24px; border-top: 1px solid var(--border, #E4DFD3); }
  section.mc-ra h2.mc-ra-title { font-size: 20px; font-weight: 800; letter-spacing: -0.2px; line-height: 1.25; margin: 0 0 14px; color: var(--ink, #1A1A1A); }
  .mc-ra .mc-ra-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) !important; gap: 10px; }
  .mc-ra .mc-ra-card { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; background: #F7F5EF; border: 1px solid var(--border, #E4DFD3); border-radius: 12px; text-decoration: none; color: inherit; transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease; }
  .mc-ra .mc-ra-card:hover, .mc-ra .mc-ra-card:focus-visible { transform: translateY(-2px); border-color: var(--blue, #2563EB); box-shadow: 0 6px 16px rgba(37, 99, 235, 0.10); outline: none; }
  .mc-ra .mc-ra-pill { align-self: flex-start; font-size: 10px; font-weight: 800; letter-spacing: 0.8px; text-transform: uppercase; color: var(--blue, #2563EB); background: #EFF6FF; border: 1px solid #BFDBFE; border-radius: 999px; padding: 2px 8px; }
  .mc-ra .mc-ra-card-title { font-size: 13.5px; font-weight: 800; line-height: 1.35; color: var(--ink, #1A1A1A); margin: 0; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .mc-ra .mc-ra-meta { display: flex; justify-content: space-between; align-items: center; margin-top: auto; font-size: 12px; color: var(--gray-text, #5B6472); }
  .mc-ra .mc-ra-go { font-weight: 800; color: var(--blue, #2563EB); }
  @media (max-width: 720px) { .mc-ra .mc-ra-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; } .mc-ra .mc-ra-card { padding: 10px 11px; } .mc-ra .mc-ra-card-title { font-size: 12.5px; -webkit-line-clamp: 5; } }
  @media (max-width: 340px) { .mc-ra .mc-ra-grid { grid-template-columns: minmax(0, 1fr) !important; } }
</style>
<section class="mc-ra" aria-labelledby="mc-ra-heading">
  <h2 class="mc-ra-title" id="mc-ra-heading">Readers also read</h2>
  <div class="mc-ra-grid">
${relatedCardsHtml}
  </div>
</section>

<div class="disclaimer"><p><a href="https://marketcatalyst.ai/">MarketCatalyst</a> is not a registered investment advisor and does not manage client assets. Content on this platform is provided for informational and educational purposes only. It is not investment advice, and MarketCatalyst is not a stock-picking or trade-alert service. Trading stocks and options involves risk, including the possible loss of principal. Consider your own goals, time horizon, and risk tolerance, and consult a qualified financial advisor before making any investment decision.</p></div>`;
}

export function buildFullPageHtml(input: EarningsArticleInput): string {
  const bodyHtml = buildEarningsBodyHtml(input);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(input.title)} | MarketCatalyst</title>
<meta name="description" content="${esc(input.metaDescription)}" />
<style>
:where(.post-doc), :where(.post-doc *), :where(.post-doc *::before), :where(.post-doc *::after) { box-sizing: border-box; }
:where(.post-doc) { width: 100%; margin: 0; }
:where(.post-doc img), :where(.post-doc svg), :where(.post-doc video) { max-width: 100%; height: auto; }
:where(.post-doc pre) { overflow-x: auto; }
:where(.post-doc table) { border-collapse: collapse; }
:where(.post-doc) .post-doc-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; }

.post-doc {
  --cream: #F3EFE7;
  --white: #FFFFFF;
  --ink: #1A1A1A;
  --gray-text: #5B6472;
  --blue: #2563EB;
  --border: #E4DFD3;
  --pill-border: #D9D3C4;
  --green: #1E8449;
  --red: #C0392B;
  margin: 0;
  background: var(--cream);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
}
.post-doc main {
  max-width: 900px;
  margin: 0 auto;
  padding: 32px 20px 80px;
}
.post-doc .card {
  background: var(--white);
  border-radius: 24px;
  padding: 56px 64px 48px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}
.post-doc .eyebrow {
  color: var(--blue);
  font-weight: 800;
  letter-spacing: 1.5px;
  font-size: 13px;
  margin-bottom: 16px;
  text-transform: uppercase;
}
.post-doc h1 {
  font-size: clamp(28px, 4vw, 42px);
  line-height: 1.15;
  font-weight: 800;
  margin: 0 0 20px;
  letter-spacing: -0.5px;
  color: var(--ink);
}
.post-doc .subtitle {
  color: var(--gray-text);
  font-size: clamp(17px, 2vw, 19px);
  line-height: 1.5;
  margin: 0 0 20px;
  max-width: 720px;
}
.post-doc .meta {
  color: #8A8F98;
  font-size: 14px;
  margin-bottom: 24px;
}
.post-doc hr.rule {
  border: none;
  border-top: 1px solid var(--border);
  margin: 0 0 32px;
}
.post-doc .article p {
  font-size: 17px;
  line-height: 1.7;
  color: #2B2F36;
  margin: 0 0 20px;
}
.post-doc .article h2 {
  font-size: 24px;
  font-weight: 800;
  margin: 36px 0 16px;
  letter-spacing: -0.3px;
  color: var(--ink);
}
.post-doc .stat-strip {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin: 12px 0 32px;
}
.post-doc .stat-box {
  background: #F7F5EF;
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 20px 16px;
  text-align: center;
}
.post-doc .stat-box .num {
  font-size: 28px;
  font-weight: 800;
  line-height: 1.1;
}
.post-doc .stat-box .label {
  font-size: 13px;
  color: var(--gray-text);
  margin-top: 6px;
  line-height: 1.35;
}
.post-doc table {
  width: 100%;
  border-collapse: collapse;
  margin: 16px 0 24px;
  font-size: 15px;
}
.post-doc th {
  text-align: left;
  font-weight: 700;
  padding: 10px 12px;
  border-bottom: 2px solid var(--border);
  color: var(--gray-text);
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.post-doc td {
  padding: 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.post-doc td.metric { font-weight: 700; color: var(--ink); }
.post-doc td.pos { color: #1E8449; font-weight: 700; }
.post-doc td.dn { color: #C0392B; font-weight: 700; }
.post-doc .yoy-wrap { margin-top: 32px; margin-bottom: 8px; }
.post-doc ul {
  margin: 0 0 24px;
  padding-left: 20px;
}
.post-doc li {
  font-size: 17px;
  line-height: 1.7;
  color: #2B2F36;
  margin-bottom: 12px;
}
.post-doc .disclaimer {
  margin-top: 40px;
  padding-top: 20px;
  border-top: 1px solid var(--border);
}
.post-doc .disclaimer p {
  font-size: 13px;
  line-height: 1.6;
  color: #8A8F98;
  margin: 0;
}
.post-doc .disclaimer a {
  color: var(--blue);
  text-decoration: none;
}
@media (max-width: 640px) {
  .post-doc .card { padding: 32px 20px; border-radius: 16px; }
  .post-doc .stat-strip { grid-template-columns: 1fr; }
  .post-doc table { font-size: 13px; }
  .post-doc th, .post-doc td { padding: 8px 6px; }
}
</style>
</head>
<body class="post-doc">
<main>
  <div class="card">
    <div class="card-body">
      <div class="eyebrow">Earnings</div>
      <h1>${esc(input.title)}</h1>
      <p class="subtitle">${esc(input.dek)}</p>
      <div class="meta"><span>Published ${esc(input.announcedDateFormatted)} · 12:00 PM ET · ${esc(input.readTime)}</span></div>
      <hr class="rule" />
      <div class="article">
${bodyHtml}
      </div>
    </div>
  </div>
</main>
</body>
</html>`;
}

export interface TodayEarningsSummaryItem {
  ticker: string;
  companyName: string;
  period: string;
  epsActual: number | null;
  epsEstimate: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
  epsVerdict: "Beat" | "Miss" | "In line" | "—";
  revVerdict: "Beat" | "Miss" | "In line" | "—";
  articleFilename?: string;
  yoyRevenueGrowth?: string | null;
}

export function buildTodayEarningsDigestHtml(params: {
  targetDate: string;
  formattedDate: string;
  items: TodayEarningsSummaryItem[];
}): string {
  const totalReporters = params.items.length;
  const epsBeats = params.items.filter((i) => i.epsVerdict === "Beat").length;
  const revBeats = params.items.filter((i) => i.revVerdict === "Beat").length;
  const beatRate = totalReporters > 0 ? Math.round((epsBeats / totalReporters) * 100) : 0;

  const fmtB = (val: number | null) => {
    if (val == null) return "—";
    if (Math.abs(val) >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
    if (Math.abs(val) >= 1e6) return `$${(val / 1e6).toFixed(1)}M`;
    return `$${val.toLocaleString()}`;
  };

  const fmtEps = (val: number | null) => (val == null ? "—" : `$${val.toFixed(2)}`);

  const rowsHtml = params.items
    .map((item) => {
      const epsCls = item.epsVerdict === "Beat" ? "pos" : item.epsVerdict === "Miss" ? "dn" : "";
      const revCls = item.revVerdict === "Beat" ? "pos" : item.revVerdict === "Miss" ? "dn" : "";
      const articleLink = item.articleFilename
        ? `<a href="./${esc(item.articleFilename)}" class="view-btn">Read Article &rarr;</a>`
        : "—";

      return `<tr data-ticker="${esc(item.ticker)}" data-name="${esc(item.companyName.toLowerCase())}">
  <td class="metric"><strong>${esc(item.ticker)}</strong><br><span class="comp-name">${esc(item.companyName)}</span></td>
  <td>${esc(item.period)}</td>
  <td>
    ${fmtEps(item.epsActual)} <span class="est">vs ${fmtEps(item.epsEstimate)}</span>
    ${item.epsVerdict !== "—" ? `<span class="badge ${epsCls}">${esc(item.epsVerdict)}</span>` : ""}
  </td>
  <td>
    ${fmtB(item.revenueActual)} <span class="est">vs ${fmtB(item.revenueEstimate)}</span>
    ${item.revVerdict !== "—" ? `<span class="badge ${revCls}">${esc(item.revVerdict)}</span>` : ""}
  </td>
  <td>${esc(item.yoyRevenueGrowth ?? "—")}</td>
  <td style="text-align:right;">${articleLink}</td>
</tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Today's Earnings Results (${esc(params.formattedDate)}) | MarketCatalyst</title>
<meta name="description" content="Complete quarterly earnings results and analysis for all ${totalReporters} companies reporting on ${esc(params.formattedDate)}." />
<style>
:where(.post-doc), :where(.post-doc *), :where(.post-doc *::before), :where(.post-doc *::after) { box-sizing: border-box; }
.post-doc {
  --cream: #F3EFE7;
  --white: #FFFFFF;
  --ink: #1A1A1A;
  --gray-text: #5B6472;
  --blue: #2563EB;
  --border: #E4DFD3;
  --green: #1E8449;
  --red: #C0392B;
  margin: 0;
  background: var(--cream);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
}
.post-doc main { max-width: 1100px; margin: 0 auto; padding: 32px 20px 80px; }
.post-doc .card { background: var(--white); border-radius: 24px; padding: 48px 56px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
.post-doc .eyebrow { color: var(--blue); font-weight: 800; letter-spacing: 1.5px; font-size: 13px; margin-bottom: 16px; text-transform: uppercase; }
.post-doc h1 { font-size: clamp(28px, 4vw, 38px); line-height: 1.2; font-weight: 800; margin: 0 0 16px; letter-spacing: -0.5px; color: var(--ink); }
.post-doc .subtitle { color: var(--gray-text); font-size: 17px; line-height: 1.5; margin: 0 0 24px; }
.post-doc hr.rule { border: none; border-top: 1px solid var(--border); margin: 0 0 32px; }

.stat-strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 12px 0 32px; }
.stat-box { background: #F7F5EF; border: 1px solid var(--border); border-radius: 14px; padding: 20px 16px; text-align: center; }
.stat-box .num { font-size: 32px; font-weight: 800; line-height: 1.1; color: var(--blue); }
.stat-box .label { font-size: 13px; color: var(--gray-text); margin-top: 6px; }

.filter-bar { margin: 24px 0 16px; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.search-input { flex: 1; max-width: 400px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 10px; font-size: 15px; background: #FAF8F5; outline: none; }
.search-input:focus { border-color: var(--blue); background: #FFF; }
.table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 8px; }
th { text-align: left; font-weight: 700; padding: 12px 10px; border-bottom: 2px solid var(--border); color: var(--gray-text); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
td { padding: 12px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
td.metric { color: var(--ink); }
.comp-name { font-size: 12px; color: var(--gray-text); font-weight: 400; }
.est { font-size: 12px; color: #8A8F98; margin-left: 2px; }
.badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px; margin-left: 6px; }
.badge.pos { background: #E6F4EA; color: var(--green); }
.badge.dn { background: #FCE8E6; color: var(--red); }
.view-btn { display: inline-block; font-size: 13px; font-weight: 700; color: var(--blue); text-decoration: none; padding: 6px 12px; border-radius: 8px; background: #EFF6FF; border: 1px solid #BFDBFE; }
.view-btn:hover { background: #DBEAFE; }

.disclaimer { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--border); }
.disclaimer p { font-size: 13px; line-height: 1.6; color: #8A8F98; margin: 0; }
.disclaimer a { color: var(--blue); text-decoration: none; }

@media (max-width: 720px) {
  .post-doc .card { padding: 24px 16px; border-radius: 16px; }
  .stat-strip { grid-template-columns: 1fr; }
  .filter-bar { flex-direction: column; align-items: stretch; }
  .search-input { max-width: 100%; }
}
</style>
</head>
<body class="post-doc">
<main>
  <div class="card">
    <div class="eyebrow">Earnings · Daily Digest</div>
    <h1>Today's Earnings Results (${esc(params.formattedDate)})</h1>
    <p class="subtitle">Complete quarterly scorecards, beat/miss verdicts, and revenue metrics across all ${totalReporters} companies reporting results today.</p>
    
    <div class="stat-strip">
      <div class="stat-box"><div class="num">${totalReporters}</div><div class="label">Companies Reported Today</div></div>
      <div class="stat-box"><div class="num" style="color:var(--green);">${beatRate}%</div><div class="label">EPS Beat Rate (${epsBeats} Beats)</div></div>
      <div class="stat-box"><div class="num">${revBeats}</div><div class="label">Revenue Beats</div></div>
    </div>

    <div class="filter-bar">
      <input type="text" id="filter" class="search-input" placeholder="Search by ticker or company name..." onkeyup="filterTable()" />
      <span style="font-size:13px; color:var(--gray-text);"><span id="count">${totalReporters}</span> companies shown</span>
    </div>

    <div class="table-scroll">
      <table id="earnings-table">
        <thead>
          <tr>
            <th>Company</th>
            <th>Period</th>
            <th>Adjusted EPS vs. Est</th>
            <th>Revenue vs. Est</th>
            <th>YoY Growth</th>
            <th style="text-align:right;">Full Article</th>
          </tr>
        </thead>
        <tbody>
${rowsHtml}
        </tbody>
      </table>
    </div>

    <div class="disclaimer">
      <p><a href="https://marketcatalyst.ai/">MarketCatalyst</a> is not a registered investment advisor and does not manage client assets. Content on this platform is provided for informational and educational purposes only. It is not investment advice, and MarketCatalyst is not a stock-picking or trade-alert service. Trading stocks and options involves risk, including the possible loss of principal.</p>
    </div>
  </div>
</main>

<script>
function filterTable() {
  var input = document.getElementById('filter').value.toLowerCase();
  var rows = document.querySelectorAll('#earnings-table tbody tr');
  var visible = 0;
  rows.forEach(function(row) {
    var ticker = row.getAttribute('data-ticker').toLowerCase();
    var name = row.getAttribute('data-name');
    if (ticker.indexOf(input) > -1 || name.indexOf(input) > -1) {
      row.style.display = '';
      visible++;
    } else {
      row.style.display = 'none';
    }
  });
  document.getElementById('count').innerText = visible;
}
</script>
</body>
</html>`;
}

