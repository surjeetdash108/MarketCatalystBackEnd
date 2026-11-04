// marked ships ESM only, which ts-jest's CommonJS runtime cannot load; the
// blog service imports it but these tests never render Markdown.
jest.mock("marked", () => ({ marked: { parse: (s: string) => s } }));

import type { FmpFullQuote } from "../vendors/fmp/fmp.service";
import { composeArticle } from "./earnings-article.compose";
import { buildFacts, type ArticleFacts, type FactsInput } from "./earnings-article.facts";
import {
  coveredBy,
  isUsSymbol,
  onePerCompany,
  pickRelated,
  releaseStatesRevenue,
  reportedRows,
  universeReason,
  type Candidate,
} from "./earnings-article.job";
import { acceptCopy, fallbackCopy, numberTokens, releaseExcerpt, titleOk } from "./earnings-article.writer";

// Public FMP rows for Figma's Q3 2026 report (Nov. 4, 2026).
const FIG: FactsInput = {
  company: { symbol: "FIG", name: "Figma, Inc." },
  report: { date: "2026-11-04", epsActual: 0.1, epsEstimated: 0.05422, revenueActual: 391415000, revenueEstimated: 376531900 },
  history: [
    { date: "2026-11-04", epsActual: 0.1, epsEstimated: 0.05422, revenueActual: 391415000, revenueEstimated: 376531900 },
    { date: "2026-08-05", epsActual: 0.08, epsEstimated: 0.04103, revenueActual: 370083000, revenueEstimated: 351555600 },
    { date: "2026-05-14", epsActual: 0.1, epsEstimated: 0.06333, revenueActual: 333439000, revenueEstimated: 316018600 },
    { date: "2026-02-18", epsActual: 0.08, epsEstimated: 0.07, revenueActual: 303776000, revenueEstimated: 293124000 },
    { date: "2025-11-05", epsActual: 0.1, epsEstimated: 0.04556, revenueActual: 274173000, revenueEstimated: 263936500 },
  ],
  statements: [
    { date: "2026-09-30", period: "Q3", fiscalYear: "2026", filingDate: "2026-11-04", reportedCurrency: "USD", revenue: 391415000, grossProfit: 314440000, netIncome: -81348000, epsDiluted: -0.15 },
    { date: "2025-09-30", period: "Q3", fiscalYear: "2025", filingDate: "2025-11-05", reportedCurrency: "USD", revenue: 274173000, grossProfit: 190289000, netIncome: -1097015000, epsDiluted: -2.23 },
  ],
  estimates: [{ date: "2026-12-30", epsAvg: 0.052623, revenueAvg: 390601186, numAnalystsEps: 11 }],
  reaction: { session: "after-hours", pct: -6.96, price: 20.59, reference: 22.13, at: Date.parse("2026-11-04T21:40:27Z") },
};

// Sentences from Figma's Q3 2026 release (Form 8-K, Exhibit 99.1).
const RELEASE =
  "Figma Announces Third Quarter 2026 Financial Results. Q3 revenue grew 43% year-over-year to $391.4 million, $16.4 million above the high-end of prior guidance. " +
  "Net Dollar Retention Rate was 131% as of September 30, 2026. " +
  "Fourth Quarter 2026 Outlook: Revenue between $402.0 million and $404.0 million, implying 33% year-over-year growth at the midpoint of the range.";

const facts = (input: FactsInput = FIG): ArticleFacts => {
  const f = buildFacts(input);
  if ("skip" in f) throw new Error(f.skip);
  return f;
};

const missFacts = () =>
  facts({
    ...FIG,
    reaction: null,
    report: { ...FIG.report, epsActual: 0.03, revenueActual: 360000000 },
  });

const RELATED = [1, 2, 3, 4].map((i) => ({
  pill: "Earnings" as const,
  title: `Company ${i} Beats Q3 Estimates`,
  url: `https://marketcatalyst.ai/posts/company-${i}`,
  readTime: "3 min",
  linkText: `Company ${i}`,
}));

