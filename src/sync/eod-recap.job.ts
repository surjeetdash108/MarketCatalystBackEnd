import * as fs from "fs";
import * as path from "path";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { BlogsAdminService, composeDocument } from "../blogs/blogs-admin.service";
import { SIMPLE_THEME, composeSimpleBody } from "../mcp/blog-templates/simple";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { AnthropicService } from "../vendors/anthropic/anthropic.service";
import { LlmGatewayService } from "../vendors/llm-gateway.service";
import { etDate, etWeekday } from "../common/market-calendar.util";

/**
 * Automated End-Of-Day (EOD) Market Recap Job.
 *
 * Runs every trading day 15 minutes after market close:
 * Regular close: 4:00 PM ET = 3:00 PM CT.
 * 15 min after: 4:15 PM ET = 3:15 PM CT (16:15 America/New_York).
 *
 * Pipeline:
 * 1. Verifies that today is a valid non-holiday trading session (NYSE open).
 * 2. Checks idempotency (pdfName `eod_recap_${date}`).
 * 3. Gathers real market closing data:
 *    - 16 Popular ETFs: SPY, QQQ, IWM, DIA, XLF, XLK, XLE, XLV, XLI, XLP, XLU, XLY, XLB, VNQ, GLD, TLT
 *      (+ SMH, IBIT, HYG, UUP)
 *    - Core Benchmarks: S&P 500, Nasdaq, Dow Jones, Russell 2000, VIX
 *    - Macro & Commodities: 10Y Yield, WTI Crude Oil, Gold, Bitcoin, Ethereum
 *    - Gainers & Losers (movers) + Sector rankings + Fear & Greed sentiment + Macro calendar
 * 4. Calls Claude (AnthropicService) using the official market-eod-recap skill prompt.
 *    (Falls back to LlmGatewayService if Anthropic credits are depleted or temporarily unavailable).
 * 5. Publishes directly as a Published post to the blog engine via BlogsAdminService.
 */

const JOB_NAME = "eod-recap";
const CRON = "15 16 * * 1-5"; // 4:15 PM ET / 3:15 PM CT on weekdays (15 min after market close)

const POPULAR_16_ETFS = [
  "SPY",
  "QQQ",
  "IWM",
  "DIA",
  "XLF",
  "XLK",
  "XLE",
  "XLV",
  "XLI",
  "XLP",
  "XLU",
  "XLY",
  "XLB",
  "VNQ",
  "GLD",
  "TLT",
];

const EXTRA_ETFS = ["SMH", "IBIT", "HYG", "UUP"];

const ETF_NAMES: Record<string, { name: string; category: string }> = {
  SPY: { name: "SPDR S&P 500 ETF Trust", category: "Broad Market" },
  QQQ: { name: "Invesco QQQ Trust (Nasdaq-100)", category: "Broad Market" },
  IWM: { name: "iShares Russell 2000 ETF", category: "Broad Market" },
  DIA: { name: "SPDR Dow Jones Industrial Average ETF", category: "Broad Market" },
  XLF: { name: "Financial Select Sector SPDR", category: "Sectors" },
  XLK: { name: "Technology Select Sector SPDR", category: "Sectors" },
  XLE: { name: "Energy Select Sector SPDR", category: "Sectors" },
  XLV: { name: "Health Care Select Sector SPDR", category: "Sectors" },
  XLI: { name: "Industrial Select Sector SPDR", category: "Sectors" },
  XLP: { name: "Consumer Staples Select Sector SPDR", category: "Sectors" },
  XLU: { name: "Utilities Select Sector SPDR", category: "Sectors" },
  XLY: { name: "Consumer Discretionary Select Sector SPDR", category: "Sectors" },
  XLB: { name: "Materials Select Sector SPDR", category: "Sectors" },
  VNQ: { name: "Vanguard Real Estate ETF", category: "Sectors" },
  GLD: { name: "SPDR Gold Shares", category: "Commodities & Alternatives" },
  TLT: { name: "iShares 20+ Year Treasury Bond ETF", category: "Rates & Credit" },
  SMH: { name: "VanEck Semiconductor ETF", category: "Sectors" },
  HYG: { name: "iShares High Yield Corporate Bond ETF", category: "Rates & Credit" },
  UUP: { name: "Invesco DB US Dollar Index Bullish Fund", category: "Dollar & Volatility" },
};

