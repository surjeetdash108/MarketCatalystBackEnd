jest.mock("marked", () => ({ marked: { parse: (s: string) => s } }));

import {
  computeBeatMiss,
  formatArrowPercent,
  formatBeatMissGap,
  formatBillions,
  formatEps,
  slugifyTitle,
} from "./earnings-article.job";
import {
  buildEarningsBodyHtml,
  buildFullPageHtml,
  type EarningsArticleInput,
} from "./earnings-article-html.builder";

describe("EarningsArticle Job & Builder", () => {
  describe("computeBeatMiss and formatBeatMissGap logic (Section 3 & 4)", () => {
    it("classifies and formats EPS gaps correctly", () => {
      expect(computeBeatMiss(2.09, 1.65, "eps")).toEqual({ verdict: "Beat", cls: "pos" });
      expect(formatBeatMissGap(2.09, 1.65, "eps")).toEqual({ verdict: "Beat", text: "Beat by 27%", cls: "pos" });
      expect(computeBeatMiss(1.64, 1.65, "eps")).toEqual({ verdict: "Miss", cls: "dn" });
      expect(formatBeatMissGap(1.59, 1.65, "eps")).toEqual({ verdict: "Miss", text: "Miss by 3.6%", cls: "dn" });
      expect(computeBeatMiss(1.65, 1.65, "eps")).toEqual({ verdict: "In line", cls: "" });
      expect(formatBeatMissGap(1.65, 1.65, "eps")).toEqual({ verdict: "In line", text: "In line", cls: "" });
    });

    it("classifies and formats Revenue gaps correctly", () => {
      // 108.4 vs 104.8 is +3.4%
      expect(formatBeatMissGap(108.4, 104.8, "revenue")).toEqual({ verdict: "Beat", text: "Beat by 3.4%", cls: "pos" });
      expect(computeBeatMiss(100.3, 100.0, "revenue")).toEqual({ verdict: "Beat", cls: "pos" });
      expect(computeBeatMiss(99.7, 100.0, "revenue")).toEqual({ verdict: "Miss", cls: "dn" });
      expect(computeBeatMiss(100.1, 100.0, "revenue")).toEqual({ verdict: "In line", cls: "" });
    });

    it("formats arrow percents for change grid correctly", () => {
      expect(formatArrowPercent(30.6)).toEqual({ text: "&#9650; 31%", cls: "pos" });
      expect(formatArrowPercent(-19.2)).toEqual({ text: "&#9660; 19%", cls: "dn" });
      expect(formatArrowPercent(5.4)).toEqual({ text: "&#9650; 5.4%", cls: "pos" });
      expect(formatArrowPercent(-3.5)).toEqual({ text: "&#9660; 3.5%", cls: "dn" });
    });
  });

  describe("Formatting helpers", () => {
    it("formats billions correctly", () => {
      expect(formatBillions(14_770_000_000)).toBe("$14.77B");
      expect(formatBillions(5_201_000_000)).toBe("$5.20B");
    });

    it("formats EPS correctly", () => {
      expect(formatEps(0.88)).toBe("$0.88");
      expect(formatEps(1.86)).toBe("$1.86");
    });

    it("generates clean slugs from titles", () => {
      expect(slugifyTitle("Uber Tops Q3 Estimates as Gross Bookings Jump 20% to $59.8B")).toBe(
        "uber-tops-q3-estimates-as-gross-bookings-jump-20-to-59-8b",
      );
    });
  });

  describe("HTML Document Generation", () => {
    const sampleInput: EarningsArticleInput = {
      company: "Uber Technologies, Inc.",
      ticker: "UBER",
      period: "Q3 2026",
      announcedDateFormatted: "Nov. 4, 2026",
      announcedIsoDate: "2026-11-04T12:00:00-05:00",
      slug: "uber-tops-q3-estimates-as-gross-bookings-jump-20-to-59-8b",
      stripCode: "ubr",
      title: "Uber Tops Q3 Estimates as Gross Bookings Jump 20% to $59.8B",
      dek: "Adjusted EPS rose to $0.88 and revenue reached $14.77 billion as delivery momentum accelerated.",
      metaDescription:
        "Uber beat Q3 estimates with revenue of $14.77B and adjusted EPS of $0.88, as gross bookings jumped 20% to $59.8B and delivery momentum accelerated.",
      readTime: "4 min read",
      lede: "Uber Technologies, Inc. (UBER) reported third-quarter 2026 results that beat consensus estimates, driven by delivery strength and 20% gross bookings growth. Revenue rose 10% from a year earlier to $14.77 billion, topping the $14.66 billion estimate, while adjusted EPS reached $0.88 versus $0.86 expected.",
      statBoxes: [
        { num: "$0.88", label: "Adjusted EPS vs. $0.86 estimate", color: "#1E8449" },
        { num: "$14.77B", label: "Revenue vs. $14.66B estimate", color: "#1E8449" },
        { num: "+20%", label: "Gross bookings growth YoY", color: "#2563EB" },
      ],
      scorecardRows: [
        { parameter: "Adjusted EPS", expected: "$0.86", actual: "$0.88", beatMissText: "Beat by 2%", beatMissClass: "pos" },
        { parameter: "Revenue", expected: "$14.66B", actual: "$14.77B", beatMissText: "Beat by 0.7%", beatMissClass: "pos" },
      ],
      changeRows: [
        { metric: "Adjusted EPS", yoyText: "&#9660; 72%", yoyClass: "dn", qoqText: "&#9650; 40%", qoqClass: "pos" },
        { metric: "Revenue", yoyText: "&#9650; 9.6%", yoyClass: "pos", qoqText: "&#9650; 9.4%", qoqClass: "pos" },
      ],
      hasQoq: true,
      byOurCalculation:
        "By our calculation, revenue beat estimates by $110 million (about 0.75%), while adjusted EPS beat by $0.02 per share.",
      industrySections: [
        {
          title: "Bookings and segment momentum",
          bullets: [
            {
              label: "Gross Bookings",
              text: "Gross Bookings reached $59.8 billion, representing 20% year-over-year constant currency growth.",
            },
          ],
        },
      ],
      profitOutlookSection: {
        title: "Profit, cash flow and outlook",
        bullets: [
          {
            label: "Free cash flow",
            text: "Free cash flow reached $2.5 billion in the quarter, bringing the trailing 12-month total to $10.4 billion.",
          },
        ],
      },
      whatToWatchBullets: [
        {
          label: "Autonomous fleet scaling",
          text: "Progress toward reaching 700 driverless vehicles by the end of 2026.",
        },
      ],
      sourcesText:
        "Results are from Uber's Nov. 4 company release and Form 8-K. Estimates are consensus figures. Items labeled by our calculation are our own arithmetic. This article is informational only and is not investment advice.",
      relatedCards: [
        {
          pill: "Earnings",
          title: "McDonald's Beats on EPS at $3.57 as U.S. Comps Slip Just 0.2%",
          url: "https://marketcatalyst.ai/posts/mcdonald-s-beats-on-eps-at-3-57-as-u-s-comps-slip-just-0-2-but-q3-revenue-misses",
          readTime: "4 min",
        },
        {
          pill: "Earnings",
          title: "CVS Beats Q3, Raises Outlook and Plans Two-Company Split",
          url: "https://marketcatalyst.ai/posts/cvs-beats-q3-raises-outlook-and-plans-two-company-split",
          readTime: "3 min",
        },
        {
          pill: "Recap",
          title: "Week Ahead: Midterms, Apple and AMD Earnings Test a Shaken Market",
          url: "https://marketcatalyst.ai/posts/week-ahead-midterms-apple-and-amd-earnings-and-the-jobs-report-test-a-shaken-market",
          readTime: "7 min",
        },
        {
          pill: "News",
          title: "Mid-Morning Movers by Market Cap: Top Gainers and Losers",
          url: "https://marketcatalyst.ai/posts/mid-morning-movers-by-market-cap-top-gainers-and-losers-across-mega-large-mid-2",
          readTime: "3 min",
        },
      ],
    };

    it("enforces title under 100 characters", () => {
      expect(sampleInput.title.length).toBeLessThan(100);
    });

    it("enforces meta description between 138 and 160 characters", () => {
      expect(sampleInput.metaDescription.length).toBeGreaterThanOrEqual(138);
      expect(sampleInput.metaDescription.length).toBeLessThanOrEqual(160);
    });

    it("enforces lede is two sentences with ticker in parentheses", () => {
      expect(sampleInput.lede).toContain("(UBER)");
      // Remove common abbreviations before sentence counting
      const cleanLede = sampleInput.lede.replace(/Inc\./g, "Inc");
      const sentences = cleanLede.split(/\.\s+/).filter(Boolean);
      expect(sentences.length).toBe(2);
      const wordCount = sampleInput.lede.split(/\s+/).length;
      expect(wordCount).toBeLessThanOrEqual(60);
    });

    it("generates valid body HTML and JSON-LD schema", () => {
      const bodyHtml = buildEarningsBodyHtml(sampleInput);
      expect(bodyHtml).toContain('type="application/ld+json"');
      expect(bodyHtml).toContain('"@type": "NewsArticle"');
      expect(bodyHtml).toContain('id="ubr-strip"');
      expect(bodyHtml).toContain('By our calculation,');
      expect(bodyHtml).toContain('Readers also read');
      expect(bodyHtml).toContain('<div class="disclaimer"><p><a href="https://marketcatalyst.ai/">MarketCatalyst</a> is not a registered investment advisor');
    });

    it("generates complete standalone HTML preview document", () => {
      const fullHtml = buildFullPageHtml(sampleInput);
      expect(fullHtml).toContain("<!doctype html>");
      expect(fullHtml).toContain("<title>Uber Tops Q3 Estimates as Gross Bookings Jump 20% to $59.8B | MarketCatalyst</title>");
      expect(fullHtml).toContain('class="post-doc"');
      expect(fullHtml).toContain("</html>");
    });
  });
});
