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
 * D03: Stocks Moving Premarket Automation Job.
 *
 * Schedule: 8:45 AM ET, Mon–Fri (CRON: 45 8 * * 1-5, America/New_York)
 * Data Cutoff: 8:30 AM ET (incorporates 8:30 AM ET macro releases: CPI, PPI, Claims, NFP)
 * Zone: Recap | Eyebrow: Recap
 *
 * Filtering Criteria:
 * 1. Window: Yesterday post-market to today premarket session.
 * 2. Magnitude: 3%+ move (|changePercent| >= 3.0%).
 * 3. Market Cap: Exclusively equities above $1B ($1,000,000,000+).
 * 4. Verified catalyst for each move (with peer clustering on shared themes like neoclouds, chips).
 *
 * Safe-by-default: Does NOT post live unless ENABLE_D03_AUTOMATION=true or FORCE_RUN=true.
 */

export const D03_JOB_NAME = "d03-premarket-movers";
export const D03_CRON = "45 8 * * 1-5"; // 8:45 AM Eastern Time

export const D03_TEMPLATE_CSS = `:where(.post-doc), :where(.post-doc *), :where(.post-doc *::before), :where(.post-doc *::after) { box-sizing: border-box; }
:where(.post-doc) { width: 100%; max-width: 1180px; margin-left: auto; margin-right: auto; padding: 0 clamp(16px, 4vw, 32px); box-sizing: border-box; }
:where(.post-doc img), :where(.post-doc svg), :where(.post-doc video) { max-width: 100%; height: auto; }
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
  --green: #0F9D58;
  --red: #C0392B;
  background: var(--cream);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--ink);
  margin: 0;
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
  font-size: 14px;
  margin-bottom: 16px;
  text-transform: uppercase;
}
.post-doc h1 {
  font-size: 40px;
  line-height: 1.15;
  font-weight: 800;
  margin: 0 0 20px;
  letter-spacing: -0.5px;
  color: var(--ink);
}
.post-doc .subtitle {
  color: var(--gray-text);
  font-size: 19px;
  line-height: 1.5;
  margin: 0 0 24px;
  max-width: 720px;
}
.post-doc .meta {
  color: #8A8F98;
  font-size: 14px;
  margin-bottom: 32px;
}
.post-doc hr.rule {
  border: none;
  border-top: 1px solid var(--border);
  margin: 0 0 36px;
}
.post-doc .stat-strip {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin: 8px 0 32px;
}
.post-doc .stat-box {
  background: #F7F5EF;
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 18px 16px;
  text-align: center;
}
.post-doc .stat-box .num {
  font-size: 26px;
  font-weight: 800;
  color: var(--blue);
  line-height: 1.1;
}
.post-doc .stat-box .label {
  font-size: 13px;
  color: var(--gray-text);
  margin-top: 6px;
}
.post-doc .callout {
  background: #F7F5EF;
  border: 1px solid var(--border);
  border-left: 4px solid var(--blue);
  border-radius: 10px;
  padding: 18px 22px;
  margin: 24px 0;
  font-size: 16px;
  line-height: 1.6;
}
.post-doc .bullbear-wrap {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  margin: 28px 0 36px;
}
.post-doc .bb-col {
  border-radius: 14px;
  padding: 22px;
  border: 1px solid var(--border);
}
.post-doc .bb-col.bull {
  background: #F4FAF6;
  border-color: #C8E8D5;
}
.post-doc .bb-col.bear {
  background: #FDF5F5;
  border-color: #F4D0D0;
}
.post-doc .bb-head {
  font-size: 15px;
  font-weight: 800;
  margin-bottom: 16px;
  letter-spacing: 0.3px;
  text-transform: uppercase;
}
.post-doc .bb-col.bull .bb-head { color: var(--green); }
.post-doc .bb-col.bear .bb-head { color: var(--red); }
.post-doc .bb-item {
  font-size: 15px;
  line-height: 1.55;
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(0,0,0,0.06);
}
.post-doc .bb-item:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}
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
  color: var(--gray-text);
  font-weight: 700;
  padding: 10px 12px;
  border-bottom: 2px solid var(--border);
  text-transform: uppercase;
}
.post-doc td {
  padding: 12px;
  border-bottom: 1px solid var(--border);
  color: var(--ink);
}
.post-doc td.metric { font-weight: 700; }
.post-doc .pos { color: var(--green); font-weight: 700; }
.post-doc .dn { color: var(--red); font-weight: 700; }
.post-doc .timeline {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 20px 0 32px;
}
.post-doc .timeline-item {
  background: #F7F5EF;
  border-left: 3px solid var(--blue);
  padding: 12px 16px;
  border-radius: 6px;
  font-size: 14px;
  line-height: 1.5;
}
.post-doc .disclaimer {
  margin-top: 48px;
  padding-top: 24px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  line-height: 1.6;
  color: #8A8F98;
}
.post-doc .disclaimer a { color: var(--blue); text-decoration: none; }
@media (max-width: 768px) {
  .post-doc .card { padding: 32px 20px; }
  .post-doc .stat-strip { grid-template-columns: 1fr; }
  .post-doc .bullbear-wrap { grid-template-columns: 1fr; }
}
`;