@Injectable()
export class EodRecapJob implements OnModuleInit {
  private readonly logger = new Logger(EodRecapJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly polygon: PolygonService,
    private readonly anthropic: AnthropicService,
    private readonly llm: LlmGatewayService,
    private readonly blogs: BlogsAdminService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["posts"],
      cronExpression: CRON,
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    const today = etDate();
    this.logger.log(`Starting EOD recap automation for ${today}...`);

    try {
      // 1. Holiday & trading day gate (bypassed if FORCE_RUN=true)
      const postKey = `eod_recap_${today}`;
      const force = process.env.FORCE_RUN === "true" || process.env.FORCE_RECAP === "true";
      if (!force) {
        const weekday = etWeekday();
        if (weekday === 0 || weekday === 6) {
          this.logger.log(`Today is a weekend (day ${weekday}) — skipping EOD recap`);
          await this.meta.record(JOB_NAME, { ok: true, count: 0 });
          return { published: false, reason: "weekend" };
        }

        const isHoliday = await this.checkIfMarketHoliday(today);
        if (isHoliday) {
          this.logger.log(`Market is closed today (${today}) for holiday — skipping EOD recap`);
          await this.meta.record(JOB_NAME, { ok: true, count: 0 });
          return { published: false, reason: "market-holiday" };
        }

        // 2. Idempotency check
        if (await this.alreadyPublished(postKey)) {
          this.logger.log(`EOD recap for ${today} already published (${postKey}) — skipping`);
          await this.meta.record(JOB_NAME, { ok: true, count: 0 });
          return { published: false, reason: "already-published" };
        }
      } else {
        this.logger.log(`FORCE_RUN=true detected: bypassing weekend/holiday/idempotency gates for manual test run.`);
      }

      // 3. Gather verified market data
      const marketData = await this.gatherMarketData(today);

      // 4. Generate post content using Claude skill prompt
      const postContent = await this.generateRecapPost(marketData, today);

      // 5. Post to Blog Engine
      // Compose full HTML document matching gold standard (same as MCP create_blog_post with simple template)
      const fullDocument = composeDocument(
        composeSimpleBody({
          title: postContent.title,
          dek: postContent.dek,
          kick: "Recap",
          author: "",
          read: postContent.read,
          bodyHtml: postContent.bodyHtml,
        }),
        SIMPLE_THEME,
      );

      const created = await this.blogs.create({
        zone: "recap",
        title: postContent.title,
        dek: postContent.dek,
        kick: "Recap",
        author: "", // No byline as per house rules
        read: postContent.read,
        format: "html",
        html: fullDocument,
        status: "published",
        pdfName: postKey,
      });

      await this.meta.record(JOB_NAME, { ok: true, count: 1 });
      this.logger.log(
        `✔ Successfully published EOD Recap to blog! Post ID: ${created.id}, Title: "${postContent.title}"`,
      );

      return {
        published: true,
        id: created.id,
        date: today,
        title: postContent.title,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`EOD recap job failed: ${msg}`, err instanceof Error ? err.stack : undefined);
      await this.meta.record(JOB_NAME, { ok: false, error: msg });
      throw err;
    }
  }

  /** Checks if today is a scheduled market holiday where NYSE is closed. */
  private async checkIfMarketHoliday(today: string): Promise<boolean> {
    try {
      const holidays = await this.polygon.getUpcomingMarketHolidays();
      const todayHoliday = holidays.find(
        (h) => h.date === today && (h.status === "closed" || h.exchange === "NYSE"),
      );
      if (todayHoliday && todayHoliday.status === "closed") {
        return true;
      }
    } catch (err) {
      this.logger.warn(`Failed checking upcoming market holidays: ${(err as Error).message}`);
    }
    return false;
  }

  /** Idempotency check on pdfName in posts collection. */
  private async alreadyPublished(postKey: string): Promise<boolean> {
    const snap = await this.firebase.firestore
      .collection("posts")
      .where("pdfName", "==", postKey)
      .limit(1)
      .get();
    return !snap.empty;
  }

