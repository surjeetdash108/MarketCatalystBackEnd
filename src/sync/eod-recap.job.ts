import * as fs from "fs";
import * as path from "path";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { BlogsAdminService } from "../blogs/blogs-admin.service";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { FmpService } from "../vendors/fmp/fmp.service";
import { TAPE_INDICES } from "../live/tape-universe";
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
    private readonly fmp: FmpService,
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
      // Compose full HTML document matching exact gold standard template
      const fullDocument = composeRecapDocument({
        title: postContent.title,
        dek: postContent.dek,
        read: postContent.read,
        bodyHtml: postContent.bodyHtml,
      });

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
        source: String(data.source ?? "polygon"),
      };
    });

    // FMP fallback: any index / commodity / crypto the primary collection has
    // no usable row for (doc missing, or value / % change not a number) is
    // fetched from FMP as the instrument itself (ETHUSD, GCUSD, ^GSPC, ...).
    for (const sym of TAPE_INDICES) {
      if (!sym.fmpSymbol) continue;
      const have = indices.find((i) => i.id === sym.id);
      if (have && have.value != null && have.pctChange != null) continue;
      const q = await this.fmp.getQuote(sym.fmpSymbol);
      if (!q) {
        this.logger.warn(
          `No primary data for ${sym.id} and FMP fallback (${sym.fmpSymbol}) returned nothing`,
        );
        continue;
      }
      const row = {
        id: sym.id,
        label: sym.label,
        value: q.price,
        change: q.previousClose != null ? q.price - q.previousClose : null,
        pctChange: q.changePercentage,
        isProxy: false,
        proxyTicker: null,
        source: "fmp",
      };
      if (have) Object.assign(have, row);
      else indices.push(row);
      this.logger.log(`${sym.id}: primary had no data, served by FMP (${sym.fmpSymbol})`);
    }

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
1. Title: Very catchy, specific, and original (<= 110 characters). Never generic ("Market Recap Oct 6"). Highlight key catalysts, index milestones, or big movers. Example: "Nasdaq Rallies to a Record as a Weak Jobs Report Eases Rate-Hike Fears"
2. Eyebrow: Recap. Zone: recap. Template: simple. No byline (author is empty).
3. Colors: Green ('pos' class) for positive/gains; Red ('neg' class) for negative/losses; neutral readings (VIX, Treasury yields) stay plain.
4. Strictly NO FAQ, NO Earnings Spotlight section.
5. The Table of Contents (TOC) is MANDATORY and must list all 10 sections verbatim with their anchor hrefs.
6. Absolutely DO NOT add any logos, images, or image embeds.
7. Driver stories: Exactly 10 numbered stories (<h3>1. Title</h3><p>3-5 sentences</p> up to 10).
8. Disclaimer: Appended automatically by the publisher. Do NOT generate it.

CRITICAL SECTION STRUCTURE & HEADINGS (MATCH THE OFFICIAL TEMPLATE VERBATIM):
Order of sections is FIXED:

1. Table of Contents:
<div class="toc">
  <div class="toc-title">In this article</div>
  <ol>
    <li><a href="#numbers" rel="noopener noreferrer nofollow">The numbers, by the close</a></li>
    <li><a href="#etf-scoreboard" rel="noopener noreferrer nofollow">ETF scoreboard</a></li>
    <li><a href="#sentiment" rel="noopener noreferrer nofollow">Market temperature and volatility</a></li>
    <li><a href="#cross-asset" rel="noopener noreferrer nofollow">Rates, dollar, gold, and crypto</a></li>
    <li><a href="#sectors" rel="noopener noreferrer nofollow">Sectors: leaders and laggards</a></li>
    <li><a href="#drivers" rel="noopener noreferrer nofollow">The day's market-moving stories</a></li>
    <li><a href="#movers" rel="noopener noreferrer nofollow">Movers below the headlines</a></li>
    <li><a href="#risks" rel="noopener noreferrer nofollow">Key market &amp; macro risks to watch</a></li>
    <li><a href="#calendar" rel="noopener noreferrer nofollow">What to watch next</a></li>
    <li><a href="#takeaway" rel="noopener noreferrer nofollow">The takeaway</a></li>
  </ol>
</div>
<hr class="rule">

2. Opening narrative:
Two analytical paragraphs framing the session, major indices, catalysts (Fed, yields, data, tech), and market breadth/participation.

