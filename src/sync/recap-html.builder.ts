import type { RecapFacts, RecapNarrative, IndexRow, SectorRow, MoverRow } from "./recap-pdf.builder";

/**
 * The recap, as the blog's HTML article body.
 *
 * Replaces the PDF: a web page can be read on a phone, indexed by search, and
 * restyled from the shared blog theme without regenerating anything. The PDF
 * builder stays where it is — nothing here deletes it — so a document recap is
 * still one call away if it is ever wanted again.
 *
 * **The division of labour is the point.** Every number below comes from the
 * frozen snapshot; every sentence comes from the model. The model is never
 * asked what the market did, and no value it returns is printed as data. That
 * is what makes the charts trustworthy: they are drawn from `facts`, not
 * described by an LLM.
 *
 * Only the <body> is produced. The masthead (kicker, headline, standfirst,
 * dateline) is rendered by the reader's page from the post's own fields, and
 * the styling comes from the shared theme — see PostHtmlDoc on the Website.
 */

/** Which cadence this recap covers. The charts are the same; the framing is not. */
export type RecapPeriod = "daily" | "weekly" | "monthly";

const PERIOD_LABEL: Record<RecapPeriod, string> = {
  daily: "the session",
  weekly: "the week",
  monthly: "the month",
};

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const pct = (v: number | null | undefined): string =>
  v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;

const num = (v: number | null | undefined, dp = 2): string =>
  v == null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

const cls = (v: number | null | undefined): string =>
  v == null ? "flat" : v > 0 ? "up" : v < 0 ? "down" : "flat";

/**
 * A horizontal bar chart, drawn to scale from the values themselves.
 *
 * Rendered as inline SVG rather than an image so it stays sharp at any width,
 * needs no extra request, and carries its own text for search and screen
 * readers. The zero line sits where the data puts it: with only losses on the
 * board it moves to the right edge, so a 3% fall is not drawn the same length
 * as a 0.02% one.
 */
function barChart(
  title: string,
  rows: Array<{ label: string; value: number | null }>,
  caption: string,
): string {
  const data = rows.filter((r) => r.value != null) as Array<{ label: string; value: number }>;
  if (data.length === 0) return "";

  const W = 740;
  const ROW = 26;
  const TOP = 36;
  const H = TOP + data.length * ROW + 14;
  const LABEL_W = 150;
  const PLOT_L = LABEL_W + 10;
  const PLOT_R = W - 60;
  const plotW = PLOT_R - PLOT_L;

  const max = Math.max(...data.map((d) => d.value), 0);
  const min = Math.min(...data.map((d) => d.value), 0);
  const span = max - min || 1;
  // Where 0 falls inside the plot, so positive and negative share one scale.
  const zeroX = PLOT_L + ((0 - min) / span) * plotW;

  const bars = data
    .map((d, i) => {
      const y = TOP + i * ROW;
      const x = PLOT_L + ((Math.min(d.value, 0) - min) / span) * plotW;
      const w = Math.max(1.5, (Math.abs(d.value) / span) * plotW);
      const fill = d.value >= 0 ? "#00b894" : "#d63031";
      const labelX = d.value >= 0 ? x + w + 6 : x - 6;
      const anchor = d.value >= 0 ? "start" : "end";
      return (
        `<text x="14" y="${y + 12}" font-size="11" fill="#4a5568">${esc(d.label)}</text>` +
        `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="16" rx="2" fill="${fill}"/>` +
        `<text x="${labelX.toFixed(1)}" y="${y + 12}" text-anchor="${anchor}" font-size="11" font-weight="600" fill="${fill}">${pct(d.value)}</text>`
      );
    })
    .join("");

  return (
    `<div class="image-container">` +
    `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(title)}">` +
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>` +
    `<text x="14" y="22" font-size="13" font-weight="700" fill="#1a1a1a">${esc(title)}</text>` +
    `<line x1="${zeroX.toFixed(1)}" y1="${TOP - 4}" x2="${zeroX.toFixed(1)}" y2="${H - 10}" stroke="#cbd5e1" stroke-width="1"/>` +
    bars +
    `</svg>` +
    `<p class="image-caption">${esc(caption)}</p>` +
    `</div>`
  );
}

/** Breadth as a single proportion bar — advancers against decliners. */
function breadthBar(adv: number, dec: number): string {
  const total = adv + dec || 1;
  const advPct = (adv / total) * 100;
  return (
    `<div class="image-container">` +
    `<svg viewBox="0 0 740 74" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Advancers against decliners">` +
    `<rect x="0" y="0" width="740" height="74" fill="#ffffff"/>` +
    `<text x="14" y="20" font-size="13" font-weight="700" fill="#1a1a1a">Participation — advancers against decliners</text>` +
    `<rect x="14" y="32" width="712" height="22" rx="4" fill="#d63031"/>` +
    `<rect x="14" y="32" width="${((advPct / 100) * 712).toFixed(1)}" height="22" rx="4" fill="#00b894"/>` +
    `<text x="20" y="47" font-size="11" font-weight="700" fill="#ffffff">${adv.toLocaleString()} advancing</text>` +
    `<text x="720" y="47" text-anchor="end" font-size="11" font-weight="700" fill="#ffffff">${dec.toLocaleString()} declining</text>` +
    `<text x="14" y="68" font-size="10" fill="#94a3b8">${advPct.toFixed(1)}% of the moving names rose</text>` +
    `</svg>` +
    `<p class="image-caption">Breadth is what the index level does not show: a rise carried by a minority is a narrower rise. Chart: MarketCatalyst, from the session's own tallies.</p>` +
    `</div>`
  );
}