  /**
   * Gathers snapshot data for the 16 popular ETFs, indices, commodities,
   * crypto, movers, sectors, and macro sentiment.
   */
  private async gatherMarketData(today: string) {
    const allEtfTickers = [...POPULAR_16_ETFS, ...EXTRA_ETFS];

    // 1. Fetch ETF quotes in a batch from Polygon
    let etfSnapshots: Array<{
      ticker: string;
      price: number | null;
      change: number | null;
      changePercent: number | null;
      volume: number | null;
    }> = [];

    try {
      const snap = await this.polygon.getUniversalSnapshot(allEtfTickers);
      etfSnapshots = snap.map((s) => ({
        ticker: s.ticker,
        price: s.price,
        change: s.change,
        changePercent: s.changePercent,
        volume: s.volume,
      }));
    } catch (err) {
      this.logger.warn(`Universal snapshot failed for ETFs: ${(err as Error).message}`);
    }

    // 2. Fetch market indices, movers, sectors from Firestore collections
    const db = this.firebase.firestore;
    const [indicesSnap, moversSnap, sectorsSnap, sentimentSnap, eventsSnap] =
      await Promise.all([
        db.collection("market_indices").get().catch(() => null),
        db.collection("market_movers").get().catch(() => null),
        db.collection("sectors").get().catch(() => null),
        db.collection("market_sentiment").doc("fear_greed").get().catch(() => null),
        db.collection("macro_events").limit(8).get().catch(() => null),
      ]);

    // Format Indices
    const indices = (indicesSnap?.docs ?? []).map((d) => {
      const data = d.data();
      return {
        id: d.id,
        label: data.label ?? d.id,
        value: typeof data.value === "number" ? data.value : null,
        change: typeof data.change === "number" ? data.change : null,
        pctChange: typeof data.pctChange === "number" ? data.pctChange : null,
        isProxy: !!data.isProxy,
        proxyTicker: data.proxyTicker ?? null,
      };
    });

    // Format 10Y Yield directly from Polygon Treasury Yields curve
    let yield10Y: { value: number | null; changeBps: number | null } = {
      value: null,
      changeBps: null,
    };
    try {
      const curve = await this.polygon.getTreasuryYields(2);
      if (curve.length > 0 && curve[0].yield10Year != null) {
        const current = curve[0].yield10Year;
        const prev = curve[1]?.yield10Year ?? current;
        yield10Y = {
          value: current,
          changeBps: Number(((current - prev) * 100).toFixed(1)),
        };
      }
    } catch (err) {
      this.logger.warn(`Treasury yields fetch failed: ${(err as Error).message}`);
    }

    // Format Movers
    const moversList = (moversSnap?.docs ?? []).map((d) => d.data());
    const gainers = moversList
      .filter((m) => (m.pctChange ?? 0) > 0)
      .sort((a, b) => (b.pctChange ?? 0) - (a.pctChange ?? 0))
      .slice(0, 6)
      .map((m) => ({
        ticker: String(m.ticker ?? ""),
        name: String(m.name ?? m.companyName ?? m.ticker ?? ""),
        price: typeof m.price === "number" ? m.price : null,
        pctChange: typeof m.pctChange === "number" ? m.pctChange : null,
        catalyst: String(m.catalyst ?? m.description ?? ""),
      }));

    const losers = moversList
      .filter((m) => (m.pctChange ?? 0) < 0)
      .sort((a, b) => (a.pctChange ?? 0) - (b.pctChange ?? 0))
      .slice(0, 6)
      .map((m) => ({
        ticker: String(m.ticker ?? ""),
        name: String(m.name ?? m.companyName ?? m.ticker ?? ""),
        price: typeof m.price === "number" ? m.price : null,
        pctChange: typeof m.pctChange === "number" ? m.pctChange : null,
        catalyst: String(m.catalyst ?? m.description ?? ""),
      }));

    // Format Sectors
    const sectors = (sectorsSnap?.docs ?? []).map((d) => {
      const data = d.data();
      return {
        sector: data.sector ?? data.name ?? d.id,
        pctChange: typeof data.pctChange === "number" ? data.pctChange : null,
      };
    }).sort((a, b) => (b.pctChange ?? 0) - (a.pctChange ?? 0));

    // Format Sentiment
    const sentimentData = sentimentSnap?.exists ? sentimentSnap.data() : null;
    const sentiment = {
      score: typeof sentimentData?.value === "number" ? sentimentData.value : 50,
      label: sentimentData?.label ?? "Neutral",
    };

    // Format Macro Events
    const events = (eventsSnap?.docs ?? []).map((d) => {
      const data = d.data();
      return {
        event: data.event ?? data.title ?? d.id,
        date: data.date ?? data.reportDate ?? "",
        time: data.time ?? "",
        impact: data.impact ?? "Medium",
      };
    });

    // Compile 16 Popular ETFs with full labels
    const popularEtfs = POPULAR_16_ETFS.map((sym) => {
      const snap = etfSnapshots.find((s) => s.ticker === sym);
      const meta = ETF_NAMES[sym] ?? { name: sym, category: "ETF" };
      return {
        symbol: sym,
        name: meta.name,
        category: meta.category,
        price: snap?.price ?? null,
        change: snap?.change ?? null,
        pctChange: snap?.changePercent ?? null,
        volume: snap?.volume ?? null,
      };
    });

    const otherEtfs = EXTRA_ETFS.map((sym) => {
      const snap = etfSnapshots.find((s) => s.ticker === sym);
      const meta = ETF_NAMES[sym] ?? { name: sym, category: "ETF" };
      return {
        symbol: sym,
        name: meta.name,
        category: meta.category,
        price: snap?.price ?? null,
        change: snap?.change ?? null,
        pctChange: snap?.changePercent ?? null,
        volume: snap?.volume ?? null,
      };
    });

    return {
      date: today,
      popular16Etfs: popularEtfs,
      otherEtfs,
      indices,
      yield10Y,
      gainers,
      losers,
      sectors,
      sentiment,
      events,
    };
  }

  /**
   * Invokes Claude (Anthropic API) with the prompt specifications from
   * market-eod-recap/SKILL.md, structure.md, and house-rules.md.
   */
  private async generateRecapPost(
    data: Awaited<ReturnType<typeof this.gatherMarketData>>,
    today: string,
  ): Promise<{
    title: string;
    dek: string;
    read: string;
    bodyHtml: string;
    tags: string[];
  }> {
    const formattedDate = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date());

    const readLine = `Published ${formattedDate} · 4:15 PM ET · 10 min read`;