3. <h2 id="numbers">The numbers, by the close</h2>
<div class="stat-strip">
  <div class="stat-box"> [or <div class="stat-box neg"> if negative move]
    <div class="num">[+0.49% or -0.49%]</div>
    <div class="label">Dow Jones ([Close], [Point Change] pts)</div>
  </div>
  <div class="stat-box"> [or <div class="stat-box neg"> if negative move]
    <div class="num">[+0.73% or -0.73%]</div>
    <div class="label">S&amp;P 500 ([Close], [Point Change] pts)</div>
  </div>
  <div class="stat-box"> [or <div class="stat-box neg"> if negative move]
    <div class="num">[+1.19% or -1.19%]</div>
    <div class="label">Nasdaq ([Close], [Point Change] pts)</div>
  </div>
  <div class="stat-box"> [or <div class="stat-box neg"> if negative move]
    <div class="num">[+0.94% or -0.94%]</div>
    <div class="label">Russell 2000 ([Close], [Point Change] pts)</div>
  </div>
</div>
<div class="post-doc-scroll"><table>
  <thead>
    <tr><th>Index</th><th>Close</th><th>Point Change</th><th>% Change</th><th>Session Read</th></tr>
  </thead>
  <tbody>
    <tr><td class="metric">DJIA</td><td>...</td><td class="[pos/neg]">...</td><td class="[pos/neg]">...</td><td>...</td></tr>
    <tr><td class="metric">S&amp;P 500</td><td>...</td><td class="[pos/neg]">...</td><td class="[pos/neg]">...</td><td>...</td></tr>
    <tr><td class="metric">Nasdaq Composite</td><td>...</td><td class="[pos/neg]">...</td><td class="[pos/neg]">...</td><td>...</td></tr>
    <tr><td class="metric">Russell 2000</td><td>...</td><td class="[pos/neg]">...</td><td class="[pos/neg]">...</td><td>...</td></tr>
    <tr><td class="metric">CBOE VIX ($VIX)</td><td>...</td><td class="[pos/neg]">...</td><td class="[pos/neg]">...</td><td>...</td></tr>
  </tbody>
</table></div>

4. <h2 id="etf-scoreboard">ETF scoreboard</h2>
<p>[1 analytical paragraph summarizing ETF performance and rotations.]</p>
<div class="post-doc-scroll"><table>
  <thead>
    <tr><th>Category</th><th>ETF</th><th>Close</th><th>% Change</th><th>Note</th></tr>
  </thead>
  <tbody>
    <!-- 16 popular ETFs + extras -->
    <tr><td class="metric">Broad Market</td><td>SPY (S&amp;P 500)</td><td>$XXX.XX</td><td class="[pos/neg]">[±X.XX%]</td><td>[Brief note]</td></tr>
    ...
  </tbody>
</table></div>
<p style="font-size:13px;color:#5B6472;margin-top:-20px">[Optional note: VNQ, UUP, EFA, and EEM are not shown; their closes could not be independently verified for this session.]</p>

5. <h2 id="sentiment">Market temperature and volatility</h2>
<div class="callout">
  <strong>Temperature: [Score]/100 — [Phase: Constructive / Neutral / Bullish expansion / Defensive].</strong> [1-2 sentences on VIX level and option pricing.]
</div>
<p>[1-2 analytical paragraphs on volatility, option hedges, and dealer positioning.]</p>

6. <h2 id="cross-asset">Rates, dollar, gold, and crypto</h2>
<p>[1-2 analytical paragraphs on yields, the dollar, gold, and crypto.]</p>
<div class="post-doc-scroll"><table>
  <thead>
    <tr><th>Asset</th><th>Close or Yield</th><th>Daily Change</th><th>% Change</th><th>Main Catalyst</th></tr>
  </thead>
  <tbody>
    <tr><td class="metric">10Y Treasury Yield</td><td>...</td><td class="[pos/neg]">...</td><td class="[pos/neg]">...</td><td>...</td></tr>
    <tr><td class="metric">Gold (XAU/USD)</td><td>...</td><td class="[pos/neg]">...</td><td class="[pos/neg]">...</td><td>...</td></tr>
    <tr><td class="metric">Bitcoin (BTC/USD)</td><td>...</td><td class="[pos/neg]">...</td><td class="[pos/neg]">...</td><td>...</td></tr>
    <tr><td class="metric">Ethereum (ETH/USD)</td><td>...</td><td class="[pos/neg]">...</td><td class="[pos/neg]">...</td><td>...</td></tr>
  </tbody>