function indexTable(rows: IndexRow[]): string {
  const body = rows
    .map((r) => {
      // A proxy series tracks a different instrument, so its LEVEL is not the
      // index it is named after. The direction is real; the number is not, and
      // printing it would be stating something untrue.
      const level = r.isProxy ? `<span class="text-xs text-gray-500">proxy · direction only</span>` : num(r.value);
      return (
        `<tr><td><strong>${esc(r.label)}</strong></td>` +
        `<td class="num">${level}</td>` +
        `<td class="num ${cls(r.pctChange)}">${r.isProxy ? "—" : num(r.change)}</td>` +
        `<td class="num ${cls(r.pctChange)}">${pct(r.pctChange)}</td></tr>`
      );
    })
    .join("");
  return (
    `<div class="card mb-6" style="padding:0;overflow:hidden;">` +
    `<table><thead><tr><th>Index</th><th class="num">Level</th><th class="num">Change</th><th class="num">%</th></tr></thead>` +
    `<tbody>${body}</tbody></table></div>`
  );
}

function moverCards(rows: MoverRow[], notes: Record<string, string>): string {
  return rows
    .map(
      (m) =>
        `<div class="card">` +
        `<div class="flex justify-between items-start mb-2 flex-wrap gap-2">` +
        `<div><span class="font-bold text-lg">${esc(m.name || m.ticker)}</span>` +
        `<span class="text-sm text-gray-500 ml-2">$${esc(m.ticker)}</span></div>` +
        `<div class="text-right"><div class="font-bold">${m.price == null ? "—" : "$" + num(m.price)}</div>` +
        `<div class="${cls(m.pctChange)} text-sm">${pct(m.pctChange)}</div></div></div>` +
        (notes[m.ticker] ? `<p class="text-[0.95rem] leading-7">${esc(notes[m.ticker])}</p>` : "") +
        `</div>`,
    )
    .join("");
}