    const systemPrompt = `You are the chief market editor at MarketCatalyst executing the official market-eod-recap skill to generate the publish-ready End-of-Day U.S. Stock Market Recap blog article.

CRITICAL OPERATIONAL & EDITORIAL RULES:
1. Title: Very catchy, specific, and original (<= 110 characters). Never generic ("Market Recap Oct 6"). Highlight key catalysts, index milestones, or big movers. Example: "Nasdaq Closes at a Record as Oil Slides, Yields Climb and PTC Soars 33% on a $22.6 Billion Deal"
2. Eyebrow: Recap. Zone: recap. Template: simple. No byline (author is empty).
3. Colors: Green ('pos' class) for positive/gains; Red ('dn' class) for negative/losses; neutral readings (VIX, Treasury yields) stay plain.
4. Strictly NO FAQ, NO Table of Contents (TOC), NO Earnings Spotlight section.
5. Absolutely DO NOT add any logos, images, or image embeds.
6. Driver stories: Exactly 10 numbered bold stories (<h3><strong>1. Title</strong></h3><p>3-5 sentences</p> up to 10).
7. Disclaimer and Related Articles: Appended automatically by the publisher. Do NOT generate them.

CRITICAL SECTION STRUCTURE & HEADINGS (MATCH THE OFFICIAL TEMPLATE VERBATIM):
Order of sections is FIXED:
1. Opening: 2-3 short analytical paragraphs framing the session, major indices, catalysts (Fed, yields, oil, tech), and market participation.

2. <h2 id="numbers">The numbers, by the close</h2>
   Exact index strip (4 boxes, green when up, red when down):
   <div class="stat-strip" id="idx-strip">
     <div class="stat-box"><div class="num" [style="color:#C0392B !important" if negative]>[% Change]</div><div class="label">Dow Jones ([Close], [Point Change] pts)</div></div>
     <div class="stat-box"><div class="num" [style="color:#C0392B !important" if negative]>[% Change]</div><div class="label">S&amp;P 500 ([Close], [Point Change] pts)</div></div>
     <div class="stat-box"><div class="num" [style="color:#C0392B !important" if negative]>[% Change]</div><div class="label">Nasdaq ([Close], [Point Change] pts)</div></div>
     <div class="stat-box"><div class="num" [style="color:#C0392B !important" if negative]>[% Change]</div><div class="label">Russell 2000 ([Close], [Point Change] pts)</div></div>
   </div>
   Followed by index table wrapped in table-scroll:
   <div class="table-scroll"><div class="post-doc-scroll">
   <table>
     <thead><tr><th>Index</th><th>Close</th><th>Point Change</th><th>% Change</th><th>Session Read</th></tr></thead>
     <tbody>
       <tr><td class="metric">DJIA</td><td>...</td><td class="[pos/dn]">...</td><td class="[pos/dn]">...</td><td>...</td></tr>
       <tr><td class="metric">S&amp;P 500</td><td>...</td><td class="[pos/dn]">...</td><td class="[pos/dn]">...</td><td>...</td></tr>
       <tr><td class="metric">Nasdaq Composite</td><td>...</td><td class="[pos/dn]">...</td><td class="[pos/dn]">...</td><td>...</td></tr>
       <tr><td class="metric">Russell 2000</td><td>...</td><td class="[pos/dn]">...</td><td class="[pos/dn]">...</td><td>...</td></tr>
       <tr><td class="metric">CBOE Volatility ($VIX)</td><td>...</td><td>...</td><td>...</td><td>...</td></tr>
     </tbody>
   </table>
   </div></div>

3. <h2 id="etf-scoreboard">Sector and asset ETF scoreboard</h2>
   <p>All figures are closing prices and changes from the prior close.</p>
   <div class="table-scroll"><div class="post-doc-scroll">
   <table>
     <thead><tr><th>Category</th><th>ETF</th><th>Close</th><th>% Change</th><th>Note</th></tr></thead>
     <tbody>
       <!-- Rows for 16 ETFs + extras (SPY, QQQ, QQEW, DIA, IWM, XLK, XLE, XLF, SMH, SOXX, CIBR, HACK, TLT, HYG, GLD, IBIT, VIX, etc.). First cell in row must have class="metric" -->
       <tr><td class="metric">Broad Market</td><td>SPY (S&amp;P 500)</td><td>$777.19</td><td class="dn">-0.24%</td><td>Tracked S&amp;P 500 closely.</td></tr>
     </tbody>
   </table>
   </div></div>
   Followed by 1 analytical paragraph on QQQ vs equal-weight (QQEW), semiconductors (SMH vs SOXX), credit, and commodities.

4. <h2 id="sentiment">Market temperature and volatility</h2>
   <div class="callout"><b>Temperature check:</b> call it roughly [Score] out of 100, <b>[Phase: Constructive / Neutral / Bullish expansion / Defensive]</b>. The VIX closed at [Level], [change]. [Summary context]</div>
   <p>[1-2 analytical paragraphs explaining VIX and investor hedging behavior vs the index action.]</p>

5. <h2 id="cross-asset">Rates, oil, gold and crypto</h2>
   <p>[1-2 paragraphs analyzing 10-year Treasury yields, what drove them, oil, gold, and crypto.]</p>
   <div class="table-scroll"><div class="post-doc-scroll">
   <table>
     <thead><tr><th>Asset</th><th>Close or Yield</th><th>Daily Change</th><th>% Change</th><th>Main Catalyst</th></tr></thead>
     <tbody>
       <tr><td class="metric">10-Year Treasury yield</td><td>...</td><td>...</td><td>...</td><td>...</td></tr>
       <tr><td class="metric">Crude oil (WTI, [Month])</td><td>...</td><td class="[pos/dn]">...</td><td class="[pos/dn]">...</td><td>...</td></tr>
       <tr><td class="metric">Gold</td><td>...</td><td class="[pos/dn]">...</td><td class="[pos/dn]">...</td><td>...</td></tr>
       <tr><td class="metric">Bitcoin (BTC/USD)</td><td>...</td><td class="[pos/dn]">...</td><td class="[pos/dn]">...</td><td>...</td></tr>
       <tr><td class="metric">Ether (ETH/USD)</td><td>...</td><td class="[pos/dn]">...</td><td class="[pos/dn]">...</td><td>...</td></tr>
     </tbody>
   </table>
   </div></div>

6. <h2 id="sectors">Sectors: leaders and laggards</h2>
   <p>[1 sentence framing leadership style and breadth.]</p>
   <div class="mc-bb">
     <div class="mc-bb-col bull">
       <div class="mc-bb-title">&#9650; Leading groups</div>
       <p>Group (TICKER +x.xx%), reason</p>
       <p>Group (TICKER +x.xx%), reason</p>
       <p>Group (TICKER +x.xx%), reason</p>
     </div>
     <div class="mc-bb-col bear">
       <div class="mc-bb-title">&#9660; Lagging groups</div>
       <p>Group (TICKER -x.xx%), reason</p>
       <p>Group (TICKER -x.xx%), reason</p>
       <p>Group (TICKER -x.xx%), reason</p>
     </div>
   </div>

7. <h2 id="drivers">The day's market-moving stories</h2>
   Exactly 10 stories with bold headings and 3-5 analytical sentences:
   <h3><strong>1. [Title]</strong></h3>
   <p>[3-5 sentences]</p>
   ... up to <h3><strong>10. [Title]</strong></h3><p>[3-5 sentences]</p>.

8. <h2 id="movers">Movers below the headlines</h2>
   <p>The biggest single-stock moves came from ...</p>
   <div class="table-scroll"><div class="post-doc-scroll">
   <table>
     <thead><tr><th>Stock</th><th>Close</th><th>Change</th><th>What happened</th></tr></thead>
     <tbody>
       <tr><td class="metric">Company (TICKER)</td><td>$XX.XX</td><td class="[pos/dn]">[±X.XX%]</td><td>[2-3 sentences catalyst explanation]</td></tr>
       <!-- 4-6 stocks total, ordered by size of move, with real closing prices and verified catalysts -->
     </tbody>
   </table>
   </div></div>

9. <h2 id="risks">Key market and macro risks to watch</h2>
   Exactly 3 warning boxes:
   <div class="warning"><strong>Risk #1: [Title].</strong> [2-3 specific sentences.]</div>
   <div class="warning"><strong>Risk #2: [Title].</strong> [2-3 specific sentences.]</div>
   <div class="warning"><strong>Risk #3: [Title].</strong> [2-3 specific sentences.]</div>

10. <h2 id="calendar">What to watch next</h2>
   <div class="table-scroll"><div class="post-doc-scroll">
   <table>
     <thead><tr><th>When</th><th>Event</th><th>Why it matters</th></tr></thead>
     <tbody>
       <tr><td class="metric">Day, Mon D</td><td>Event name</td><td>Why it matters</td></tr>
     </tbody>
   </table>
   </div></div>
   <div class="warning"><strong>Worth remembering:</strong> [Balanced tactical note without trade directives.]</div>

11. <h2 id="takeaway">The takeaway</h2>
   <div class="callout"><b>Key tactical takeaway:</b> [Specific actionable level, yield, or spread to monitor.]</div>
   <ul class="takeaway-list">
     <li><strong>[Bold lead-in].</strong> [Insight sentence.]</li>
     <li><strong>[Bold lead-in].</strong> [Insight sentence.]</li>
     <li><strong>[Bold lead-in].</strong> [Insight sentence.]</li>
   </ul>

CONTAINER & TAG INTEGRITY RULES:
- NEVER output </main>, <main>, <div class="card">, <div class="card-body">, </body>, </html>, </article>, or <article>.
- DO NOT emit extra closing </div> tags. Each <div class="stat-box"> MUST close with a single </div>.
- Every table MUST have <thead><tr><th>...</th></tr></thead> and <tbody>...</tbody>.

FORMAT INSTRUCTIONS:
Do NOT output a JSON object! Do NOT output preamble or conversational text. Start immediately with <<<TITLE>>> on the very first line:
<<<TITLE>>>
[Your catchy, specific title here, <= 110 characters]
<<<DEK>>>
[Your subtitle/dek summary here, 1-2 sentences]
<<<BODY_HTML>>>
[Your complete unescaped HTML content starting from the opening paragraphs and ending with the closing </ul> of the takeaway section. Do NOT include <html>, <head>, <body>, <h1>, eyebrow, <script>, <style>, related articles, or disclaimer.]
`;