</table></div>

7. <h2 id="sectors">Sectors: leaders and laggards</h2>
<p>[1 paragraph on sector breadth and market leadership.]</p>
<div class="bullbear-wrap">
  <div class="bb-col bull">
    <div class="bb-title">▲ Leading groups</div>
    <ul>
      <li>[Sector (ETF +X.XX%) on catalyst]</li>
      ...
    </ul>
  </div>
  <div class="bb-col bear">
    <div class="bb-title">▼ Lagging groups</div>
    <ul>
      <li>[Sector (ETF -X.XX%) on catalyst]</li>
      ...
    </ul>
  </div>
</div>

8. <h2 id="drivers">The day's market-moving stories</h2>
Exactly 10 stories with numbered headings:
<h3>1. [Title]</h3>
<p>[3-5 analytical sentences]</p>
... up to <h3>10. [Title]</h3><p>[3-5 analytical sentences]</p>.

9. <h2 id="movers">Movers below the headlines</h2>
<p>[1 intro paragraph.]</p>
<div class="post-doc-scroll"><table>
  <thead>
    <tr><th>Stock</th><th>Close</th><th>Change</th><th>What happened</th></tr>
  </thead>
  <tbody>
    <tr><td class="metric">Company (TICKER)</td><td>$XX.XX</td><td class="[pos/neg]">[±X.XX%]</td><td>[2-3 sentences catalyst explanation]</td></tr>
  </tbody>
</table></div>
<p>[1 closing summary paragraph.]</p>

10. <h2 id="risks">Key market &amp; macro risks to watch</h2>
Exactly 4 risk boxes:
<div class="risk-box">
  <div class="risk-title">Risk #1: [Title]</div>
  <p>[2-3 sentences]</p>
</div>
<div class="risk-box">
  <div class="risk-title">Risk #2: [Title]</div>
  <p>[2-3 sentences]</p>
</div>
<div class="risk-box">
  <div class="risk-title">Risk #3: [Title]</div>
  <p>[2-3 sentences]</p>
</div>
<div class="risk-box">
  <div class="risk-title">Risk #4: [Title]</div>
  <p>[2-3 sentences]</p>
</div>

11. <h2 id="calendar">What to watch next</h2>
<div class="timeline">
  <div class="timeline-item [flag]">
    <div class="timeline-date">[Timing]</div>
    <div class="timeline-text">[Event and context]</div>
  </div>
  ...
</div>
<div class="warning">
  <strong>Worth remembering:</strong> [Balanced tactical note without trade directives.]
</div>

12. <h2 id="takeaway">The takeaway</h2>
<div class="callout">
  <strong>Key tactical takeaway:</strong> [Specific actionable level, yield, or spread to monitor.]
</div>
<ul class="takeaway-list">
  <li><strong>[Bold lead-in]:</strong> [Insight sentence.]</li>
  <li><strong>[Bold lead-in]:</strong> [Insight sentence.]</li>
  <li><strong>[Bold lead-in]:</strong> [Insight sentence.]</li>
</ul>

CONTAINER & TAG INTEGRITY RULES:
- NEVER output </main>, <main>, <div class="card">, <div class="card-body">, </body>, </html>, </article>, or <article>.
- DO NOT emit extra closing </div> tags.
- Every table MUST have <thead><tr><th>...</th></tr></thead> and <tbody>...</tbody>, wrapped in <div class="post-doc-scroll">.
- Use class="pos" for positive table cells, class="neg" for negative table cells.

FORMAT INSTRUCTIONS:
Do NOT output a JSON object! Do NOT output preamble or conversational text. Start immediately with <<<TITLE>>> on the very first line:
<<<TITLE>>>
[Your catchy, specific title here, <= 110 characters]
<<<DEK>>>
[Your subtitle/dek summary here, 1-2 sentences]
<<<BODY_HTML>>>
[Your complete unescaped HTML content starting from <div class="toc"> and ending with the closing </ul> of the takeaway section. Do NOT include <html>, <head>, <body>, <h1>, eyebrow, <script>, <style>, related articles, or disclaimer.]
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

/**
 * Exact CSS extracted verbatim from the live gold standard post:
 * https://marketcatalyst.ai/posts/nasdaq-rallies-to-a-record-as-a-weak-jobs-report-eases-rate-hike-fears
 */
