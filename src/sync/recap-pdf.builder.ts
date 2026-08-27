import PDFDocument from "pdfkit";

/**
 * Renders the daily recap as a PDF.
 *
 * A fixed template rather than a rendered web page: turning HTML into PDF needs
 * a real browser, and shipping Chromium would put ~300 MB and a cold-start
 * penalty on a worker that is deliberately scaled to zero. Laying the document
 * out here costs nothing at runtime and makes every day's recap identical in
 * shape, which a model-authored page would not be.
 *
 * The split that matters: every NUMBER on the page comes from `facts`, which is
 * the frozen `recaps/{date}` snapshot of synced market data. The model supplies
 * only prose — headline, summary, the reason a stock moved, the takeaway. It is
 * never asked for a price, and nothing it returns is used as one.
 *
 * Fonts are the PDF base-14 (Helvetica), so nothing is embedded and no font
 * files ship with the container. The reader's pdf.js already carries the
 * standard-font data needed to draw them.
 */

/** Brand palette, from the recap prompt's design spec. */
const INK = "#1a1a1a";
const MUTED = "#666666";
const BLUE = "#0984e3";
const GREEN = "#00b894";
const RED = "#d63031";
const RULE = "#e2e8f0";
const CALLOUT_BG = "#f0fff4";
const BAND = "#f5f7fa";

const PAGE = { width: 612, height: 792 };
const MARGIN = 54;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;

export type IndexRow = {
  label: string;
  value: number | null;
  change: number | null;
  pctChange: number | null;
  isProxy?: boolean;
  proxyTicker?: string | null;
};
export type MoverRow = {
  ticker: string;
  name: string;
  price: number | null;
  pctChange: number | null;
};
export type SectorRow = { sector: string; pctChange: number | null };
export type Internals = {
  advancers: number | null;
  decliners: number | null;
  netAdvancers: number | null;
  breadthPct: number | null;
  trin: number | null;
  mcclellan: number | null;
  upVolume: number | null;
  downVolume: number | null;
} | null;

export type RecapFacts = {
  date: string;
  indices: IndexRow[];
  topGainers: MoverRow[];
  topLosers: MoverRow[];
  sectorLeaders: SectorRow[];
  sectorLaggards: SectorRow[];
  internals: Internals;
  /** market_sentiment/fear_greed, when it has been synced for the day. */
  sentiment: { value: number | null; label: string | null } | null;
};

/** Everything the model is allowed to contribute. Prose only — never figures. */
export type RecapNarrative = {
  headline: string;
  summary: string[];
  /** ticker → why it moved, or an explicit "no confirmed catalyst". */
  moverNotes: Record<string, string>;
  stories: { title: string; body: string }[];
  takeaway: string;
  tags: string[];
};

export type BuiltPdf = { buffer: Buffer; pages: number; aspect: number };

// ── formatting ──────────────────────────────────────────────────────────────

function num(v: number | null | undefined, digits = 2): string {
  return v == null || !Number.isFinite(v)
    ? "—"
    : v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function signed(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return (v >= 0 ? "+" : "") + num(v, digits);
}

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
}

/** Gains green, losses red, unknown grey — never green by default. */
function tone(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return MUTED;
  return v >= 0 ? GREEN : RED;
}

function longDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", {
        weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
      });
}

// ── layout primitives ───────────────────────────────────────────────────────

type Doc = PDFKit.PDFDocument;

/** Starts a new page when `needed` points would run past the bottom margin. */
function ensure(doc: Doc, needed: number): void {
  if (doc.y + needed > PAGE.height - MARGIN) doc.addPage();
}

function sectionTitle(doc: Doc, text: string): void {
  ensure(doc, 46);
  doc.moveDown(0.8);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(13).text(text, MARGIN, doc.y);
  const y = doc.y + 4;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_WIDTH, y).lineWidth(0.8).strokeColor(RULE).stroke();
  doc.y = y + 10;
}

function paragraph(doc: Doc, text: string, opts: { size?: number; color?: string } = {}): void {
  ensure(doc, 34);
  doc
    .fillColor(opts.color ?? INK)
    .font("Helvetica")
    .fontSize(opts.size ?? 9.5)
    .text(text, MARGIN, doc.y, { width: CONTENT_WIDTH, align: "left", lineGap: 2.2 });
  doc.moveDown(0.45);
}

/**
 * One table row. Columns are [x, width, align] triples so the header and body
 * cannot drift apart — every caller passes the same column set.
 */
type Col = { x: number; w: number; align: "left" | "right" };