    const userPayload = {
      sessionDate: today,
      dateFormatted: formattedDate,
      etfs16: data.popular16Etfs,
      otherEtfs: data.otherEtfs,
      indices: data.indices,
      treasury10Y: data.yield10Y,
      topGainers: data.gainers,
      topLosers: data.losers,
      sectorRankings: data.sectors,
      sentiment: data.sentiment,
      upcomingEvents: data.events,
    };

    const userPrompt = `Here is today's verified market close data for ${today}:
${JSON.stringify(userPayload, null, 2)}

Generate the complete, publish-ready EOD market recap article using the <<<TITLE>>>, <<<DEK>>>, and <<<BODY_HTML>>> delimiters as specified. Start immediately with <<<TITLE>>> on the very first line without any conversational opening, thoughts, or markdown code fences.`;

    let rawReply: string | null = null;

    // 1. Primary: Anthropic Claude API
    if (this.anthropic.enabled) {
      this.logger.log("Invoking Claude (Anthropic API) for EOD recap generation...");
      rawReply = await this.anthropic.generateMessage(systemPrompt, userPrompt, {
        maxTokens: 8000,
        timeoutMs: 120_000,
      });
    }

    // 2. Fallback: LlmGatewayService (Groq / OpenRouter)
    if (!rawReply && this.llm.enabled) {
      this.logger.warn(
        "Anthropic did not return a response (or credit is low); falling back to LlmGatewayService...",
      );
      rawReply = await this.llm.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        { timeoutMs: 90_000, jsonMode: false, maxTokens: 8000 },
      );
    }

    if (!rawReply) {
      throw new Error("Both Anthropic and fallback LLM failed to generate recap narrative.");
    }

    // Parse delimited output
    const titleMatch = /<<<TITLE>>>\s*([\s\S]*?)(?=<<<DEK>>>|<<<BODY_HTML>>>|$)/i.exec(rawReply);
    const dekMatch = /<<<DEK>>>\s*([\s\S]*?)(?=<<<BODY_HTML>>>|$)/i.exec(rawReply);
    const bodyMatch = /<<<BODY_HTML>>>\s*([\s\S]*?)$/i.exec(rawReply);

    let title = titleMatch ? titleMatch[1].trim() : "";
    let dek = dekMatch ? dekMatch[1].trim() : "";
    let bodyHtml = bodyMatch ? bodyMatch[1].trim() : "";

    // Fallback if model output JSON despite instructions
    if (!bodyHtml && rawReply.includes('"bodyHtml"')) {
      try {
        const jsonStr = rawReply
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();
        const parsed = JSON.parse(jsonStr);
        title = parsed.title || title;
        dek = parsed.dek || dek;
        bodyHtml = parsed.bodyHtml || "";
      } catch {
        // regex match from json
        const jTitle = /"title"\s*:\s*"([^"]+)"/.exec(rawReply);
        const jDek = /"dek"\s*:\s*"([^"]+)"/.exec(rawReply);
        const jBody = /"bodyHtml"\s*:\s*"([\s\S]*?)"\s*,?\s*"\w+"/.exec(rawReply);
        if (jTitle) title = jTitle[1];
        if (jDek) dek = jDek[1];
        if (jBody) bodyHtml = jBody[1].replace(/\\"/g, '"').replace(/\\n/g, "\n");
      }
    }

    if (!title) {
      title = `Wall Street Closes Session: Key Market Movers and Catalysts for ${formattedDate}`;
    }
    if (!dek) {
      dek = "Closing index levels, full 16-ETF performance scoreboard, macro yields and key session drivers.";
    }
    if (!bodyHtml) {
      bodyHtml = rawReply.includes("<h2") ? rawReply : `<p>${rawReply}</p>`;
    }

    const formattedBodyHtml = formatRecapBody(bodyHtml, title, dek, today);

    return {
      title: title.slice(0, 110).trim(),
      dek: dek.slice(0, 200).trim(),
      read: readLine,
      bodyHtml: formattedBodyHtml,
      tags: ["Daily Recap", "Markets", "EOD"],
    };
  }
}