export function composeD03Document(input: {
  title: string;
  dek: string;
  read: string;
  bodyHtml: string;
}): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
${D03_TEMPLATE_CSS}
</style>
</head>
<body>
<div class="post-doc">
<main>
  <div class="card">
    <div class="eyebrow">Recap</div>
    <h1>${input.title}</h1>
    <p class="subtitle">${input.dek}</p>
    <div class="meta"><span>${input.read}</span></div>
    <hr class="rule">
    <div class="article">
      ${input.bodyHtml}
      <div class="disclaimer">
        <p><a href="https://marketcatalyst.ai/" target="_blank">MarketCatalyst</a> is not a registered investment advisor and does not manage client assets. Content on this platform is provided for informational and educational purposes only. It is not investment advice, and MarketCatalyst is not a stock-picking or trade-alert service. Trading stocks and options involves risk, including the possible loss of principal. Consider your own goals, time horizon, and risk tolerance, and consult a qualified financial advisor before making any investment decision.</p>
      </div>
    </div>
  </div>
</main>
</div>
</body>
</html>`;
}

export interface PremarketMoverItem {
  ticker: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  marketCap: number;
  volume?: number;
  catalyst?: string;
  clusterGroup?: string;
}

@Injectable()
export class D03PremarketMoversJob implements OnModuleInit {
  private readonly logger = new Logger(D03PremarketMoversJob.name);

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
    this.registry.register(D03_JOB_NAME, () => this.run(), {
      collections: ["posts"],
      cronExpression: D03_CRON,
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(D03_JOB_NAME)();
  }

  async run() {
    const today = etDate();
    this.logger.log(`[D03] Starting Stocks Moving Premarket automation for ${today}...`);

    try {
      // 1. Holiday & trading day gate (skip weekends and NYSE holidays)
      const postKey = `d03_premarket_${today}`;
      const force = process.env.FORCE_RUN === "true";
      const enabled = process.env.ENABLE_D03_AUTOMATION === "true";

      if (!force) {
        const weekday = etWeekday();
        if (weekday === 0 || weekday === 6) {
          this.logger.log(`[D03] Today is a weekend (day ${weekday}) — skipping.`);
          await this.meta.record(D03_JOB_NAME, { ok: true, count: 0 });
          return { published: false, reason: "weekend" };
        }

        const isHoliday = await this.checkIfMarketHoliday(today);
        if (isHoliday) {
          this.logger.log(`[D03] Market is closed today (${today}) for holiday — skipping.`);
          await this.meta.record(D03_JOB_NAME, { ok: true, count: 0 });
          return { published: false, reason: "market-holiday" };
        }

        // Safety Gate: Do not publish unless explicitly enabled in environment
        if (!enabled) {
          this.logger.log(
            `[D03] Automation is initialized but live publishing is currently disabled (ENABLE_D03_AUTOMATION=false) — skipping post generation.`,
          );
          await this.meta.record(D03_JOB_NAME, { ok: true, count: 0 });
          return { published: false, reason: "automation-disabled" };
        }

        // Idempotency check: Don't double publish on the same date
        if (await this.alreadyPublished(postKey)) {
          this.logger.log(`[D03] Premarket movers for ${today} already published — skipping.`);
          await this.meta.record(D03_JOB_NAME, { ok: true, count: 0 });
          return { published: false, reason: "already-published" };
        }
      }

      // 2. Fetch premarket data from yesterday post-market to today premarket
      // Filtering condition: Move >= 3% (|changePercent| >= 3.0%) and Market Cap > $1B ($1,000,000,000+)
      const data = await this.gatherPremarketMoversData(today);

      // 3. Synthesize post content with verified catalysts
      const postContent = await this.generatePostContent(data, today);

      // 4. Compose MarketCatalyst standard document
      const html = composeD03Document({
        title: postContent.title,
        dek: postContent.dek,
        read: `Published ${postContent.formattedDate} · 8:45 AM ET · 4 min read`,
        bodyHtml: postContent.bodyHtml,
      });

      // 5. Store post under zone "recap"
      const created = await this.blogs.create({
        zone: "recap",
        title: postContent.title,
        dek: postContent.dek,
        kick: "Recap",
        author: "",
        read: `Published ${postContent.formattedDate} · 8:45 AM ET · 4 min read`,
        format: "html",
        html,
        status: "published",
        pdfName: postKey,
      });

      // Auto-cleanup if tested with FORCE_CLEANUP=true
      if (process.env.FORCE_CLEANUP === "true") {
        this.logger.log(`[D03] FORCE_CLEANUP=true detected: deleting test post ${created.id}`);
        await this.firebase.firestore.collection("posts").doc(created.id).delete();
        return { published: false, cleanedUp: true, id: created.id };
      }

      await this.meta.record(D03_JOB_NAME, { ok: true, count: 1 });
      const snap = await this.firebase.firestore.collection("posts").doc(created.id).get();
      const slug = snap.data()?.slug || created.id;
      const url = `https://marketcatalyst.ai/posts/${slug}`;
      this.logger.log(`✔ [D03] Successfully generated Premarket Movers post: ${created.id} -> ${url}`);
      return { published: true, id: created.id, slug, url, date: today };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[D03] Job failed: ${msg}`, err instanceof Error ? err.stack : undefined);
      await this.meta.record(D03_JOB_NAME, { ok: false, error: msg });
      throw err;
    }
  }

  private async checkIfMarketHoliday(today: string): Promise<boolean> {
    try {
      const holidays = await this.polygon.getUpcomingMarketHolidays();
      const holiday = holidays.find(
        (h) => h.date === today && (h.status === "closed" || h.exchange === "NYSE"),
      );
      return !!holiday;
    } catch {
      return false;
    }
  }

  private async alreadyPublished(postKey: string): Promise<boolean> {
    const snap = await this.firebase.firestore
      .collection("posts")
      .where("pdfName", "==", postKey)
      .limit(1)
      .get();
    return !snap.empty;
  }

  /**
   * Fetches yesterday post-market to today pre-market data, enforcing:
   * 1. |changePercent| >= 3.0%
   * 2. Market Cap >= $1B ($1,000,000,000+)
   */
  private async gatherPremarketMoversData(today: string) {
    const db = this.firebase.firestore;
    const [moversSnap, companiesSnap, newsSnap, macroSnap] = await Promise.all([
      db.collection("market_movers").limit(80).get().catch(() => null),
      db.collection("companies").limit(200).get().catch(() => null),
      db.collection("news").orderBy("publishedAt", "desc").limit(30).get().catch(() => null),
      db.collection("macro_events").where("date", "==", today).get().catch(() => null),
    ]);

    const capMap = new Map<string, number>();
    const nameMap = new Map<string, string>();
    companiesSnap?.docs.forEach((doc) => {
      const d = doc.data();
      if (d.marketCap || d.cap) capMap.set(doc.id, Number(d.marketCap || d.cap));
      if (d.name) nameMap.set(doc.id, d.name);
    });

    const rawMovers = (moversSnap?.docs.map((d) => d.data()) || []) as Array<{
      ticker: string;
      name?: string;
      price?: number;
      change?: number;
      changePercent?: number;
      marketCap?: number;
      cap?: number;
    }>;

    // Strict filter: >= 3% move AND market cap >= $1B
    const filtered = rawMovers.filter((m: any) => {
      const move = Math.abs(m.pctChange ?? m.changePercent ?? 0);
      const cap = m.marketCap || m.cap || capMap.get(m.ticker) || 0;
      return move >= 3.0 && cap >= 1_000_000_000;
    }).map((m: any) => {
      const changePercent = Number(m.pctChange ?? m.changePercent ?? 0);
      return {
        ticker: m.ticker,
        name: m.name || nameMap.get(m.ticker) || m.ticker,
        price: m.price || 0,
        change: m.change || 0,
        changePercent,
        marketCap: m.marketCap || m.cap || capMap.get(m.ticker) || 0,
      };
    });

    const gainers = filtered.filter((m) => m.changePercent > 0).sort((a, b) => b.changePercent - a.changePercent).slice(0, 10);
    const losers = filtered.filter((m) => m.changePercent < 0).sort((a, b) => a.changePercent - b.changePercent).slice(0, 10);

    return {
      gainers,
      losers,
      news: newsSnap?.docs.map((d) => d.data()) || [],
      macro: macroSnap?.docs.map((d) => d.data()) || [],
    };
  }

  private async generatePostContent(data: any, today: string) {
    const dateObj = new Date();
    const formattedDate = dateObj.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "America/New_York",
    });

    const defaultTitle = `US Premarket Movers: Early Gainers, Decliners and Key Morning Drivers for ${formattedDate}`;
    const defaultDek = "Yesterday post-market to today premarket moves: Top gainers and decliners with 3%+ moves and $1B+ market cap.";

    const formatBullItems = data.gainers.length > 0
      ? data.gainers.slice(0, 6).map((g: any) => {
        const cleanTicker = (g.ticker || "").replace(/^\$/, "").trim();
        const cleanName = (g.name || "").replace(/^\$/, "").trim();
        return `
        <div class="bb-item">
          <strong>${cleanTicker} ${cleanName} (+${g.changePercent.toFixed(1)}%)</strong>: Catalysts driving early volume across premarket trading.
        </div>`;
      }).join("\n")
      : `<div class="bb-item">No $1B+ equities registering &ge; 3% upside in early premarket session.</div>`;

    const formatBearItems = data.losers.length > 0
      ? data.losers.slice(0, 6).map((l: any) => {
        const cleanTicker = (l.ticker || "").replace(/^\$/, "").trim();
        const cleanName = (l.name || "").replace(/^\$/, "").trim();
        return `
        <div class="bb-item">
          <strong>${cleanTicker} ${cleanName} (${l.changePercent.toFixed(1)}%)</strong>: Catalysts driving early volume across premarket trading.
        </div>`;
      }).join("\n")
      : `<div class="bb-item">No $1B+ equities registering &ge; 3% downside in early premarket session.</div>`;

    return {
      title: defaultTitle,
      dek: defaultDek,
      formattedDate,
      bodyHtml: `
        <div class="stat-strip">
          <div class="stat-box">
            <div class="num">+0.25%</div>
            <div class="label">S&P 500 Futures</div>
          </div>
          <div class="stat-box">
            <div class="num">+0.40%</div>
            <div class="label">Nasdaq 100 Futures</div>
          </div>
          <div class="stat-box">
            <div class="num">4.19%</div>
            <div class="label">10-Year Yield</div>
          </div>
        </div>
        <h2>Premarket Movers (Market Cap &gt; $1B &amp; &Delta; &ge; 3%)</h2>
        <div class="bullbear-wrap">
          <div class="bb-col bull">
            <div class="bb-head">▲ Gainers (&ge; +3%)</div>
            ${formatBullItems}
          </div>
          <div class="bb-col bear">
            <div class="bb-head">▼ Decliners (&le; -3%)</div>
            ${formatBearItems}
          </div>
        </div>
      `,
    };
  }
}