function tableHeader(doc: Doc, cols: Col[], labels: string[]): void {
  ensure(doc, 40);
  const y = doc.y;
  doc.rect(MARGIN, y - 3, CONTENT_WIDTH, 17).fill(BAND);
  doc.font("Helvetica-Bold").fontSize(7.6).fillColor(MUTED);
  labels.forEach((label, i) => {
    doc.text(label.toUpperCase(), cols[i].x, y + 1.5, {
      width: cols[i].w, align: cols[i].align, characterSpacing: 0.4,
    });
  });
  doc.y = y + 19;
}

function tableRow(doc: Doc, cols: Col[], cells: { text: string; color?: string; bold?: boolean }[]): void {
  ensure(doc, 22);
  const y = doc.y;
  cells.forEach((cell, i) => {
    doc
      .font(cell.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(9)
      .fillColor(cell.color ?? INK)
      .text(cell.text, cols[i].x, y, { width: cols[i].w, align: cols[i].align, lineBreak: false });
  });
  const bottom = y + 15;
  doc.moveTo(MARGIN, bottom).lineTo(MARGIN + CONTENT_WIDTH, bottom).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.y = bottom + 4;
}

// ── document ────────────────────────────────────────────────────────────────

export function buildRecapPdf(facts: RecapFacts, narrative: RecapNarrative): Promise<BuiltPdf> {
  const doc = new PDFDocument({
    size: [PAGE.width, PAGE.height],
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: {
      Title: narrative.headline,
      Author: "MarketCatalyst",
      Subject: `Daily market recap — ${facts.date}`,
    },
  });

  const chunks: Buffer[] = [];
  /**
   * Set once every section has rendered and BEFORE `end()`: ending the document
   * flushes the buffered pages and leaves the range empty, which silently
   * reported zero pages. The reader sizes its embed from this number, and zero
   * would collapse the article to the fallback height.
   */
  let pages = 0;
  const done = new Promise<BuiltPdf>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("error", reject);
    doc.on("end", () => {
      resolve({
        buffer: Buffer.concat(chunks),
        pages,
        aspect: PAGE.height / PAGE.width,
      });
    });
  });

  renderHeader(doc, facts, narrative);
  renderSummary(doc, narrative);
  renderDashboard(doc, facts);
  renderIndices(doc, facts);
  renderBreadth(doc, facts);
  renderSectors(doc, facts);
  renderMovers(doc, facts, narrative);
  renderStories(doc, narrative);
  renderTakeaway(doc, narrative);
  renderTags(doc, narrative);
  renderDisclaimer(doc);

  // Counted from the buffered range rather than tracked by hand, so a section
  // that spills onto another page cannot desync the stored page count.
  pages = doc.bufferedPageRange().count;
  doc.end();
  return done;
}

function renderHeader(doc: Doc, facts: RecapFacts, narrative: RecapNarrative): void {
  doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(8.5)
    .text("MARKETCATALYST", MARGIN, MARGIN, { characterSpacing: 1.6 });
  doc.moveDown(0.35);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(21)
    .text(narrative.headline, MARGIN, doc.y, { width: CONTENT_WIDTH, lineGap: 1 });
  doc.moveDown(0.3);
  doc.fillColor(MUTED).font("Helvetica").fontSize(9)
    .text(`Daily market recap · ${longDate(facts.date)} · US close`, MARGIN, doc.y, { width: CONTENT_WIDTH });
  const y = doc.y + 8;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_WIDTH, y).lineWidth(1.4).strokeColor(BLUE).stroke();
  doc.y = y + 14;
}

function renderSummary(doc: Doc, narrative: RecapNarrative): void {
  for (const para of narrative.summary) paragraph(doc, para, { size: 10 });
}