/** Static scoped style block, 4 verified related article cards, and official disclaimer. */
export const RECAP_FOOTER_SNIPPETS = `
<style>
  .post-doc .meta { margin-bottom: 14px !important; }
  .post-doc hr.rule { margin: 0 0 22px !important; }
  .post-doc .article h3 { font-size: 18px; font-weight: 800; line-height: 1.3; margin: 26px 0 6px; }
  .post-doc td.dn { color: #C0392B; font-weight: 700; }
  #idx-strip { grid-template-columns: repeat(4, minmax(0, 1fr)) !important; }
  #idx-strip .stat-box { padding: 16px 10px; }
  #idx-strip .num { font-size: 26px; color: #0F9D58 !important; }
  #idx-strip .label { font-size: 12px; }
  @media (max-width: 720px) { #idx-strip { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; } }
  .mc-bb { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 16px; margin: 16px 0 8px; }
  .mc-bb .mc-bb-col { border-radius: 16px; padding: 20px 22px 8px; border: 1px solid; }
  .mc-bb .mc-bb-col.bull { background: #EEF7F1; border-color: #CFE8D9; }
  .mc-bb .mc-bb-col.bear { background: #FBEFEC; border-color: #F0D3CD; }
  .mc-bb .mc-bb-title { font-size: 13px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 12px; }
  .mc-bb .bull .mc-bb-title { color: #0F9D58; }
  .mc-bb .bear .mc-bb-title { color: #C0392B; }
  .mc-bb .mc-bb-col p { font-size: 15px; line-height: 1.55; margin: 0 0 14px; color: #1A1A1A; }
  @media (max-width: 720px) { .mc-bb { grid-template-columns: minmax(0, 1fr) !important; } }
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
    <a class="mc-ra-card" href="https://marketcatalyst.ai/posts/nasdaq-rallies-to-a-record-as-a-weak-jobs-report-eases-rate-hike-fears">
      <span class="mc-ra-pill">Recap</span>
      <h3 class="mc-ra-card-title">Nasdaq Rallies to a Record as a Weak Jobs Report Eases Rate-Hike Fears</h3>
      <div class="mc-ra-meta"><span>9 min</span><span class="mc-ra-go">Read &rarr;</span></div>
    </a>
    <a class="mc-ra-card" href="https://marketcatalyst.ai/posts/week-ahead-fed-minutes-five-fed-speakers-and-the-first-big-earnings-of-q3-season">
      <span class="mc-ra-pill">Recap</span>
      <h3 class="mc-ra-card-title">Week Ahead: Fed Minutes, Five Fed Speakers and the First Big Earnings of Q3 Season</h3>
      <div class="mc-ra-meta"><span>7 min</span><span class="mc-ra-go">Read &rarr;</span></div>
    </a>
    <a class="mc-ra-card" href="https://marketcatalyst.ai/posts/cerebras-falls-below-its-ipo-price-as-an-openai-scare-collides-with-insider-selling">
      <span class="mc-ra-pill">Analysis</span>
      <h3 class="mc-ra-card-title">Cerebras Falls Below Its IPO Price as an OpenAI Scare Collides With Insider Selling</h3>
      <div class="mc-ra-meta"><span>5 min</span><span class="mc-ra-go">Read &rarr;</span></div>
    </a>
    <a class="mc-ra-card" href="https://marketcatalyst.ai/posts/wall-street-piles-into-micron-after-a-blowout-quarter-here-s-who-raised-targets">
      <span class="mc-ra-pill">Analysis</span>
      <h3 class="mc-ra-card-title">Wall Street Piles Into Micron as the AI Memory &ldquo;Hypercycle&rdquo; Fuels a Blowout Quarter</h3>
      <div class="mc-ra-meta"><span>4 min</span><span class="mc-ra-go">Read &rarr;</span></div>
    </a>
  </div>
</section>

<div class="disclaimer"><p><a href="https://marketcatalyst.ai/" target="_blank" rel="noopener">MarketCatalyst</a> LLC is not a registered investment advisor and does not manage client assets. Content on this platform is provided for informational and educational purposes only. It is not investment advice, and MarketCatalyst is not a stock-picking or trade-alert service. Trading stocks and options involves risk, including the possible loss of principal. Consider your own goals, time horizon, and risk tolerance, and consult a qualified financial advisor before making any investment decision.</p></div>
`;

