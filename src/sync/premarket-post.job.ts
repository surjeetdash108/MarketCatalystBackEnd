import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { BlogsAdminService } from "../blogs/blogs-admin.service";
import { PolygonService } from "../vendors/polygon/polygon.service";
import { FmpService } from "../vendors/fmp/fmp.service";
import { AnthropicService } from "../vendors/anthropic/anthropic.service";
import { LlmGatewayService } from "../vendors/llm-gateway.service";
import { etDate, etWeekday } from "../common/market-calendar.util";

/**
 * Automated Pre-Market Morning Post Job.
 *
 * Runs every US trading day at 7:35 AM Central (8:35 AM ET) — 5 minutes after
 * the critical 7:30 AM CT (8:30 AM ET) economic releases (CPI, PPI, Jobless Claims,
 * NFP, Retail Sales) cross the wire.
 *
 * Inputs:
 * 1. Fresh 7:30 AM CT economic releases (actual vs. consensus vs. prior) + upcoming 9:00 AM CT data.
 * 2. Pre-market movers snapshot (frozen % change, prices, and verified catalysts).
 * 3. Previous day AMC & this morning's BMO earnings reactions & conference call follow-through.
 * 4. Fresh analyst upgrades, downgrades, and price target actions.
 * 5. Tonight's earnings on deck (AMC) with consensus expectations.
 *
 * Output:
 * - Published as a standard blog article (zone: "news", kick: "Markets").
 * - Follows the Barron's pre-market structure:
 *   - Eyebrow: MARKETS
 *   - Title: "[Tickers...] and More Stocks Moving Before the Bell: What Could Happen Today"
 *   - "In this article" ticker chips (green / red with frozen %)
 *   - "Key Points" callout card with top 3 catalysts
 *   - Macro opening paragraph (futures, yields, energy, dollar)
 *   - Individual mover paragraphs with inline badges & verified reasons
 *   - "What could happen today: Scenarios to monitor" (STRICTLY conditional, non-predictive)
 *   - Economic data & earnings tables
 *   - Standard disclaimer
 */

const JOB_NAME = "premarket-post";
// 7:35 AM Central Time (CST/CDT) = 8:35 AM Eastern Time on trading weekdays
const CRON = "35 7 * * 1-5";