export const RECAP_TEMPLATE_CSS = `:where(.post-doc), :where(.post-doc *), :where(.post-doc *::before), :where(.post-doc *::after) { box-sizing: border-box; }
:where(.post-doc) { width: 100%; max-width: 1180px; margin-left: auto; margin-right: auto; padding: 0 clamp(16px, 4vw, 32px); box-sizing: border-box; }
:where(.post-doc img), :where(.post-doc svg), :where(.post-doc video) { max-width: 100%; height: auto; }
:where(.post-doc pre) { overflow-x: auto; }
:where(.post-doc table) { border-collapse: collapse; }
/* The wrapper put around every table below. Inert at full width; it is what
   lets a wide table scroll instead of widening the page. */
:where(.post-doc) .post-doc-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; }

.post-doc :where(.post-doc), .post-doc :where(.post-doc *), .post-doc :where(.post-doc *::before), .post-doc :where(.post-doc *::after){ box-sizing: border-box; }.post-doc :where(.post-doc){ width: 100%; margin: 0; }.post-doc :where(.post-doc img), .post-doc :where(.post-doc svg), .post-doc :where(.post-doc video){ max-width: 100%; height: auto; }.post-doc :where(.post-doc pre){ overflow-x: auto; }.post-doc :where(.post-doc table){ border-collapse: collapse; }.post-doc :where(.post-doc) .post-doc-scroll{ overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; }.post-doc{
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
  }@media (max-width: 640px){.post-doc header{ padding: 16px 20px; }.post-doc .card{ padding: 32px 24px; }.post-doc h1{ font-size: 30px; }.post-doc .subtitle{ font-size: 17px; }.post-doc .stat-strip{ grid-template-columns: 1fr; }.post-doc table{ font-size: 13px; }.post-doc th, .post-doc td{ padding: 8px 6px; }.post-doc .bar-row{ grid-template-columns: 40px 1fr 52px; }}.post-doc > *{ max-width: 100% !important; }@media (max-width: 1024px){.post-doc *{ min-width: 0 !important; }.post-doc *{ max-width: 100% !important; }}@media (max-width: 760px){.post-doc :where(img, svg, video, canvas){ height: auto !important; }.post-doc :where(p, li, td, th, dd, blockquote, figcaption){ overflow-wrap: break-word; }.post-doc :where(h1, h2, h3, h4, h5, h6, p, li, dd, blockquote, figcaption, a, span, div, strong, em){
    white-space: normal !important;
  }.post-doc :where(header, nav){ position: static !important; }}@media (max-width: 560px){.post-doc :where(div, section, main, article, aside, ul, ol){
    grid-template-columns: minmax(0, 1fr) !important;
  }.post-doc :where(div, section, ul, ol){ flex-wrap: wrap; }}.post-doc .mc-recap-root :root{
    --cream: #F3EFE7;
    --white: #FFFFFF;
    --ink: #1A1A1A;
    --gray-text: #5B6472;
    --blue: #2563EB;
    --border: #E4DFD3;
    --pill-border: #D9D3C4;
    --green: #0F9D58;
    --red: #C0392B;
    --amber: #C98A1E;
  }.post-doc .mc-recap-root{ color: #1A1A1A; }.post-doc .mc-recap-root .toc{
    background: #F7F5EF;
    border: 1px solid #E4DFD3;
    border-radius: 14px;
    padding: 20px 24px;
    margin: 0 0 36px;
  }.post-doc .mc-recap-root .toc-title{
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: #5B6472;
    margin-bottom: 10px;
  }.post-doc .mc-recap-root .toc ol{ margin: 0; padding-left: 20px; columns: 2; column-gap: 32px; }.post-doc .mc-recap-root .toc li{ margin-bottom: 8px; font-size: 15px; break-inside: avoid; }.post-doc .mc-recap-root .toc a{ color: #2563EB; text-decoration: none; }.post-doc .mc-recap-root .toc a:hover{ text-decoration: underline; }.post-doc .mc-recap-root hr.rule{ border: none; border-top: 1px solid #E4DFD3; margin: 0 0 40px; }.post-doc .mc-recap-root p{
    font-size: 18px;
    line-height: 1.7;
    color: #2B2F36;
    margin: 0 0 22px;
  }.post-doc .mc-recap-root h2{
    font-size: 26px;
    font-weight: 800;
    margin: 44px 0 16px;
    letter-spacing: -0.3px;
    scroll-margin-top: 24px;
  }.post-doc .mc-recap-root h3{ font-size: 19px; font-weight: 700; margin: 30px 0 8px; }.post-doc .mc-recap-root .stat-strip{
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    margin: 8px 0 36px;
  }.post-doc .mc-recap-root .stat-box{
    background: #F7F5EF;
    border: 1px solid #E4DFD3;
    border-radius: 14px;
    padding: 20px 16px;
    text-align: center;
  }.post-doc .mc-recap-root .stat-box .num{ font-size: 24px; font-weight: 800; color: #0F9D58; line-height: 1.1; }.post-doc .mc-recap-root .stat-box.neg .num{ color: #C0392B; }.post-doc .mc-recap-root .stat-box .label{ font-size: 13px; color: #5B6472; margin-top: 6px; }.post-doc .mc-recap-root .callout{
    background: #F7F5EF;
    border: 1px solid #E4DFD3;
    border-left: 4px solid #2563EB;
    border-radius: 10px;
    padding: 20px 24px;
    margin: 28px 0;
    font-size: 17px;
    line-height: 1.6;
  }.post-doc .mc-recap-root .warning{
    background: #FDF7EE;
    border: 1px solid #F0E1BE;
    border-left: 4px solid #C98A1E;
    border-radius: 10px;
    padding: 20px 24px;
    margin: 32px 0;
    font-size: 16px;
    line-height: 1.6;
    color: #5B4A26;
  }.post-doc .mc-recap-root .risk-box{
    background: #FBF0EE;
    border: 1px solid #F0CFC9;
    border-left: 4px solid #C0392B;
    border-radius: 10px;
    padding: 22px 24px;
    margin: 24px 0;
  }.post-doc .mc-recap-root .risk-box .risk-title{
    font-size: 14px;
    font-weight: 800;
    color: #C0392B;
    letter-spacing: 0.3px;
    text-transform: uppercase;
    margin-bottom: 10px;
  }.post-doc .mc-recap-root .risk-box p{ font-size: 16.5px; line-height: 1.65; color: #2B2F36; margin: 0 0 14px; }.post-doc .mc-recap-root .risk-box p:last-child{ margin-bottom: 0; }.post-doc .mc-recap-root table{ width: 100%; border-collapse: collapse; margin: 24px 0 36px; font-size: 15px; }.post-doc .mc-recap-root th{
    text-align: left;
    font-size: 13px;
    letter-spacing: 0.5px;
    color: #5B6472;
    font-weight: 700;
    padding: 10px 12px;
    border-bottom: 2px solid #E4DFD3;
  }.post-doc .mc-recap-root td{ padding: 12px 12px; border-bottom: 1px solid #E4DFD3; vertical-align: top; }.post-doc .mc-recap-root td.metric{ font-weight: 700; color: #1A1A1A; }.post-doc .mc-recap-root td.pos{ color: #0F9D58; font-weight: 700; }.post-doc .mc-recap-root td.neg{ color: #C0392B; font-weight: 700; }.post-doc .mc-recap-root .takeaway-list{ margin: 0 0 22px; padding-left: 20px; }.post-doc .mc-recap-root .takeaway-list li{ font-size: 18px; line-height: 1.7; color: #2B2F36; margin-bottom: 14px; }.post-doc .mc-recap-root .takeaway-list strong{ color: #1A1A1A; }.post-doc .mc-recap-root .timeline{ margin: 8px 0 36px; padding: 4px 0 4px 4px; }.post-doc .mc-recap-root .timeline-item{
    position: relative;
    padding-left: 28px;
    padding-bottom: 22px;
    border-left: 2px solid #E4DFD3;
    margin-left: 6px;
  }.post-doc .mc-recap-root .timeline-item:last-child{ border-left: 2px solid transparent; padding-bottom: 0; }.post-doc .mc-recap-root .timeline-item::before{
    content: "";
    position: absolute;
    left: -7px;
    top: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #2563EB;
    border: 2px solid #fff;
    box-shadow: 0 0 0 2px #2563EB;
  }.post-doc .mc-recap-root .timeline-item.flag::before{ background: #C0392B; box-shadow: 0 0 0 2px #C0392B; }.post-doc .mc-recap-root .timeline-item.good::before{ background: #0F9D58; box-shadow: 0 0 0 2px #0F9D58; }.post-doc .mc-recap-root .timeline-date{
    font-size: 13px;
    font-weight: 800;
    color: #5B6472;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    margin-bottom: 3px;
  }.post-doc .mc-recap-root .timeline-text{ font-size: 16px; line-height: 1.55; color: #2B2F36; }.post-doc .mc-recap-root .bullbear-wrap{ display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 8px 0 36px; }.post-doc .mc-recap-root .bb-col{ border-radius: 14px; padding: 20px 22px; border: 1px solid; }.post-doc .mc-recap-root .bb-col.bull{ background: #F2FAF5; border-color: #CDEBD9; }.post-doc .mc-recap-root .bb-col.bear{ background: #FBF0EE; border-color: #F0CFC9; }.post-doc .mc-recap-root .bb-title{ font-size: 13px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 12px; }.post-doc .mc-recap-root .bb-col.bull .bb-title{ color: #0F9D58; }.post-doc .mc-recap-root .bb-col.bear .bb-title{ color: #C0392B; }.post-doc .mc-recap-root .bb-col ul{ margin: 0; padding-left: 18px; }.post-doc .mc-recap-root .bb-col li{ font-size: 15px; line-height: 1.55; margin-bottom: 10px; color: #2B2F36; }.post-doc .mc-recap-root .bb-col li:last-child{ margin-bottom: 0; }.post-doc .mc-recap-root .disclaimer{ margin-top: 20px; padding-top: 4px; }.post-doc .mc-recap-root .disclaimer p{ font-size: 13px; line-height: 1.6; color: #9A9FA8; margin: 0 0 10px; }@media (max-width: 640px){.post-doc .mc-recap-root .stat-strip{ grid-template-columns: 1fr 1fr; }.post-doc .mc-recap-root .toc ol{ columns: 1; }.post-doc .mc-recap-root .bullbear-wrap{ grid-template-columns: 1fr; }}

.post-doc { max-width: 1180px !important; margin-left: auto !important; margin-right: auto !important; width: 100% !important; box-sizing: border-box !important; }
.post-doc > * { max-width: 100% !important; }
.post-doc > div { max-width: 100% !important; width: 100% !important; }
.post-doc main { max-width: 100% !important; margin-left: auto !important; margin-right: auto !important; padding: 0 0 80px !important; width: 100% !important; }
.post-doc .card { max-width: 100% !important; margin-left: auto !important; margin-right: auto !important; margin-bottom: 36px !important; width: 100% !important; }
.post-doc .card-body { padding: 36px clamp(20px, 4vw, 56px) 0; }
.post-doc .stat-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin: 20px 0 32px; }
.post-doc .bullbear-wrap { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px; margin: 24px 0 32px; }
.post-doc .toc ol { columns: 2; column-gap: 32px; }

@media (max-width: 1024px) {
  .post-doc * { min-width: 0; }
  .post-doc * { max-width: 100%; }
}
@media (max-width: 768px) {
  .post-doc .card-body { padding: 24px 16px 0 !important; }
  .post-doc .stat-strip { grid-template-columns: repeat(2, 1fr) !important; gap: 10px !important; }
  .post-doc .bullbear-wrap { grid-template-columns: 1fr !important; gap: 14px !important; }
  .post-doc .toc ol { columns: 1 !important; }
  .post-doc :where(img, svg, video, canvas) { height: auto !important; }
  .post-doc :where(p, li, td, th, dd, blockquote, figcaption) { overflow-wrap: break-word; }
  .post-doc :where(h1, h2, h3, h4, h5, h6, p, li, dd, blockquote, figcaption, a, span, div, strong, em) {
    white-space: normal !important;
  }
  .post-doc :where(header, nav) { position: static !important; }
}
@media (max-width: 480px) {
  .post-doc .stat-strip { grid-template-columns: 1fr !important; }
  .post-doc :where(div, section, main, article, aside, ul, ol) {
    grid-template-columns: minmax(0, 1fr) !important;
  }
  .post-doc :where(div, section, ul, ol) { flex-wrap: wrap; }
}
`;