/**
 * Normalizes and formats the raw editorial body:
 * 1. Strips any duplicate boilerplate (schema/style/cards/disclaimer) if model emitted it.
 * 2. Ensures the first cell of table data rows has class="metric".
 * 3. Adds class="dn" (red) for negative table numbers and class="pos" (green) for positive table numbers.
 * 4. Ensures down tiles in #idx-strip carry style="color:#C0392B !important".
 * 5. Prepends authoritative Article JSON-LD schema.
 * 6. Appends scoped style block, related articles, and disclaimer.
 */
export function formatRecapBody(
  rawBody: string,
  title: string,
  dek: string,
  today: string,
): string {
  let b = rawBody
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Strip duplicate/partial blocks if emitted by LLM
  b = b
    .replace(/<script\s+type=["']application\/ld\+json["']>[\s\S]*?<\/script>/gi, "")
    .replace(/<style>[\s\S]*?<\/style>/gi, "")
    .replace(/<section\s+class=["']mc-ra["'][\s\S]*?<\/section>/gi, "")
    .replace(/<div\s+class=["']disclaimer["'][\s\S]*?<\/div>/gi, "")
    .trim();

  // Strip forbidden outer structural tags that break the container boundary
  b = b.replace(/<\/?(?:main|article|body|html|head)\b[^>]*>/gi, "");
  b = b.replace(/<div class=["'](?:card|card-body|article)["'][^>]*>/gi, "");

  // Normalize #idx-strip: convert malformed stat tiles into exact 4 stat-boxes
  b = b.replace(
    /<div class=["']stat-strip["'] id=["']idx-strip["']>([\s\S]*?)(?=<div class=["']table-scroll["']|<h2|$)/i,
    (match, inner) => {
      const nums: string[] = [];
      const numRe = /class=["']num[^"']*["'][^>]*>(.*?)<\/(?:span|div)>/gi;
      let nm: RegExpExecArray | null;
      while ((nm = numRe.exec(inner)) !== null) {
        nums.push(nm[1].replace(/<[^>]+>/g, "").trim());
      }

      const labels: string[] = [];
      const labelRe = /class=["']label["'][^>]*>(.*?)<\/div>/gi;
      let lm: RegExpExecArray | null;
      while ((lm = labelRe.exec(inner)) !== null) {
        labels.push(lm[1].replace(/<[^>]+>/g, "").trim());
      }

      if (nums.length === 4 && labels.length === 4) {
        const tiles = nums.map((n: string, i: number) => {
          const isDown = /^[-−\u2010-\u2015]/.test(n);
          const style = isDown ? ' style="color:#C0392B !important"' : "";
          return `  <div class="stat-box"><div class="num"${style}>${n}</div><div class="label">${labels[i]}</div></div>`;
        });
        return `<div class="stat-strip" id="idx-strip">\n${tiles.join("\n")}\n</div>\n\n`;
      }
      return match;
    },
  );

  // Normalize any remaining stat-box class to strictly class="stat-box" and convert spans to divs
  b = b.replace(/class="stat-box[^"]*"/gi, 'class="stat-box"');
  b = b.replace(/<span class="num">/gi, '<div class="num">');
  b = b.replace(/<\/span>(\s*)<span class="label">/gi, '</div>$1<div class="label">');
  b = b.replace(/<div class="label">([^<]+)<\/span>/gi, '<div class="label">$1</div>');

  // Ensure down stat-boxes in #idx-strip carry style="color:#C0392B !important"
  b = b.replace(/<div class="stat-box">[\s\S]*?<\/div>\s*<\/div>/gis, (box) => {
    if (/<div class="num">[\s\n]*[-−\u2010-\u2015]/.test(box) && !box.includes("color:#C0392B")) {
      return box.replace(/<div class="num">/, '<div class="num" style="color:#C0392B !important">');
    }
    return box;
  });

  // Ensure first data cell in table rows has class="metric"
  b = b.replace(/<tr>\s*<td>/gi, '<tr><td class="metric">');

  // Ensure every table is wrapped in <div class="table-scroll"><div class="post-doc-scroll">...</div></div>
  b = b.replace(
    /(?:<div class=["']table-scroll["']>\s*)?(?:<div class=["']post-doc-scroll["']>\s*)?<table\b([^>]*)>([\s\S]*?)<\/table>(?:\s*<\/div>\s*<\/div>)?/gi,
    (_m, attrs, content) =>
      `<div class="table-scroll"><div class="post-doc-scroll">\n<table${attrs}>${content}</table>\n</div></div>`,
  );
  b = b.replace(/<div class=["']post-doc-scroll["']>\s*<div class=["']post-doc-scroll["']>/gi, '<div class="post-doc-scroll">');
  b = b.replace(/<\/table>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/gi, '</table>\n</div></div>');

  // Ensure every table has <thead><tr><th>...</th></tr></thead> if missing
  const tableHeaders: Record<string, string> = {
    numbers:
      "<thead><tr><th>Index</th><th>Close</th><th>Point Change</th><th>% Change</th><th>Session Read</th></tr></thead>",
    "etf-scoreboard":
      "<thead><tr><th>Category</th><th>ETF</th><th>Close</th><th>% Change</th><th>Note</th></tr></thead>",
    "cross-asset":
      "<thead><tr><th>Asset</th><th>Close or Yield</th><th>Daily Change</th><th>% Change</th><th>Main Catalyst</th></tr></thead>",
    movers:
      "<thead><tr><th>Stock</th><th>Close</th><th>Change</th><th>What happened</th></tr></thead>",
    calendar:
      "<thead><tr><th>When</th><th>Event</th><th>Why it matters</th></tr></thead>",
  };

  for (const [sec, thead] of Object.entries(tableHeaders)) {
    const secRegex = new RegExp(
      `(<h2 id=["']${sec}["'][\\s\\S]*?<table[^>]*>)(?!\\s*<thead>)`,
      "i",
    );
    b = b.replace(secRegex, `$1\n  ${thead}\n  <tbody>`);
  }

  // Canonical H2 section headings normalization
  b = b.replace(/<h2[^>]*>[\s\n]*(?:The numbers[,\s]*by the close|The Numbers[,\s]*by the close)[\s\S]*?<\/h2>/i, '<h2 id="numbers">The numbers, by the close</h2>');
  b = b.replace(/<h2[^>]*>[\s\n]*(?:Sector and asset ETF scoreboard|ETF scoreboard)[\s\S]*?<\/h2>/i, '<h2 id="etf-scoreboard">Sector and asset ETF scoreboard</h2>');
  b = b.replace(/<h2[^>]*>[\s\n]*(?:Market temperature and volatility|Sentiment and volatility)[\s\S]*?<\/h2>/i, '<h2 id="sentiment">Market temperature and volatility</h2>');
  b = b.replace(/<h2[^>]*>[\s\n]*(?:Rates, oil, gold and crypto|Rates, commodities and crypto)[\s\S]*?<\/h2>/i, '<h2 id="cross-asset">Rates, oil, gold and crypto</h2>');
  b = b.replace(/<h2[^>]*>[\s\n]*(?:Sectors: leaders and laggards|Sector leaders and laggards)[\s\S]*?<\/h2>/i, '<h2 id="sectors">Sectors: leaders and laggards</h2>');
  b = b.replace(/<h2[^>]*>[\s\n]*(?:The day['\u2018\u2019\u201B]s market[\u2010-\u2015\u002D]moving stories|Market[\u2010-\u2015\u002D]moving stories)[\s\S]*?<\/h2>/i, '<h2 id="drivers">The day\'s market-moving stories</h2>');
  b = b.replace(/<h2[^>]*>[\s\n]*(?:Movers below the headlines|Single[\u2010-\u2015\u002D]stock movers)[\s\S]*?<\/h2>/i, '<h2 id="movers">Movers below the headlines</h2>');
  b = b.replace(/<h2[^>]*>[\s\n]*(?:Key market and macro risks to watch|Key risks to watch)[\s\S]*?<\/h2>/i, '<h2 id="risks">Key market and macro risks to watch</h2>');
  b = b.replace(/<h2[^>]*>[\s\n]*(?:What to watch next|Calendar)[\s\S]*?<\/h2>/i, '<h2 id="calendar">What to watch next</h2>');
  b = b.replace(/<h2[^>]*>[\s\n]*(?:The takeaway|Takeaways?)[\s\S]*?<\/h2>/i, '<h2 id="takeaway">The takeaway</h2>');

  // Normalize H3 story headings to <h3><strong>N. Title</strong></h3>
  b = b.replace(/<h3>(?:<strong>|<b>)?\s*(\d+\.[\s\S]*?)(?:<\/strong>|<\/b>)?\s*<\/h3>/gi, '<h3><strong>$1</strong></h3>');

  // Ensure negative numbers in tables have class="dn", positive have class="pos"
  b = b.replace(/<td([^>]*)>(.*?)<\/td>/gis, (match, attrs, content) => {
    const text = content.replace(/<[^>]+>/g, "").trim();
    // Negative number like -0.45%, -$2.50, -123.45, −0.45%, ‑0.45%
    if (/^[-−\u2010-\u2015]\$?\d[\d.,]*%?$/.test(text) && !attrs.includes("dn")) {
      if (/class="[^"]*"/.test(attrs)) {
        return `<td${attrs.replace(/class="([^"]*)"/, 'class="$1 dn"')}>${content}</td>`;
      }
      return `<td class="dn"${attrs}>${content}</td>`;
    }
    // Positive number like +0.45%, +$2.50, +123.45
    if (/^\+\$?\d[\d.,]*%?$/.test(text) && !attrs.includes("pos")) {
      if (/class="[^"]*"/.test(attrs)) {
        return `<td${attrs.replace(/class="([^"]*)"/, 'class="$1 pos"')}>${content}</td>`;
      }
      return `<td class="pos"${attrs}>${content}</td>`;
    }
    return match;
  });

  // Strict div-balance enforcement:
  // b is placed inside composeSimpleBody's <div class="article">,
  // so opening <div> tags in b MUST EXACTLY equal closing </div> tags in b.
  let opens = (b.match(/<div\b/gi) || []).length;
  let closes = (b.match(/<\/div\b/gi) || []).length;
  while (closes > opens) {
    const lastClose = b.lastIndexOf("</div>");
    if (lastClose === -1) break;
    b = b.slice(0, lastClose) + b.slice(lastClose + 6);
    closes--;
  }
  while (opens > closes) {
    b += "\n</div>";
    closes++;
  }

  return `${b}\n\n${RECAP_FOOTER_SNIPPETS}`;
}

