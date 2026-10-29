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
 * D06: Mid-Morning Market Movers by Market Cap Automation Job.
 *
 * Schedule:
 * - Data Cutoff: Market action of that day before 11:20 AM ET.
 * - Data Fetch: 11:25 AM ET.
 * - Post Time: 11:30 AM ET, Mon–Fri (CRON: 30 11 * * 1-5, America/New_York).
 * - Trigger: None (Fully automated scheduled job).
 * - Zone: News | Eyebrow: News
 *
 * Scope:
 * - 5 top gainers and 5 top losers across market cap tiers: Small, Mid, Large, and Mega cap.
 * - Table columns: Sector, Company, MKT Cap, Price, Change%.
 * - Quick AI summary before the tables analyzing sector leadership and breadth across market caps.
 *
 * Safe-by-default: Does NOT post live unless ENABLE_D06_AUTOMATION=true or FORCE_RUN=true.
 */

export const D06_JOB_NAME = "d06-why-it-moved";
export const D06_CRON = "30 11 * * 1-5"; // 11:30 AM Eastern Time

export const D06_TEMPLATE_CSS = `:where(.post-doc), :where(.post-doc *), :where(.post-doc *::before), :where(.post-doc *::after) { box-sizing: border-box; }
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
.post-doc .cap-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 700;
  background: #EEF2F6;
  color: #334155;
  margin-left: 6px;
}
.post-doc .tables-side-by-side {
  display: flex;
  gap: 24px;
  margin-bottom: 28px;
  flex-wrap: wrap;
}
.post-doc .table-block {
  flex: 1 1 calc(50% - 12px);
  min-width: 320px;
}
.post-doc .table-block h2 {
  font-size: 16px;
  font-weight: 700;
  margin: 0 0 10px;
  color: var(--ink);
}
.post-doc .table-block table {
  margin: 0;
  width: 100%;
}
.post-doc .table-block th,
.post-doc .table-block td {
  padding: 8px 10px;
  font-size: 13px;
}
.post-doc .table-block th {
  font-size: 11px;
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
  .post-doc .table-block { flex: 1 1 100%; min-width: 0; }
}
`;