/** Market temperature + volatility, the prompt's top widget. */
function renderDashboard(doc: Doc, facts: RecapFacts): void {
  const vix = facts.indices.find((i) => /vix/i.test(i.label));
  if (!facts.sentiment && !vix) return;

  ensure(doc, 74);
  const y = doc.y + 2;
  const h = 56;
  doc.rect(MARGIN, y, CONTENT_WIDTH, h).fill(BAND);

  const half = CONTENT_WIDTH / 2;
  if (facts.sentiment) {
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(7.4)
      .text("MARKET TEMPERATURE", MARGIN + 16, y + 12, { characterSpacing: 0.5 });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(17)
      .text(`${facts.sentiment.value ?? "—"}/100`, MARGIN + 16, y + 24);
    doc.fillColor(MUTED).font("Helvetica").fontSize(9)
      .text(facts.sentiment.label ?? "", MARGIN + 78, y + 30);
  }
  if (vix) {
    const x = MARGIN + half + 4;
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(7.4)
      .text("VOLATILITY", x, y + 12, { characterSpacing: 0.5 });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(17)
      .text(num(vix.value), x, y + 24);
    doc.fillColor(tone(vix.pctChange)).font("Helvetica-Bold").fontSize(9.5)
      .text(pct(vix.pctChange), x + 74, y + 30);
    // Named honestly: the sync tracks a VIX futures ETN, not spot VIX, and a
    // reader would otherwise take this for the index level.
    if (vix.isProxy) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(6.8)
        .text(`proxy: ${vix.proxyTicker ?? "ETN"} — direction only, not spot VIX`, x, y + 44,
          { width: half - 20 });
    }
  }
  doc.y = y + h + 10;
}

function renderIndices(doc: Doc, facts: RecapFacts): void {
  if (!facts.indices.length) return;
  sectionTitle(doc, "Indices & macro assets");
  const cols: Col[] = [
    { x: MARGIN, w: 210, align: "left" },
    { x: MARGIN + 214, w: 100, align: "right" },
    { x: MARGIN + 318, w: 84, align: "right" },
    { x: MARGIN + 406, w: 98, align: "right" },
  ];
  tableHeader(doc, cols, ["Market", "Level", "Change", "% change"]);
  for (const idx of facts.indices) {
    tableRow(doc, cols, [
      { text: idx.label + (idx.isProxy ? " *" : ""), bold: true },
      { text: num(idx.value) },
      { text: signed(idx.change), color: tone(idx.change) },
      { text: pct(idx.pctChange), color: tone(idx.pctChange) },
    ]);
  }
  if (facts.indices.some((i) => i.isProxy)) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(7)
      .text("* tracked via a liquid proxy instrument — direction is representative, the level is not the index itself.",
        MARGIN, doc.y + 1, { width: CONTENT_WIDTH });
    doc.y += 12;
  }
}

function renderBreadth(doc: Doc, facts: RecapFacts): void {
  const b = facts.internals;
  if (!b) return;
  sectionTitle(doc, "Breadth & internals");

  const upDown = b.upVolume != null && b.downVolume ? b.upVolume / b.downVolume : null;
  const advDecl = b.advancers != null && b.decliners ? b.advancers / b.decliners : null;
  const cells: { label: string; value: string; color?: string }[] = [
    { label: "Advancers", value: num(b.advancers, 0), color: GREEN },
    { label: "Decliners", value: num(b.decliners, 0), color: RED },
    { label: "Net", value: signed(b.netAdvancers, 0), color: tone(b.netAdvancers) },
    { label: "A/D ratio", value: advDecl == null ? "—" : advDecl.toFixed(2) },
    { label: "Up/down vol", value: upDown == null ? "—" : upDown.toFixed(2) },
    { label: "TRIN", value: num(b.trin) },
  ];

  ensure(doc, 54);
  const y = doc.y;
  const colW = CONTENT_WIDTH / cells.length;
  cells.forEach((c, i) => {
    const x = MARGIN + colW * i;
    doc.fillColor(MUTED).font("Helvetica").fontSize(7.2)
      .text(c.label.toUpperCase(), x, y, { width: colW - 6, characterSpacing: 0.3 });
    doc.fillColor(c.color ?? INK).font("Helvetica-Bold").fontSize(12)
      .text(c.value, x, y + 11, { width: colW - 6 });
  });
  doc.y = y + 34;
}

function renderSectors(doc: Doc, facts: RecapFacts): void {
  if (!facts.sectorLeaders.length && !facts.sectorLaggards.length) return;
  sectionTitle(doc, "Sector leaders & laggards");

  const colW = (CONTENT_WIDTH - 18) / 2;
  const startY = doc.y;
  const column = (rows: SectorRow[], x: number, heading: string, color: string) => {
    doc.fillColor(color).font("Helvetica-Bold").fontSize(8)
      .text(heading.toUpperCase(), x, startY, { width: colW, characterSpacing: 0.5 });
    let y = startY + 14;
    for (const row of rows) {
      doc.fillColor(INK).font("Helvetica").fontSize(9)
        .text(row.sector, x, y, { width: colW - 62, lineBreak: false });
      doc.fillColor(tone(row.pctChange)).font("Helvetica-Bold").fontSize(9)
        .text(pct(row.pctChange), x + colW - 60, y, { width: 60, align: "right" });
      y += 15;
    }
    return y;
  };
  const leftEnd = column(facts.sectorLeaders, MARGIN, "Leaders", GREEN);
  const rightEnd = column(facts.sectorLaggards, MARGIN + colW + 18, "Laggards", RED);
  doc.y = Math.max(leftEnd, rightEnd) + 6;
}