describe("detection", () => {
  it("keeps ordinary US symbols with both actuals", () => {
    const rows = reportedRows([
      { symbol: "FIG", date: "2026-11-04", epsActual: 0.1, revenueActual: 1 },
      { symbol: "002775.SZ", date: "2026-11-04", epsActual: 0.1, revenueActual: 1 },
      { symbol: "CVS", date: "2026-11-04", epsActual: 2.09, revenueActual: null },
      { symbol: "BRK-B", date: "2026-11-04", epsActual: 1, revenueActual: 1, epsEstimated: 0.9 },
    ]);
    expect(rows.map((r) => r.symbol)).toEqual(["FIG", "BRK-B"]);
    expect(isUsSymbol("ABCDEFG")).toBe(false);
  });

  it("universe: $1B+, US listing, operating companies", () => {
    const q = (marketCap: number) => ({ symbol: "X", marketCap }) as FmpFullQuote;
    const p = { symbol: "X", companyName: "X", exchange: "NASDAQ" };
    expect(universeReason(q(2e9), p)).toBeNull();
    expect(universeReason(q(5e8), p)).toBe("under-1b");
    expect(universeReason(q(2e9), { ...p, isEtf: true })).toBe("fund");
    expect(universeReason(q(2e9), { ...p, exchange: "OTC" })).toBe("non-us-listing");
    expect(universeReason(undefined, p)).toBe("no-quote");
  });

  it("one article per company across share classes", () => {
    const c = (symbol: string, volume: number): Candidate => ({
      row: { symbol, date: "2026-11-04", epsActual: 1, epsEstimated: 1, revenueActual: 1, revenueEstimated: 1 },
      quote: { symbol, volume } as FmpFullQuote,
      profile: { symbol, companyName: "Bruker", cik: "0001109354" },
    });
    const { keep, dropped } = onePerCompany([c("BRKRP", 1_000), c("BRKR", 2_000_000)]);
    expect(keep.map((k) => k.row.symbol)).toEqual(["BRKR"]);
    expect(dropped.map((k) => k.row.symbol)).toEqual(["BRKRP"]);
  });

  it("does not repost a ticker another post already covers", () => {
    const now = Date.parse("2026-11-04T22:00:00Z");
    const posts = [
      { title: "Figma Beats Q3", slug: "figma", type: "earnings", status: "published", read: "3 min read", createdMs: now - 3_600_000, content: '<p>Figma (FIG) reported…</p>' },
    ];
    expect(coveredBy(posts, "FIG", now)?.slug).toBe("figma");
    expect(coveredBy(posts, "FIGS", now)).toBeNull();
    expect(coveredBy(posts, "FIG", now + 4 * 86_400_000)).toBeNull();
  });

  it("related cards: same ticker first, then earnings, only live posts", () => {
    const post = (slug: string, type: string, content = "", status = "published") => ({
      title: `${slug} Beats Q3`, slug, type, status, read: "2 min read", createdMs: 0, content,
    });
    const cards = pickRelated(
      [post("recap", "recap"), post("draft", "earnings", "", "draft"), post("snap", "earnings"), post("fig-q2", "earnings", "Figma (FIG)"), post("news", "news"), post("dave", "earnings")],
      "FIG",
    );
    expect(cards.map((c) => c.url.split("/").pop())).toEqual(["fig-q2", "snap", "dave", "recap"]);
    expect(cards[0]).toMatchObject({ pill: "Earnings", readTime: "2 min", linkText: "fig-q2" });
  });

  it("confirms a release by the revenue it states", () => {
    expect(releaseStatesRevenue(RELEASE, 391415000)).toBe(true);
    expect(releaseStatesRevenue("Total revenues were $108.4 billion for the quarter", 108399000000)).toBe(true);
    expect(releaseStatesRevenue("Revenue 391,415 (in thousands)", 391415000)).toBe(true);
    expect(releaseStatesRevenue(RELEASE, 370083000)).toBe(false);
  });
});