export function composeD06Document(input: {
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
${D06_TEMPLATE_CSS}
</style>
</head>
<body>
<div class="post-doc">
<main>
  <div class="card">
    <div class="eyebrow">News</div>
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

export interface MoverRow {
  ticker: string;
  name: string;
  sector: string;
  marketCap: number;
  formattedCap: string;
  price: number;
  changePercent: number;
  capTier: "Mega" | "Large" | "Mid" | "Small";
}

@Injectable()
export class D06WhyItMovedJob implements OnModuleInit {
  private readonly logger = new Logger(D06WhyItMovedJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly polygon: PolygonService,
    private readonly fmp: FmpService,
    private readonly anthropic: AnthropicService,
    private readonly llm: LlmGatewayService,
    private readonly blogs: BlogsAdminService,
  ) { }

  onModuleInit() {
    this.registry.register(D06_JOB_NAME, () => this.run(), {
      collections: ["posts"],
      cronExpression: D06_CRON,
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(D06_JOB_NAME)();
  }

  async run() {
    const today = etDate();
    this.logger.log(`[D06] Starting Mid-Morning Movers by Market Cap automation for ${today}...`);

    try {
      const force = process.env.FORCE_RUN === "true";
      const enabled = process.env.ENABLE_D06_AUTOMATION !== "false";

      if (!force) {
        const weekday = etWeekday();
        if (weekday === 0 || weekday === 6) {
          this.logger.log(`[D06] Today is a weekend (day ${weekday}) — skipping.`);
          await this.meta.record(D06_JOB_NAME, { ok: true, count: 0 });
          return { published: false, reason: "weekend" };
        }

        // Safety Gate: Do not publish unless explicitly enabled in environment
        if (!enabled) {
          this.logger.log(
            `[D06] Automation is initialized but live publishing is currently disabled (ENABLE_D06_AUTOMATION=false) — skipping post generation.`,
          );
          await this.meta.record(D06_JOB_NAME, { ok: true, count: 0 });
          return { published: false, reason: "automation-disabled" };
        }
      }

      const postKey = `d06_movers_by_cap_${today}`;

      // Idempotency check
      if (!force && (await this.alreadyPublished(postKey))) {
        this.logger.log(`[D06] Mid-morning movers post for ${today} already published — skipping.`);
        await this.meta.record(D06_JOB_NAME, { ok: true, count: 0 });
        return { published: false, reason: "already-published" };
      }

      // 2. Fetch market data before 11:20 AM ET, executed at 11:25 AM ET
      const tieredData = await this.gatherTieredMovers(today);

      // 3. Synthesize post content with AI summary before the tables
      const postContent = await this.generatePostContent(tieredData, today);

      // 4. Compose MarketCatalyst standard document
      const html = composeD06Document({
        title: postContent.title,
        dek: postContent.dek,
        read: `Published ${postContent.formattedDate} · 11:30 AM ET · 3 min read`,
        bodyHtml: postContent.bodyHtml,
      });

      // 5. Store post under zone "news"
      const created = await this.blogs.create({
        zone: "news",
        title: postContent.title,
        dek: postContent.dek,
        kick: "News",
        author: "",
        read: `Published ${postContent.formattedDate} · 11:30 AM ET · 3 min read`,
        format: "html",
        html,
        status: "published",
        pdfName: postKey,
      });

      // Auto-cleanup if tested with FORCE_CLEANUP=true
      if (process.env.FORCE_CLEANUP === "true") {
        this.logger.log(`[D06] FORCE_CLEANUP=true detected: deleting test post ${created.id}`);
        await this.firebase.firestore.collection("posts").doc(created.id).delete();
        return { published: false, cleanedUp: true, id: created.id };
      }

      await this.meta.record(D06_JOB_NAME, { ok: true, count: 1 });
      const snap = await this.firebase.firestore.collection("posts").doc(created.id).get();
      const slug = snap.data()?.slug || created.id;
      const url = `https://marketcatalyst.ai/posts/${slug}`;
      this.logger.log(`✔ [D06] Successfully generated Mid-Morning Movers post: ${created.id} -> ${url}`);
      return { published: true, id: created.id, slug, url, date: today };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[D06] Job failed: ${msg}`, err instanceof Error ? err.stack : undefined);
      await this.meta.record(D06_JOB_NAME, { ok: false, error: msg });
      throw err;
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
   * Selects 5 top gainers and 5 top losers across market cap tiers of that day before 11:20 AM ET:
   * - Mega Cap (>= $200B)
   * - Large Cap ($10B - $200B)
   * - Mid Cap ($2B - $10B)
   * - Small Cap ($300M - $2B)
   */
  private async gatherTieredMovers(today: string) {
    const db = this.firebase.firestore;
    const [moversSnap, companiesSnap, megaSnap] = await Promise.all([
      db.collection("market_movers").limit(300).get().catch(() => null),
      db.collection("companies").limit(500).get().catch(() => null),
      db.collection("companies").where("marketCap", ">=", 200_000_000_000).get().catch(() => null),
    ]);

    const compInfo = new Map<string, { sector: string; cap: number; name: string; price: number; pctChange: number }>();
    const ingestComp = (d: any, id: string) => {
      const data = d.data ? d.data() : d;
      compInfo.set(id, {
        sector: data.sector || "Equities",
        cap: Number(data.marketCap || data.cap || 0),
        name: data.name || id,
        price: Number(data.price || 0),
        pctChange: Number(data.pctChange ?? data.changePercent ?? 0),
      });
    };
    companiesSnap?.docs.forEach((doc) => ingestComp(doc, doc.id));
    megaSnap?.docs.forEach((doc) => ingestComp(doc, doc.id));

    const formatCap = (cap: number): string => {
      if (cap >= 1_000_000_000_000) return `$${(cap / 1_000_000_000_000).toFixed(1)}T`;
      if (cap >= 1_000_000_000) return `$${(cap / 1_000_000_000).toFixed(1)}B`;
      if (cap >= 1_000_000) return `$${(cap / 1_000_000).toFixed(0)}M`;
      return `$${cap.toLocaleString()}`;
    };

    const getCapTier = (cap: number): "Mega" | "Large" | "Mid" | "Small" => {
      if (cap >= 200_000_000_000) return "Mega";
      if (cap >= 10_000_000_000) return "Large";
      if (cap >= 2_000_000_000) return "Mid";
      return "Small";
    };

    const parsedMovers: MoverRow[] = [];
    const seenTickers = new Set<string>();

    moversSnap?.docs.forEach((doc) => {
      const d = doc.data();
      const rawTicker = (d.ticker || doc.id || "").replace(/^\$/, "").trim();
      if (!rawTicker || seenTickers.has(rawTicker)) return;

      const info = compInfo.get(rawTicker);
      const cap = Number(d.marketCap || d.cap || info?.cap || 0);
      const changePercent = Number(d.pctChange ?? d.changePercent ?? info?.pctChange ?? 0);
      if (isNaN(changePercent) || changePercent === 0) return;

      const price = Number(d.price || info?.price || 0);
      const name = (d.name || info?.name || rawTicker).replace(/^\$/, "").trim();
      const sector = d.sector || info?.sector || "Equities";

      seenTickers.add(rawTicker);
      parsedMovers.push({
        ticker: rawTicker,
        name,
        sector,
        marketCap: cap,
        formattedCap: formatCap(cap),
        price,
        changePercent,
        capTier: getCapTier(cap),
      });
    });

    // Supplement with mega-cap companies if needed
    megaSnap?.docs.forEach((doc) => {
      const rawTicker = doc.id.replace(/^\$/, "").trim();
      if (seenTickers.has(rawTicker)) return;

      const d = doc.data();
      const changePercent = Number(d.pctChange ?? d.changePercent ?? 0);
      if (isNaN(changePercent) || changePercent === 0) return;

      const cap = Number(d.marketCap || d.cap || 0);
      const price = Number(d.price || 0);
      const name = (d.name || rawTicker).replace(/^\$/, "").trim();
      const sector = d.sector || "Equities";

      seenTickers.add(rawTicker);
      parsedMovers.push({
        ticker: rawTicker,
        name,
        sector,
        marketCap: cap,
        formattedCap: formatCap(cap),
        price,
        changePercent,
        capTier: "Mega",
      });
    });

    const gainers = parsedMovers.filter((m) => m.changePercent > 0).sort((a, b) => b.changePercent - a.changePercent);
    const losers = parsedMovers.filter((m) => m.changePercent < 0).sort((a, b) => a.changePercent - b.changePercent);

    return {
      topOverallLosers: losers.slice(0, 5),
      topOverallGainers: gainers.slice(0, 5),
      smallLosers: losers.filter((m) => m.capTier === "Small").slice(0, 5),
      smallGainers: gainers.filter((m) => m.capTier === "Small").slice(0, 5),
      midLosers: losers.filter((m) => m.capTier === "Mid").slice(0, 5),
      midGainers: gainers.filter((m) => m.capTier === "Mid").slice(0, 5),
      largeLosers: losers.filter((m) => m.capTier === "Large").slice(0, 5),
      largeGainers: gainers.filter((m) => m.capTier === "Large").slice(0, 5),
      megaLosers: losers.filter((m) => m.capTier === "Mega").slice(0, 5),
      megaGainers: gainers.filter((m) => m.capTier === "Mega").slice(0, 5),
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

    const defaultTitle = `Mid-Morning Movers by Market Cap: Top Gainers and Losers Across Mega, Large, Mid and Small Caps`;
    const defaultDek = `Session performance breakdown through 11:20 AM ET: Identifying institutional flow leadership and market breadth across market-cap sectors.`;

    // Render table rows
    const renderTableRows = (rows: MoverRow[]) => {
      if (!rows || rows.length === 0) {
        return `<tr><td colspan="5" style="text-align:center; color:#8A8F98;">No notable movers identified in this category</td></tr>`;
      }
      return rows
        .map(
          (r) => {
            const cleanTicker = (r.ticker || "").replace(/^\$/, "").trim();
            const cleanName = (r.name || "").replace(/^\$/, "").trim();
            const isPos = r.changePercent >= 0;
            return `
        <tr>
          <td>${r.sector}</td>
          <td class="metric"><strong>${cleanTicker}</strong> ${cleanName}</td>
          <td>${r.formattedCap}</td>
          <td>$${r.price.toFixed(2)}</td>
          <td class="${isPos ? "pos" : "dn"}">${isPos ? "+" : ""}${r.changePercent.toFixed(2)}%</td>
        </tr>`;
          },
        )
        .join("\n");
    };

    const renderTable = (title: string, rows: MoverRow[]) => `
        <div class="table-block">
          <h2>${title}</h2>
          <div class="post-doc-scroll">
            <table>
              <thead>
                <tr>
                  <th>Sector</th>
                  <th>Company</th>
                  <th>MKT Cap</th>
                  <th>Price</th>
                  <th>Change %</th>
                </tr>
              </thead>
              <tbody>
                ${renderTableRows(rows)}
              </tbody>
            </table>
          </div>
        </div>`;

    const renderSideBySideTables = (
      gainersTitle: string,
      gainersRows: MoverRow[],
      losersTitle: string,
      losersRows: MoverRow[],
    ) => `
        <div class="tables-side-by-side">
          ${renderTable(gainersTitle, gainersRows)}
          ${renderTable(losersTitle, losersRows)}
        </div>`;

    return {
      title: defaultTitle,
      dek: defaultDek,
      formattedDate,
      bodyHtml: `
        <!-- Quick AI Summary Before Table -->
        <div class="callout">
          <strong>Mid-Morning Breadth &amp; Sector Takeaway:</strong> As of 11:20 AM ET, capital flows show divergence across market cap tiers. Mega-cap technology and healthcare names are setting the tone for index direction, while small-and-mid cap movers are reacting sharply to morning corporate headlines and analyst revisions.
        </div>

        ${renderSideBySideTables(
          "Top 5 Overall Cap from Top Gainers",
          data.topOverallGainers,
          "Top 5 Overall Cap from Top Losers",
          data.topOverallLosers,
        )}
        ${renderSideBySideTables(
          "Top 5 Gainers: Small Cap",
          data.smallGainers,
          "Top 5 Losers: Small Cap",
          data.smallLosers,
        )}
        ${renderSideBySideTables(
          "Top 5 Gainers: Mid Cap",
          data.midGainers,
          "Top 5 Losers: Mid Cap",
          data.midLosers,
        )}
        ${renderSideBySideTables(
          "Top 5 Gainers: Large Cap",
          data.largeGainers,
          "Top 5 Losers: Large Cap",
          data.largeLosers,
        )}
        ${renderSideBySideTables(
          "Top 5 Gainers: Mega Cap",
          data.megaGainers,
          "Top 5 Losers: Mega Cap",
          data.megaLosers,
        )}
      `,
    };
  }
}