function renderMovers(doc: Doc, facts: RecapFacts, narrative: RecapNarrative): void {
  const movers = [...facts.topGainers.slice(0, 3), ...facts.topLosers.slice(0, 3)];
  if (!movers.length) return;
  sectionTitle(doc, "Notable movers");

  for (const m of movers) {
    ensure(doc, 46);
    const y = doc.y;
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(10.5)
      .text(m.ticker, MARGIN, y, { width: 62, lineBreak: false });
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.6)
      .text(m.name, MARGIN + 64, y + 1.5, { width: CONTENT_WIDTH - 214, lineBreak: false });
    doc.fillColor(INK).font("Helvetica").fontSize(9.5)
      .text(num(m.price), MARGIN + CONTENT_WIDTH - 148, y, { width: 70, align: "right" });
    doc.fillColor(tone(m.pctChange)).font("Helvetica-Bold").fontSize(9.5)
      .text(pct(m.pctChange), MARGIN + CONTENT_WIDTH - 72, y, { width: 72, align: "right" });
    doc.y = y + 15;

    const note = narrative.moverNotes[m.ticker];
    if (note) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(8.6)
        .text(note, MARGIN, doc.y, { width: CONTENT_WIDTH, lineGap: 1.6 });
    }
    doc.moveDown(0.55);
  }
}

function renderStories(doc: Doc, narrative: RecapNarrative): void {
  if (!narrative.stories.length) return;
  sectionTitle(doc, "What moved the market");
  narrative.stories.forEach((s, i) => {
    ensure(doc, 48);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.6)
      .text(`${i + 1}. ${s.title}`, MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.15);
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.8)
      .text(s.body, MARGIN, doc.y, { width: CONTENT_WIDTH, lineGap: 1.8 });
    doc.moveDown(0.5);
  });
}

function renderTakeaway(doc: Doc, narrative: RecapNarrative): void {
  if (!narrative.takeaway.trim()) return;
  sectionTitle(doc, "Key tactical takeaway");

  doc.font("Helvetica").fontSize(9.4);
  const textH = doc.heightOfString(narrative.takeaway, { width: CONTENT_WIDTH - 40, lineGap: 2 });
  const boxH = textH + 30;
  ensure(doc, boxH + 8);
  const y = doc.y;
  doc.rect(MARGIN, y, CONTENT_WIDTH, boxH).fill(CALLOUT_BG);
  doc.rect(MARGIN, y, 4, boxH).fill(GREEN);
  doc.fillColor(INK).font("Helvetica").fontSize(9.4)
    .text(narrative.takeaway, MARGIN + 20, y + 15, { width: CONTENT_WIDTH - 40, lineGap: 2 });
  doc.y = y + boxH + 10;
}

function renderTags(doc: Doc, narrative: RecapNarrative): void {
  if (!narrative.tags.length) return;
  ensure(doc, 34);
  let x = MARGIN;
  const y = doc.y + 4;
  doc.font("Helvetica").fontSize(7.8);
  for (const tag of narrative.tags.slice(0, 8)) {
    const w = doc.widthOfString(tag) + 18;
    if (x + w > MARGIN + CONTENT_WIDTH) break;
    doc.roundedRect(x, y, w, 15, 7.5).fill(RULE);
    doc.fillColor("#4a5568").text(tag, x, y + 4.2, { width: w, align: "center" });
    x += w + 6;
  }
  doc.y = y + 24;
}

function renderDisclaimer(doc: Doc): void {
  ensure(doc, 62);
  const y = doc.y;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_WIDTH, y).lineWidth(0.8).strokeColor(RULE).stroke();
  doc.fillColor(MUTED).font("Helvetica").fontSize(7.2)
    .text(
      "MarketCatalyst LLC. This recap is generated automatically from market data and is provided for " +
      "informational purposes only. It is not investment advice, an offer, or a solicitation to buy or sell " +
      "any security. Figures are drawn from end-of-day vendor data and may be revised. Past performance does " +
      "not indicate future results. Consult a licensed financial adviser before acting on anything here.",
      MARGIN, y + 8, { width: CONTENT_WIDTH, lineGap: 1.4 },
    );
}