export function buildRecapHtml(
  facts: RecapFacts,
  narrative: RecapNarrative,
  period: RecapPeriod = "daily",
): string {
  const covers = PERIOD_LABEL[period];
  const out: string[] = [];

  /* ── the session in prose ───────────────────────────────────────────── */
  out.push(
    `<section class="mb-10">` +
      `<div class="kicker mb-3">${esc(covers === "the session" ? "The session in two paragraphs" : `${covers} in two paragraphs`)}</div>` +
      narrative.summary.map((p) => `<p class="text-[1.02rem] leading-8 mb-5">${esc(p)}</p>`).join("") +
      `</section><hr class="section-rule">`,
  );

  /* ── indices, with the chart beside the table ───────────────────────── */
  if (facts.indices.length) {
    out.push(
      `<section class="mb-10"><div class="kicker mb-3">Scorecard</div>` +
        `<h2 class="text-2xl font-bold mb-5">Major indices</h2>` +
        indexTable(facts.indices) +
        barChart(
          `Index performance — ${facts.date}`,
          facts.indices.map((i) => ({ label: i.label, value: i.pctChange })),
          "Drawn to scale from the closing values, so the size of each move is comparable across the board. Chart: MarketCatalyst.",
        ) +
        `</section><hr class="section-rule">`,
    );
  }

  /* ── breadth ────────────────────────────────────────────────────────── */
  const it = facts.internals;
  if (it && (it.advancers != null || it.decliners != null)) {
    const adv = it.advancers ?? 0;
    const dec = it.decliners ?? 0;
    const stat = (k: string, v: string) =>
      `<div class="card"><div class="kicker mb-3">${esc(k)}</div><div class="text-2xl font-extrabold">${esc(v)}</div></div>`;
    out.push(
      `<section class="mb-10"><div class="kicker mb-3">Internals</div>` +
        `<h2 class="text-2xl font-bold mb-5">Market breadth</h2>` +
        breadthBar(adv, dec) +
        `<div class="grid grid-cols-1 md:grid-cols-3 gap-4">` +
        stat("Advancers", adv.toLocaleString()) +
        stat("Decliners", dec.toLocaleString()) +
        stat("Net", it.netAdvancers == null ? "—" : (it.netAdvancers > 0 ? "+" : "") + it.netAdvancers.toLocaleString()) +
        `</div></section><hr class="section-rule">`,
    );
  }

  /* ── sectors ────────────────────────────────────────────────────────── */
  const sectors: SectorRow[] = [...facts.sectorLeaders, ...facts.sectorLaggards];
  if (sectors.length) {
    out.push(
      `<section class="mb-10"><div class="kicker mb-3">Rotation</div>` +
        `<h2 class="text-2xl font-bold mb-5">Sector leaders and laggards</h2>` +
        barChart(
          `Sector return — ${facts.date}`,
          sectors.map((s) => ({ label: s.sector, value: s.pctChange })),
          "Where the money went. Chart: MarketCatalyst, from sector returns at the close.",
        ) +
        `</section><hr class="section-rule">`,
    );
  }

  /* ── movers, with the model's note per ticker ───────────────────────── */
  const movers = [...facts.topGainers, ...facts.topLosers];
  if (movers.length) {
    out.push(
      `<section class="mb-10"><div class="kicker mb-3">Single stocks</div>` +
        `<h2 class="text-2xl font-bold mb-2">Notable movers</h2>` +
        `<p class="text-sm text-gray-600 mb-6">Prices are ${esc(facts.date)} closing prices.</p>` +
        `<div class="space-y-4">${moverCards(movers, narrative.moverNotes ?? {})}</div>` +
        `</section><hr class="section-rule">`,
    );
  }

  /* ── themes the model found IN the data ─────────────────────────────── */
  if (narrative.stories.length) {
    out.push(
      `<section class="mb-10"><div class="kicker mb-3">The tape</div>` +
        `<h2 class="text-2xl font-bold mb-6">What ${esc(covers)} turned on</h2>` +
        `<div class="space-y-6">` +
        narrative.stories
          .map(
            (s) =>
              `<div><h3 class="font-bold text-lg mb-2">${esc(s.title)}</h3>` +
              `<p class="text-[0.97rem] leading-7">${esc(s.body)}</p></div>`,
          )
          .join("") +
        `</div></section><hr class="section-rule">`,
    );
  }

  /* ── takeaway ───────────────────────────────────────────────────────── */
  out.push(
    `<section class="mb-10"><div class="kicker mb-3">Next</div>` +
      `<h2 class="text-2xl font-bold mb-5">Key takeaway</h2>` +
      `<div class="mistake-card"><p class="text-[0.97rem] leading-7">${esc(narrative.takeaway)}</p></div>` +
      `</section>`,
  );

  /* ── tags ───────────────────────────────────────────────────────────── */
  if (narrative.tags?.length) {
    out.push(
      `<section class="mb-10"><div class="kicker mb-4">Filed under</div><div>` +
        narrative.tags.map((t) => `<span class="tag-pill">${esc(t)}</span>`).join("") +
        `</div></section>`,
    );
  }

  /* ── disclosure ─────────────────────────────────────────────────────── */
  out.push(
    `<footer><div class="card" style="background:#f3f4f6;border-color:#e0e0e0;">` +
      `<div class="kicker mb-3">Important disclosures</div>` +
      `<p class="text-[0.82rem] leading-6 text-gray-700 mb-3">This material is published by MarketCatalyst for informational and educational purposes only. It is not investment advice, and it is not an offer or solicitation to buy or sell any security.</p>` +
      `<p class="text-[0.82rem] leading-6 text-gray-700">Figures are drawn from the ${esc(facts.date)} market snapshot held by MarketCatalyst and are believed accurate at the time of publication. Commentary is generated from those figures and reviewed before publishing. Past performance does not guarantee future results.</p>` +
      `</div></footer>`,
  );

  return out.join("\n");
}