export const PREMARKET_TEMPLATE_CSS = `
:where(.post-doc), :where(.post-doc *), :where(.post-doc *::before), :where(.post-doc *::after) { box-sizing: border-box; }
:where(.post-doc) { width: 100%; max-width: 1180px; margin-left: auto; margin-right: auto; padding: 0 clamp(16px, 4vw, 32px); box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111827; }
:where(.post-doc img), :where(.post-doc svg), :where(.post-doc video) { max-width: 100%; height: auto; }
:where(.post-doc table) { border-collapse: collapse; }
:where(.post-doc) .post-doc-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; }

.post-doc .eyebrow {
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #1A73E8;
  margin-bottom: 12px;
}

.post-doc h1 {
  font-family: "Georgia", "Merriweather", serif;
  font-size: clamp(28px, 4vw, 42px);
  line-height: 1.18;
  font-weight: 700;
  color: #111827;
  margin: 0 0 16px 0;
  letter-spacing: -0.02em;
}

.post-doc .subtitle {
  font-size: clamp(17px, 2vw, 20px);
  line-height: 1.45;
  color: #4B5563;
  margin: 0 0 16px 0;
}

.post-doc .meta {
  font-size: 13px;
  color: #6B7280;
  margin-bottom: 24px;
}

.post-doc hr.rule {
  border: none;
  border-top: 1px solid #E5E7EB;
  margin: 0 0 28px;
}

/* In this article ticker pills */
.post-doc .in-this-article {
  margin: 0 0 28px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.post-doc .in-this-article-label {
  font-size: 13px;
  font-weight: 700;
  color: #111827;
  letter-spacing: -0.2px;
}

.post-doc .in-this-article-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.post-doc .ticker-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.3px;
  text-decoration: none;
}

.post-doc .ticker-chip.neg {
  background: #FDF2F2;
  border: 1px solid #FBD5D5;
  color: #9B1C1C;
}

.post-doc .ticker-chip.pos {
  background: #F0FDF4;
  border: 1px solid #BCF0DA;
  color: #03543F;
}

.post-doc .ticker-chip .chip-arrow {
  font-size: 11px;
}

/* Key Points callout box */
.post-doc .key-points-card {
  border: 1px solid #E5E7EB;
  border-radius: 8px;
  padding: 22px 24px 20px;
  background: #FFFFFF;
  margin: 20px 0 32px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
}

.post-doc .key-points-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.post-doc .key-points-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: #111827;
  font-family: inherit;
}

.post-doc .key-points-about {
  font-size: 12px;
  color: #6B7280;
  display: inline-flex;
  align-items: center;
}

.post-doc .key-points-list {
  margin: 0;
  padding-left: 18px;
  list-style-type: disc;
}

.post-doc .key-points-list li {
  font-size: 16px;
  line-height: 1.6;
  color: #374151;
  margin-bottom: 12px;
}

.post-doc .key-points-list li:last-child {
  margin-bottom: 0;
}

.post-doc .key-points-list strong {
  color: #111827;
  font-weight: 700;
}

/* Prose */
.post-doc p {
  font-size: 17px;
  line-height: 1.7;
  color: #2B2F36;
  margin: 0 0 20px;
}

/* Inline badges for movers */
.post-doc .inline-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 600;
  margin: 0 4px;
  vertical-align: baseline;
  white-space: nowrap;
}

.post-doc .inline-chip.neg {
  background: #FDF2F2;
  color: #9B1C1C;
  border: 1px solid #FBD5D5;
}

.post-doc .inline-chip.pos {
  background: #F0FDF4;
  color: #03543F;
  border: 1px solid #BCF0DA;
}

/* Sections */
.post-doc h2 {
  font-size: 24px;
  font-weight: 700;
  color: #111827;
  margin: 36px 0 16px;
  letter-spacing: -0.01em;
}

.post-doc h3 {
  font-size: 18px;
  font-weight: 700;
  color: #111827;
  margin: 24px 0 12px;
}

/* Scenario list */
.post-doc .scenario-list {
  margin: 0 0 24px;
  padding-left: 20px;
}

.post-doc .scenario-list li {
  font-size: 16px;
  line-height: 1.65;
  color: #374151;
  margin-bottom: 12px;
}

.post-doc .scenario-list strong {
  color: #111827;
}

/* Data tables */
.post-doc table {
  width: 100%;
  border-collapse: collapse;
  margin: 20px 0 32px;
  font-size: 14px;
}

.post-doc th {
  text-align: left;
  font-size: 12px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: #6B7280;
  font-weight: 700;
  padding: 10px 12px;
  border-bottom: 2px solid #E5E7EB;
  background: #F9FAFB;
}

.post-doc td {
  padding: 11px 12px;
  border-bottom: 1px solid #E5E7EB;
  vertical-align: top;
  color: #1F2937;
}

.post-doc td.pos { color: #0F9D58; font-weight: 700; }
.post-doc td.neg { color: #C0392B; font-weight: 700; }
.post-doc td.metric { font-weight: 700; color: #111827; }

/* Disclaimer */
.post-doc .disclaimer {
  margin-top: 44px;
  padding-top: 20px;
  border-top: 1px solid #E5E7EB;
}

.post-doc .disclaimer p {
  font-size: 13px;
  line-height: 1.6;
  color: #6B7280;
  margin: 0 0 10px;
}
`;

export function composePremarketDocument(input: {
  title: string;
  dek: string;
  read: string;
  bodyHtml: string;
}): string {
  return `<!doctype html>
<html>
<head>
<style>
${PREMARKET_TEMPLATE_CSS}
</style>
</head>
<body>
<div id="mc-post-doc" class="post-doc">
  <div class="eyebrow">MARKETS</div>
  <h1>${input.title}</h1>
  <p class="subtitle">${input.dek}</p>
  <div class="meta"><span>${input.read}</span></div>
  <hr class="rule">
  <div class="article">
${input.bodyHtml}

    <div class="disclaimer">
      <p><strong>Disclaimer:</strong> This briefing is published for informational and educational purposes only and does not constitute financial, investment, or trading advice. MarketCatalyst is not a registered investment advisor and does not manage client assets. Pre-market trading carries elevated volatility and lower liquidity. All scenarios described outline potential catalysts and do not represent predictions or guarantees of future market performance. Trading stocks and options involves risk of principal loss.</p>
    </div>
  </div>
</div>
</body>
</html>`;
}