describe("writer checks", () => {
  it("reads numbers, not labels", () => {
    expect(numberTokens("Q3 2026 revenue of $391.4 million, up 43%; FY26 guide $1,497.0 million")).toEqual(["2026", "391.4", "43", "1497"]);
  });

  it("fallback copy follows the skill when the model gives nothing", () => {
    const c = acceptCopy(null, facts(), null);
    expect(c.fromModel).toEqual([]);
    expect(c.title).toBe("Figma Beats Q3 2026 Estimates as Revenue Rises 43% to $391.4M");
    expect(c.description.length).toBeGreaterThanOrEqual(138);
    expect(c.description.length).toBeLessThanOrEqual(160);
    expect(c.lede).toContain("Figma (FIG) beat estimates for the third quarter of 2026");
    expect(c.lede).toContain("$391.4 million, up 43% from a year earlier, above the $376.5 million estimate");
    expect(c.lede.split(/\s+/).length).toBeLessThanOrEqual(60);
    expect(c.watch).toHaveLength(3);
  });

  it("a miss reads as a miss — never 'topped expectations'", () => {
    const c = fallbackCopy(missFacts());
    expect(c.title).toMatch(/Misses/);
    expect(c.lede).toContain("missed estimates");
    expect(c.lede).not.toMatch(/topped|beat/);
  });

  it("takes the model's parts that pass and replaces the rest", () => {
    const f = facts();
    const raw = JSON.stringify({
      title: "Figma Beats Q3 as Revenue Rises 43% to $391.4M; Guides Q4 to $402M-$404M",
      dek: "Revenue of $391.4 million topped the $376.5 million estimate.",
      description: "Figma beat Q3 2026 estimates with revenue of $391.4M, up 43%, and adjusted EPS of $0.10 vs. $0.05, and guided Q4 revenue to $402M-$404M, above Street views.",
      lede: "Figma (FIG) beat estimates for the third quarter of 2026 and guided fourth-quarter revenue to $402.0 million to $404.0 million. Revenue was $391.4 million, up 43% from a year earlier, against the $376.5 million estimate, and adjusted EPS was $0.10.",
      sections: [
        {
          title: "Outlook",
          bullets: [
            { label: "Fourth quarter", text: "Figma guided revenue to $402.0 million to $404.0 million.", evidence: "Revenue between $402.0 million and $404.0 million, implying 33% year-over-year growth at the midpoint of the range." },
            { label: "Retention", text: "Net dollar retention was 131%.", evidence: "Net Dollar Retention Rate was 131% as of September 30, 2026." },
            { label: "Made up", text: "Customers grew 29%.", evidence: "Customers grew 29% in the quarter." },
            { label: "Wrong number", text: "Net dollar retention was 136%.", evidence: "Net Dollar Retention Rate was 131% as of September 30, 2026." },
          ],
        },
      ],
      watch: [
        { label: "Retention", text: "Whether net dollar retention holds near 131%." },
        { label: "Guidance", text: "Delivery against the $402.0 million to $404.0 million fourth-quarter range." },
        { label: "Growth", text: "Whether revenue keeps growing near 43% from a year earlier." },
      ],
    });
    const c = acceptCopy(raw, f, RELEASE);
    expect(c.sections).toHaveLength(1);
    expect(c.sections[0].bullets.map((b) => b.label)).toEqual(["Fourth quarter", "Retention"]);
    // Guidance numbers are allowed in the headline copy once a bullet's evidence backs them.
    expect(c.title).toBe("Figma Beats Q3 as Revenue Rises 43% to $391.4M; Guides Q4 to $402M-$404M");
    expect(c.lede).toContain("guided fourth-quarter revenue");
    expect(c.fromModel).toEqual(expect.arrayContaining(["sections", "title", "description", "lede", "watch"]));
    // The dek adds nothing from the release, so the code-written one stays.
    expect(c.fromModel).not.toContain("dek");
    expect(c.description.length).toBeLessThanOrEqual(160);
  });

  it("rejects numbers the facts do not hold, spelled counts, quotes and contradicting verdicts", () => {
    const f = missFacts();
    const raw = JSON.stringify({
      title: "Figma Misses Q3 Estimates as Revenue Hits $412M",
      dek: "Figma tripled its customer count.",
      description: "x",
      lede: 'Figma (FIG) beat estimates, "a great quarter," the CEO said.',
      sections: [],
      watch: [],
    });
    const c = acceptCopy(raw, f, null);
    expect(c.fromModel).toEqual([]);
    expect(c.title).toMatch(/^Figma Misses Q3 2026 Estimates/);
  });

  it("company names do not trip the word checks", () => {
    const f = facts({ ...FIG, company: { symbol: "FIVE", name: "Five Below, Inc." }, reaction: null });
    const watch = ["Stores", "Margins", "Holiday"].map((label) => ({ label, text: `Whether Five Below keeps revenue growth near 43%.` }));
    expect(acceptCopy(JSON.stringify({ watch }), f, null).fromModel).toContain("watch");
  });

  it("titles read like the house titles", () => {
    const f = facts();
    const sections = [{ title: "Outlook", bullets: [{ label: "Fourth quarter", text: "Figma guided revenue to $402.0 million to $404.0 million." }] }];
    expect(titleOk("Figma Beats Q3, Guides Q4 Revenue to $402M-$404M", f, sections)).toBe(true);
    expect(titleOk("Figma beats Q3, guides Q4 revenue to $402M-$404M and more", f, sections)).toBe(false);
    expect(titleOk("Figma Raises Q3 2026 Revenue to $391.4M and Adjusted EPS", f, [])).toBe(false);
    expect(titleOk("Figma Misses Q3 2026 Estimates With Revenue of $391.4M", f, sections)).toBe(true);
  });

  it("no causes in the headline copy", () => {
    const f = facts();
    const raw = JSON.stringify({
      lede: "Figma (FIG) beat estimates for the third quarter of 2026, driven by AI demand, and guided fourth-quarter revenue to $402.0 million to $404.0 million. Revenue was $391.4 million and adjusted EPS was $0.10.",
      sections: [{ title: "Outlook", bullets: [{ label: "Fourth quarter", text: "Figma guided revenue to $402.0 million to $404.0 million.", evidence: "Revenue between $402.0 million and $404.0 million, implying 33% year-over-year growth at the midpoint of the range." }] }],
    });
    const c = acceptCopy(raw, f, RELEASE);
    expect(c.fromModel).toEqual(["sections"]);
    expect(c.lede).not.toContain("driven");
  });

  it("release excerpt stops before the boilerplate", () => {
    const text = `${"Results. ".repeat(300)} Forward-Looking Statements This press release contains…`;
    expect(releaseExcerpt(text)).not.toMatch(/Forward-Looking/);
  });
});

