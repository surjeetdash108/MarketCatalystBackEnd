import {
  checkArticle,
  composeArticleDocument,
  readLine,
  writerUserPrompt,
  type BlogArticle,
} from "./blog-article";

const article: BlogArticle = {
  title: "Lucid's Robotaxi Step <Isn't> Enough",
  dek: "Wall Street cut its 2027 forecast to about 37,000 vehicles.",
  intro: "Lucid & Uber pulled safety drivers.",
  stats: [
    { num: "~37,000", label: "2027 sales estimate", tone: "down" },
    { num: "$1", label: "Seaport target (Sell)", tone: "down" },
    { num: "21%", label: "Analysts rating Buy", tone: "neutral" },
  ],
  sections: [
    {
      heading: "The robotaxi upside",
      paragraphs: ["Driverless testing is underway."],
      tableHeaders: [],
      tableRows: [],
    },
    {
      heading: "Why the stock is under pressure",
      paragraphs: ["Demand cooled."],
      tableHeaders: ["Measure", "Latest"],
      tableRows: [{ label: "2027 estimate", value: "~37,000", tone: "down" }],
    },
  ],
  watch: "The early-2027 launch.",
  readMinutes: 3,
};

describe("blog article", () => {
  it("escapes every model string and uses the blog's document shape", () => {
    const html = composeArticleDocument(
      article,
      "Published Nov 24, 2026 · 12:51 PM ET · 3 min read",
    );
    expect(html).toContain(
      "<h1>Lucid&#39;s Robotaxi Step &lt;Isn&#39;t&gt; Enough</h1>",
    );
    expect(html).toContain("<p>Lucid &amp; Uber pulled safety drivers.</p>");
    expect(html).toContain('<div class="eyebrow">MARKETCATALYST</div>');
    expect(html).toContain('<div class="num dn">~37,000</div>');
    expect(html).toContain(
      '<td class="metric">2027 estimate</td><td class="dn">~37,000</td>',
    );
    expect(html).toContain("<b>What to watch.</b> The early-2027 launch.");
    expect(html).toContain("not investment advice");
    expect(html).not.toContain("<script");
  });

  it("rejects an incomplete article and clamps stats and read time", () => {
    expect(() => checkArticle({ ...article, title: " " })).toThrow();
    expect(() => checkArticle({ ...article, sections: [] })).toThrow();
    const many = checkArticle({
      ...article,
      stats: [...article.stats, article.stats[0]],
      readMinutes: 40,
    });
    expect(many.stats).toHaveLength(3);
    expect(many.readMinutes).toBe(8);
  });

  it("formats the read line in New York time", () => {
    expect(readLine(new Date("2026-11-24T17:51:00Z"), 3)).toBe(
      "Published Nov 24, 2026 · 12:51 PM ET · 3 min read",
    );
  });

  it("fences the notes and adds the review note on a rewrite", () => {
    const first = writerUserPrompt({
      section: "News",
      headline: null,
      tickers: ["LCID"],
      notes: "facts",
      links: [],
    });
    expect(first).toContain("<editor_notes>\nfacts\n</editor_notes>");
    expect(first).not.toContain("rewrite");
    const again = writerUserPrompt({
      section: "News",
      headline: null,
      tickers: [],
      notes: "facts",
      links: [],
      reviewNote: "Shorter",
      previous: article,
    });
    expect(again).toContain(
      "<editor_review_note>\nShorter\n</editor_review_note>",
    );
  });
});