@Injectable()
export class PremarketPostJob implements OnModuleInit {
  private readonly logger = new Logger(PremarketPostJob.name);

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
      timeZone: "America/Chicago",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    const today = etDate();
    this.logger.log(`Starting Pre-Market Post automation for ${today}...`);

    try {
      const postKey = `premarket_post_${today}`;
      const force =
        process.env.FORCE_RUN === "true" ||
        process.env.FORCE_PREMARKET === "true";

      if (!force) {
        const weekday = etWeekday();
        if (weekday === 0 || weekday === 6) {
          this.logger.log(
            `Today is a weekend (day ${weekday}) — skipping Pre-Market post`,
          );
          await this.meta.record(JOB_NAME, { ok: true, count: 0 });
          return { published: false, reason: "weekend" };
        }

        const isHoliday = await this.checkIfMarketHoliday(today);
        if (isHoliday) {
          this.logger.log(
            `Market is closed today (${today}) for holiday — skipping Pre-Market post`,
          );
          await this.meta.record(JOB_NAME, { ok: true, count: 0 });
          return { published: false, reason: "market-holiday" };
        }

        if (await this.alreadyPublished(postKey)) {
          this.logger.log(
            `Pre-market post for ${today} already published (${postKey}) — skipping`,
          );
          await this.meta.record(JOB_NAME, { ok: true, count: 0 });
          return { published: false, reason: "already-published" };
        }
      } else {
        this.logger.log(
          `FORCE_RUN=true detected: bypassing weekend/holiday/idempotency gates.`,
        );
      }

      // 1. Gather all data layers
      const data = await this.gatherPremarketData(today);

      // 2. Generate publication prose via AI
      const postContent = await this.generatePremarketPost(data, today);

      // 3. Compose full HTML document matching Barron's house style
      const fullDocument = composePremarketDocument({
        title: postContent.title,
        dek: postContent.dek,
        read: postContent.read,
        bodyHtml: postContent.bodyHtml,
      });

      // 4. Publish as standard blog post in zone: "news"
      const created = await this.blogs.create({
        zone: "news",
        title: postContent.title,
        dek: postContent.dek,
        kick: "Markets",
        author: "",
        read: postContent.read,
        format: "html",
        html: fullDocument,
        status: "Published",
        editorsChoice: false,
        pdfName: postKey,
      });

      this.logger.log(
        `Pre-Market post published successfully: id=${created.id} title="${postContent.title}"`,
      );
      await this.meta.record(JOB_NAME, { ok: true, count: 1 });
      return { published: true, id: created.id, title: postContent.title };
    } catch (err: any) {
      this.logger.error(
        `Pre-Market post automation failed: ${err.message}`,
        err.stack,
      );
      await this.meta.record(JOB_NAME, { ok: false, error: err.message });
      throw err;
    }
  }

  private async checkIfMarketHoliday(dateStr: string): Promise<boolean> {
    try {
      const holidays = await this.polygon.getUpcomingMarketHolidays();
      return (holidays ?? []).some(
        (h) => h.date === dateStr && h.status === "closed",
      );
    } catch (err: any) {
      this.logger.warn(`Failed to check holiday status: ${err.message}`);
      return false;
    }
  }

  private async alreadyPublished(postKey: string): Promise<boolean> {
    try {
      const snap = await this.firebase.firestore
        .collection("posts")
        .where("pdfName", "==", postKey)
        .limit(1)
        .get();
      return !snap.empty;
    } catch (err: any) {
      this.logger.warn(
        `Error checking post idempotency for ${postKey}: ${err.message}`,
      );
      return false;
    }
  }

  /**
   * Gathers all 5 data feeds required for the 7:35 AM CT briefing:
   */
  private async gatherPremarketData(today: string) {
    const db = this.firebase.firestore;

    // Yesterday calculation for AMC earnings
    const todayDate = new Date(today + "T12:00:00Z");
    const yesterdayDate = new Date(todayDate);
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    if (yesterdayDate.getUTCDay() === 0) yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 2); // if Sun -> Fri
    const yesterday = yesterdayDate.toISOString().slice(0, 10);

    const [
      macroSnapshots,
      treasuryYields,
      ecoEvents,
      earningsToday,
      earningsYesterday,
      stockNews,
      moversSnap,
      analystSnap,
    ] = await Promise.all([
      this.polygon
        .getUniversalSnapshot(["SPY", "QQQ", "DIA", "IWM", "GLD", "TLT", "UUP", "USO"])
        .catch(() => []),
      this.polygon.getTreasuryYields(2).catch(() => null),
      this.fmp.getEconomicCalendar(today, today).catch(() => []),
      this.fmp.getEarningsCalendar(today, today).catch(() => []),
      this.fmp.getEarningsCalendar(yesterday, yesterday).catch(() => []),
      this.fmp.getLatestStockNews(2, 100).catch(() => []),
      db.collection("market_movers").limit(40).get().catch(() => null),
      db.collection("analyst_actions").limit(30).get().catch(() => null),
    ]);

    // Format macro indices
    const macro: Record<string, any> = {};
    for (const snap of macroSnapshots) {
      const pct =
        snap.earlyTradingChangePercent != null
          ? snap.earlyTradingChangePercent
          : snap.changePercent ?? 0;
      macro[snap.ticker] = {
        ticker: snap.ticker,
        price: snap.price,
        changePercent: pct,
        volume: snap.volume,
        previousClose: snap.previousClose,
      };
    }

    // Format 10Y Yield
    const yield10Y = treasuryYields?.yield10Year ?? 4.12;

    // Filter US Economic Events
    const usEco = (ecoEvents || []).filter(
      (e) => (e.country === "US" || !e.country) && e.event,
    );
    const released730 = usEco.filter(
      (e) =>
        e.actual != null ||
        e.date.includes("08:30") ||
        e.date.includes("13:30") ||
        e.date.includes("12:30"),
    );
    const upcomingToday = usEco.filter(
      (e) => !released730.includes(e),
    );

    // Earnings segregation
    const bmoReporters = (earningsToday || []).filter(
      (e) => e.epsActual != null || e.revenueActual != null,
    );
    const amcReportersYesterday = (earningsYesterday || []).filter(
      (e) => e.epsActual != null || e.revenueActual != null,
    );
    const amcOnDeckTonight = (earningsToday || []).filter(
      (e) => e.epsActual == null && e.revenueActual == null,
    );

    // Movers extraction & screening (price >= $5, volume, clean move)
    const rawMovers = (moversSnap?.docs ?? []).map((d) => d.data());
    const screenedMovers: any[] = [];
    for (const m of rawMovers) {
      if (!m.ticker) continue;
      const price = m.lastClose ?? m.price ?? 0;
      const pct = m.pctChange ?? 0;
      if (price >= 5 && Math.abs(pct) >= 1.5) {
        screenedMovers.push({
          ticker: m.ticker,
          companyName: m.companyName || m.name || m.ticker,
          pctChange: pct,
          price,
          volume: m.volume,
          direction: pct >= 0 ? "up" : "down",
          catalystHeadline: m.catalystHeadline || null,
          catalystSummary: m.catalystSummary || null,
        });
      }
    }
    screenedMovers.sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange));

    // Analyst actions formatting
    const analystActions: any[] = [];
    for (const doc of analystSnap?.docs ?? []) {
      const d = doc.data();
      const recent = (d.recentGrades || [])[0];
      if (recent && d.ticker) {
        analystActions.push({
          ticker: d.ticker,
          firm: recent.firm,
          action: recent.action || "reiterate",
          previousGrade: recent.previousGrade,
          newGrade: recent.newGrade,
          priceTarget: recent.priceTarget,
          consensus: d.consensus,
        });
      }
    }

    return {
      date: today,
      macro,
      yield10Y,
      economic: {
        released730: released730.slice(0, 6).map((e) => ({
          event: e.event,
          actual: e.actual,
          estimate: e.estimate,
          previous: e.previous,
          impact: e.impact,
        })),
        upcomingToday: upcomingToday.slice(0, 6).map((e) => ({
          event: e.event,
          estimate: e.estimate,
          previous: e.previous,
          impact: e.impact,
        })),
      },
      earnings: {
        yesterdayAmc: amcReportersYesterday.slice(0, 6).map((e) => ({
          symbol: e.symbol,
          epsActual: e.epsActual,
          epsEstimated: e.epsEstimated,
        })),
        todayBmo: bmoReporters.slice(0, 6).map((e) => ({
          symbol: e.symbol,
          epsActual: e.epsActual,
          epsEstimated: e.epsEstimated,
        })),
        tonightAmc: amcOnDeckTonight.slice(0, 6).map((e) => ({
          symbol: e.symbol,
          epsEstimated: e.epsEstimated,
          revenueEstimated: e.revenueEstimated,
        })),
      },
      movers: screenedMovers.slice(0, 8),
      analystActions: analystActions.slice(0, 6),
      stockNews: (stockNews || []).slice(0, 8).map((n) => ({
        symbol: n.symbol,
        title: n.title,
        site: n.site,
      })),
    };
  }

  /**
   * Invokes AI to compose the pre-market narrative strictly adhering to legal compliance rules.
   */
  private async generatePremarketPost(data: any, today: string) {
    const formattedDate = new Date(today + "T12:00:00Z").toLocaleDateString(
      "en-US",
      { weekday: "long", month: "long", day: "numeric", year: "numeric" },
    );
    const dayName = new Date(today + "T12:00:00Z").toLocaleDateString("en-US", {
      weekday: "long",
    });

    const systemPrompt = `You are MarketCatalyst's senior pre-market intelligence strategist and financial editor.
You write daily institutional morning briefings published at 7:35 AM Central (8:35 AM ET) before the 8:30 AM CT opening bell.

CRITICAL COMPLIANCE AND SECURITIES LAW RULES:
1. NEVER STATE ANYTHING AS A DIRECT CERTAINTY OR DEFINITIVE PREDICTION.
2. NEVER SAY "this will happen", "the market will drop", "stocks will rally", "is guaranteed to", or "the Fed will cut".
3. ALWAYS USE CONDITIONAL, OBSERVATIONAL, AND SCENARIO-BASED LANGUAGE:
   - "This could happen"
   - "What traders could watch for today"
   - "Potential scenarios to monitor"
   - "Could see heightened volatility if..."
   - "Traders are watching whether..."
   - "If bond yields test higher levels, high-multiple technology equities could face headwinds"
   STATING OR GIVING FALSE CLARITY EXPOSES US TO SECURITIES LAWSUITS. MAINTAIN INSTITUTIONAL OBJECTIVITY AT ALL TIMES.
4. NO CLICKABLE LINKS: DO NOT generate any <a> tags or URL links anywhere in the post. All company names, indices, futures, and ticker references must be clean plain text (or <strong> bold tags).
5. NO WALL STREET ANALYST ACTIONS SECTION: Do NOT create any section, heading, or table for Wall Street analyst actions.

TEMPLATE REQUIREMENTS (100% MATCHING BARRON'S STYLE LAYOUT):
You must output exactly three delimited sections:
<<<TITLE>>>
Headline listing leading tickers followed by our approved series name. Example:
"Palantir, Intel, Wolfspeed, PepsiCo, and More Stocks Moving Before the Bell: What Could Happen Today"

<<<DEK>>>
A sharp, engaging one-sentence deck summarizing the pre-market setup. Example:
"Stock futures ease and Treasury yields edge higher following fresh morning data as investors assess chipmaker guidance and key corporate financing deals ahead of the opening bell."

<<<BODY_HTML>>>
HTML markup only (NO outer <html>, <head>, or <body> tags). Must contain:

1. Ticker Chips:
<div class="in-this-article">
  <div class="in-this-article-label">In this article</div>
  <div class="in-this-article-chips">
    <!-- 4 to 8 chips for the leading movers -->
    <span class="ticker-chip neg"><span class="chip-arrow">↓</span> INTC -3.47%</span>
    <span class="ticker-chip pos"><span class="chip-arrow">↑</span> PLTR +2.80%</span>
    ...
  </div>
</div>

2. Key Points Box:
<div class="key-points-card">
  <div class="key-points-header">
    <h3 class="key-points-title">Key Points</h3>
    <span class="key-points-about">About This Summary <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -1px; margin-left: 2px;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg></span>
  </div>
  <ul class="key-points-list">
    <li><strong>[Company/Ticker]</strong> [Key catalyst: earnings, upgrade, deal, or macro move]</li>
    <li><strong>[Company/Ticker]</strong> [Key catalyst]</li>
    <li><strong>[Company/Ticker]</strong> [Key catalyst]</li>
  </ul>
</div>

3. Macro Opener:
One well-crafted paragraph setting the morning tone (futures SPY/QQQ/DIA, 10-year Treasury yield, energy/crude oil, dollar, and reaction to the 7:30 AM CT prints). All plain text, NO clickable links.

4. Movers & Catalysts Paragraphs:
3 to 5 narrative paragraphs analyzing the active stocks and sector themes.
Each stock mention MUST have:
- Company Name in plain text (NO links/URLs, e.g. "Chip maker Intel declined 2.5%...")
- Inline chip badge: <span class="inline-chip neg">↓ TICKER -X.XX%</span> or <span class="inline-chip pos">↑ TICKER +X.XX%</span>
- Verified reason (earnings beat/miss, contract, M&A, financing, or sector sympathy).

5. What Could Happen Today (Scenarios to Monitor):
<h2 id="scenarios">What could happen today: Scenarios to monitor</h2>
<p>Introductory paragraph framing the day's open...</p>
<ul class="scenario-list">
  <li><strong>Macro & Yield Scenarios:</strong> [Conditional analysis on how yields and morning prints could shape equity appetite at the open]</li>
  <li><strong>Earnings Conference Call Follow-Through:</strong> [What management commentary could signal for ongoing sector trends]</li>
  <li><strong>Key Technical & Psychological Levels:</strong> [Support/resistance context on broad index ETFs]</li>
</ul>

6. Economic Data Today Table:
<h3>Economic data on deck today</h3>
<table>
  <thead>
    <tr>
      <th>Time (CT)</th>
      <th>Release</th>
      <th>Actual</th>
      <th>Consensus</th>
      <th>Prior</th>
      <th>Impact</th>
    </tr>
  </thead>
  <tbody>
    <!-- rows of 7:30 AM releases and upcoming 9:00 AM releases -->
  </tbody>
</table>

7. Earnings to Watch Tonight (AMC) Table:
<h3>Earnings to watch tonight</h3>
<table>
  <thead>
    <tr>
      <th>Company</th>
      <th>Ticker</th>
      <th>Timing</th>
      <th>Est. EPS</th>
      <th>Est. Revenue</th>
      <th>What to watch</th>
    </tr>
  </thead>
  <tbody>
    <!-- rows of tonight's reporters -->
  </tbody>
</table>
`;

    const userPrompt = `Compose the Pre-Market Intelligence Briefing for ${formattedDate} (${dayName}) using the following verified market data:

DATA SNAPSHOT:
- SPY (S&P 500 Proxy): Price $${data.macro.SPY?.price ?? "N/A"}, Move: ${data.macro.SPY?.changePercent != null ? (data.macro.SPY.changePercent >= 0 ? "+" : "") + data.macro.SPY.changePercent.toFixed(2) + "%" : "N/A"}
- QQQ (Nasdaq-100 Proxy): Price $${data.macro.QQQ?.price ?? "N/A"}, Move: ${data.macro.QQQ?.changePercent != null ? (data.macro.QQQ.changePercent >= 0 ? "+" : "") + data.macro.QQQ.changePercent.toFixed(2) + "%" : "N/A"}
- DIA (Dow Proxy): Price $${data.macro.DIA?.price ?? "N/A"}, Move: ${data.macro.DIA?.changePercent != null ? (data.macro.DIA.changePercent >= 0 ? "+" : "") + data.macro.DIA.changePercent.toFixed(2) + "%" : "N/A"}
- 10-Year Treasury Yield: ${typeof data.yield10Y === "number" ? data.yield10Y.toFixed(2) : data.yield10Y}%

7:30 AM CT RECENT ECONOMIC RELEASES:
${JSON.stringify(data.economic.released730, null, 2)}

UPCOMING ECONOMIC RELEASES TODAY:
${JSON.stringify(data.economic.upcomingToday, null, 2)}

PRE-MARKET MOVERS & CATALYSTS:
${JSON.stringify(data.movers, null, 2)}

YESTERDAY AMC & TODAY BMO EARNINGS:
${JSON.stringify({ yesterdayAmc: data.earnings.yesterdayAmc, todayBmo: data.earnings.todayBmo }, null, 2)}

TONIGHT AMC EARNINGS ON DECK:
${JSON.stringify(data.earnings.tonightAmc, null, 2)}

HEADLINES & NEWS FEED:
${JSON.stringify(data.stockNews.slice(0, 8), null, 2)}

Remember the strict compliance directive:
- NEVER state anything as certainty. Use "this could happen", "scenarios to monitor", "what traders are watching".
- NO clickable links or <a> tags anywhere.
- NO Wall Street analyst actions section.
Output with <<<TITLE>>>, <<<DEK>>>, and <<<BODY_HTML>>> delimiters.`;

    let rawReply: string | null = null;

    if (this.anthropic.enabled) {
      try {
        this.logger.log("Generating Pre-Market post narrative via Anthropic...");
        rawReply = await this.anthropic.generateMessage(
          systemPrompt,
          userPrompt,
          {
            maxTokens: 5000,
          },
        );
      } catch (err: any) {
        this.logger.warn(`Anthropic generation failed: ${err.message}`);
      }
    }

    if (!rawReply && this.llm.enabled) {
      this.logger.log("Generating Pre-Market post narrative via LlmGatewayService...");
      rawReply = await this.llm.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        { timeoutMs: 90_000, jsonMode: false, maxTokens: 6000 },
      );
    }

    if (!rawReply) {
      throw new Error(
        "Both Anthropic and fallback LLM failed to generate premarket post narrative.",
      );
    }

    // Parse delimited output
    const titleMatch =
      /<<<TITLE>>>\s*([\s\S]*?)(?=<<<DEK>>>|<<<BODY_HTML>>>|$)/i.exec(rawReply);
    const dekMatch =
      /<<<DEK>>>\s*([\s\S]*?)(?=<<<BODY_HTML>>>|$)/i.exec(rawReply);
    const bodyMatch = /<<<BODY_HTML>>>\s*([\s\S]*?)$/i.exec(rawReply);

    let title = titleMatch ? titleMatch[1].trim() : "";
    let dek = dekMatch ? dekMatch[1].trim() : "";
    let bodyHtml = bodyMatch ? bodyMatch[1].trim() : "";

    if (!title) {
      title = `Stocks Moving Before the Bell: What Could Happen Today — ${formattedDate}`;
    }
    if (!dek) {
      dek = `Futures fluctuate and bond yields adjust as traders evaluate fresh morning economic data, key earnings, and analyst calls ahead of the opening bell.`;
    }
    if (!bodyHtml) {
      bodyHtml = `<p>Futures fluctuate as markets assess morning catalysts and key single-stock earnings ahead of the open.</p>`;
    }

    // Format & sanitize bodyHtml
    bodyHtml = this.formatPremarketBody(bodyHtml);

    const words = bodyHtml.replace(/<[^>]+>/g, " ").trim().split(/\s+/).length;
    const read = `${Math.max(3, Math.ceil(words / 220))} min read`;

    return { title, dek, bodyHtml, read };
  }

  private formatPremarketBody(rawHtml: string): string {
    let b = rawHtml.trim();

    // Strip any markdown code fences
    b = b.replace(/^```html\s*/i, "").replace(/\s*```$/i, "");

    // 1. Strip all clickable links / <a> tags (retain text content)
    b = b.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1");

    // 2. Strip any Wall Street analyst actions section / table if model generated it
    b = b.replace(
      /<h[23][^>]*>[\s\S]*?(?:analyst actions|wall street analyst)[\s\S]*?<\/h[23]>[\s\S]*?(?:<table[\s\S]*?<\/table>|<ul[\s\S]*?<\/ul>)/gis,
      "",
    );

    // Normalize table formatting with class="pos" and class="neg"
    b = b.replace(/<td([^>]*)>(.*?)<\/td>/gis, (match, attrs, content) => {
      const text = content.replace(/<[^>]+>/g, "").trim();
      if (/^[-−\u2010-\u2015]\$?\d[\d.,]*%?$/.test(text) && !attrs.includes("neg")) {
        if (/class="[^"]*"/.test(attrs)) {
          return `<td${attrs.replace(/class="([^"]*)"/, 'class="$1 neg"')}>${content}</td>`;
        }
        return `<td class="neg"${attrs}>${content}</td>`;
      }
      if (/^\+\$?\d[\d.,]*%?$/.test(text) && !attrs.includes("pos")) {
        if (/class="[^"]*"/.test(attrs)) {
          return `<td${attrs.replace(/class="([^"]*)"/, 'class="$1 pos"')}>${content}</td>`;
        }
        return `<td class="pos"${attrs}>${content}</td>`;
      }
      return match;
    });

    return b;
  }
}