/** The article between the template's header and the disclaimer — the template's own stylesheet comments use dashes. */
const article = (doc: string) => doc.slice(doc.indexOf('<div class="article">'), doc.indexOf('<div class="disclaimer">'));

describe("composed article", () => {
  const html = () =>
    composeArticle(facts(), acceptCopy(null, facts(), null), { createdMs: Date.parse("2026-11-04T21:42:00Z"), related: RELATED, has8k: true }).documentHtml;

  it("has the skill's parts with FMP figures and no blanks", () => {
    const h = html();
    expect(h).toContain('<td class="pos">Beat by 84%</td>');
    expect(h).toContain('<td class="pos">Beat by 4.0%</td>');
    expect(h).toContain("<th>Change</th><th>YoY</th><th>QoQ</th>");
    expect(h).toContain('<td class="metric">Revenue</td><td class="pos">&#9650; 43%</td><td class="pos">&#9650; 5.8%</td>');
    expect(h).toContain('<td class="metric">Adjusted EPS</td><td>Unchanged</td><td class="pos">&#9650; 25%</td>');
    expect(h).toContain("By our calculation, revenue was $14.9 million above the estimate");
    expect(h).toContain("GAAP diluted EPS was -$0.15, against -$2.23 a year earlier.");
    expect(h).toContain("Shares fell 7.0% in after-hours trading as of 4:40 p.m. ET, to $20.59 from a $22.13 close.");
    expect(h).toContain('"tickerSymbol": "FIG"');
    expect(h).toContain('"datePublished": "2026-11-04T16:41:00-05:00"');
    expect(h).toContain("Form 8-K");
    expect((h.match(/class="mc-ra-card"/g) ?? []).length).toBe(4);
    expect(article(h)).not.toMatch(/—|undefined|null|NaN|TBD/);
    expect(h).toContain("Published Nov 4, 2026 · 4:41 PM ET");
  });

  it("drops a column and the scorecard row it cannot fill, instead of printing a blank", () => {
    const f = facts({ ...FIG, history: FIG.history.slice(0, 2), report: { ...FIG.report, revenueEstimated: null } });
    const h = composeArticle(f, fallbackCopy(f), { createdMs: Date.now(), related: RELATED, has8k: false }).documentHtml;
    expect(h).toContain("<th>Change</th><th>QoQ</th>");
    expect(h).not.toContain("<th>YoY</th>");
    expect(h).not.toContain('<td class="metric">Revenue</td><td>$');
    expect(article(h)).not.toMatch(/—|undefined|null|NaN/);
    expect(h).not.toContain("Form 8-K");
  });
});