/**
 * Composes the complete standalone HTML document matching the exact gold-standard
 * template: https://marketcatalyst.ai/posts/nasdaq-rallies-to-a-record-as-a-weak-jobs-report-eases-rate-hike-fears
 */
export function composeRecapDocument(input: {
  title: string;
  dek: string;
  read: string;
  bodyHtml: string;
}): string {
  return `<!doctype html>
<html>
<head>
<style>
${RECAP_TEMPLATE_CSS}
</style>
</head>
<body>
<div><div><main>
  <div class="card">
    <div class="card-body">
    <div class="eyebrow">Recap</div>
    <h1>${input.title}</h1>
    <p class="subtitle">${input.dek}</p>
    <div class="meta"><span>${input.read}</span></div>
    <hr class="rule">
    <div class="article">

<div class="mc-recap-root">
${input.bodyHtml}

<div class="disclaimer">
  <p><a href="https://marketcatalyst.ai/" target="_blank" rel="noopener noreferrer nofollow">MarketCatalyst</a> LLC is not a registered investment advisor and does not manage client assets. Content on this platform is provided for informational and educational purposes only. It is not investment advice, and MarketCatalyst is not a stock-picking or trade-alert service. Trading stocks and options involves risk, including the possible loss of principal. Consider your own goals, time horizon, and risk tolerance, and consult a qualified financial advisor before making any investment decision.</p>
</div>

</div>
    </div>
    </div>
  </div>
</main></div></div>
</body>
</html>`;
}

const CANONICAL_TOC = `<div class="toc">
  <div class="toc-title">In this article</div>
  <ol>
    <li><a href="#numbers" rel="noopener noreferrer nofollow">The numbers, by the close</a></li>
    <li><a href="#etf-scoreboard" rel="noopener noreferrer nofollow">ETF scoreboard</a></li>
    <li><a href="#sentiment" rel="noopener noreferrer nofollow">Market temperature and volatility</a></li>
    <li><a href="#cross-asset" rel="noopener noreferrer nofollow">Rates, dollar, gold, and crypto</a></li>
    <li><a href="#sectors" rel="noopener noreferrer nofollow">Sectors: leaders and laggards</a></li>
    <li><a href="#drivers" rel="noopener noreferrer nofollow">The day's market-moving stories</a></li>
    <li><a href="#movers" rel="noopener noreferrer nofollow">Movers below the headlines</a></li>
    <li><a href="#risks" rel="noopener noreferrer nofollow">Key market &amp; macro risks to watch</a></li>
    <li><a href="#calendar" rel="noopener noreferrer nofollow">What to watch next</a></li>
    <li><a href="#takeaway" rel="noopener noreferrer nofollow">The takeaway</a></li>
  </ol>
</div>
<hr class="rule">`;

/**
 * Normalizes and formats the raw editorial body:
 * 1. Strips any duplicate boilerplate (schema/style/cards/disclaimer) if model emitted it.
 * 2. Ensures canonical Table of Contents is present.
 * 3. Ensures stat-box items use class="stat-box" and class="stat-box neg" for negative moves.
 * 4. Ensures the first cell of table data rows has class="metric".
 * 5. Adds class="neg" (red) for negative table numbers and class="pos" (green) for positive table numbers.
 * 6. Wraps every table in <div class="post-doc-scroll">.
 * 7. Enforces strict div-balancing.
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
  b = b.replace(/<div class=["'](?:card|card-body|article|mc-recap-root)["'][^>]*>/gi, "");

  // Ensure canonical Table of Contents is present
  if (!/<div class=["']toc["']/i.test(b)) {
    b = `${CANONICAL_TOC}\n\n${b}`;
  } else {
    // If TOC exists, ensure it is followed by <hr class="rule">
    b = b.replace(
      /(<div class=["']toc["'][\s\S]*?<\/div>)(?!\s*<hr class=["']rule["']>)/i,
      `$1\n<hr class="rule">`,
    );
  }

  // Remove any legacy id="idx-strip" attributes
  b = b.replace(/\s*id=["']idx-strip["']/gi, "");

  // Normalize stat-strip and stat-box: ensure negative numbers have class="stat-box neg"
  b = b.replace(/<div class=["']stat-box[^"']*["']\s*>([\s\S]*?)<\/div>/gis, (match, inner) => {
    const isDown = /class=["']num[^"']*["'][^>]*>[\s\n]*[-−\u2010-\u2015]/.test(inner);
    const cleanedInner = inner.replace(/style=["'][^"']*["']/gi, "");
    return `<div class="${isDown ? "stat-box neg" : "stat-box"}">${cleanedInner}</div>`;
  });

  // Ensure first data cell in table rows has class="metric"
  b = b.replace(/<tr>\s*<td>/gi, '<tr><td class="metric">');

  // Ensure every table is wrapped in <div class="post-doc-scroll">...</div>
  b = b.replace(
    /(?:<div class=["'](?:table-scroll|post-doc-scroll)["']>\s*)+<table\b([^>]*)>([\s\S]*?)<\/table>(?:\s*<\/div>)+/gi,
    (_m, attrs, content) =>
      `<div class="post-doc-scroll"><table>${content}</table></div>`,
  );
  b = b.replace(
    /(?<!<div class=["']post-doc-scroll["']>\s*)<table\b([^>]*)>([\s\S]*?)<\/table>/gi,
    (_m, attrs, content) =>
      `<div class="post-doc-scroll"><table>${content}</table></div>`,
  );

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
  b = b.replace(/<h2[^>]*>[\s\n]*(?:Sector and asset ETF scoreboard|ETF scoreboard)[\s\S]*?<\/h2>/i, '<h2 id="etf-scoreboard">ETF scoreboard</h2>');
  b = b.replace(/<h2[^>]*>[\s\n]*(?:Market temperature and volatility|Sentiment and volatility)[\s\S]*?<\/h2>/i, '<h2 id="sentiment">Market temperature and volatility</h2>');
  b = b.replace(/<h2[^>]*>[\s\n]*(?:Rates, dollar, gold[,\s]*and crypto|Rates, oil, gold and crypto|Rates, commodities and crypto)[\s\S]*?<\/h2>/i, '<h2 id="cross-asset">Rates, dollar, gold, and crypto</h2>');
  b = b.replace(/<h2[^>]*>[\s\n]*(?:Sectors: leaders and laggards|Sector leaders and laggards)[\s\S]*?<\/h2>/i, '<h2 id="sectors">Sectors: leaders and laggards</h2>');
  b = b.replace(/<h2[^>]*>[\s\n]*(?:The day['\u2018\u2019\u201B]s market[\u2010-\u2015\u002D]moving stories|Market[\u2010-\u2015\u002D]moving stories)[\s\S]*?<\/h2>/i, '<h2 id="drivers">The day\'s market-moving stories</h2>');
  b = b.replace(/<h2[^>]*>[\s\n]*(?:Movers below the headlines|Single[\u2010-\u2015\u002D]stock movers)[\s\S]*?<\/h2>/i, '<h2 id="movers">Movers below the headlines</h2>');
  b = b.replace(/<h2[^>]*>[\s\n]*(?:Key market &amp; macro risks to watch|Key market and macro risks to watch|Key risks to watch)[\s\S]*?<\/h2>/i, '<h2 id="risks">Key market &amp; macro risks to watch</h2>');
  b = b.replace(/<h2[^>]*>[\s\n]*(?:What to watch next|Calendar)[\s\S]*?<\/h2>/i, '<h2 id="calendar">What to watch next</h2>');
  b = b.replace(/<h2[^>]*>[\s\n]*(?:The takeaway|Takeaways?)[\s\S]*?<\/h2>/i, '<h2 id="takeaway">The takeaway</h2>');

  // Normalize H3 story headings to <h3>N. Title</h3>
  b = b.replace(/<h3>(?:<strong>|<b>)?\s*(\d+\.[\s\S]*?)(?:<\/strong>|<\/b>)?\s*<\/h3>/gi, '<h3>$1</h3>');

  // Convert any legacy "dn" class to "neg"
  b = b.replace(/\bclass=["']([^"']*\s)?dn(\s[^"']*)?["']/gi, 'class="$1neg$2"');

  // Ensure negative numbers in tables have class="neg", positive have class="pos"
  b = b.replace(/<td([^>]*)>(.*?)<\/td>/gis, (match, attrs, content) => {
    const text = content.replace(/<[^>]+>/g, "").trim();
    // Negative number like -0.45%, -$2.50, -123.45, −0.45%, ‑0.45%
    if (/^[-−\u2010-\u2015]\$?\d[\d.,]*%?$/.test(text) && !attrs.includes("neg")) {
      if (/class="[^"]*"/.test(attrs)) {
        return `<td${attrs.replace(/class="([^"]*)"/, 'class="$1 neg"')}>${content}</td>`;
      }
      return `<td class="neg"${attrs}>${content}</td>`;
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

  // Always normalize "Ether" to "Ethereum"
  b = b.replace(/\bEther\b/g, "Ethereum");

  // Strict div-balance enforcement:
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

  return b;
}

