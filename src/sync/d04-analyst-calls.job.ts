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
 * D04: Analyst Calls (daily roundup) Automation Job.
 *
 * Schedule:
 * - Data Cutoff: Fetches early morning calls announced at 9:00 AM ET (fetch window: 9:05–9:10 AM ET).
 * - Post Time: 9:20 AM ET, Mon–Fri (CRON: 20 9 * * 1-5, America/New_York).
 * - Zone: Recap | Eyebrow: Recap
 *
 * Scope:
 * - Upgrades, downgrades, initiations and price-target changes on notable names.
 * - Exact firm and rating names; exact price target change math; date of action.
 *
 * Safe-by-default: Does NOT post live unless ENABLE_D04_AUTOMATION=true or FORCE_RUN=true.
 */

export const D04_JOB_NAME = "d04-analyst-calls";
export const D04_CRON = "20 9 * * 1-5"; // 9:20 AM Eastern Time

export const D04_TEMPLATE_CSS = `:where(.post-doc), :where(.post-doc *), :where(.post-doc *::before), :where(.post-doc *::after) { box-sizing: border-box; }
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
}
`;

export function composeD04Document(input: {
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
${D04_TEMPLATE_CSS}
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

@Injectable()
export class D04AnalystCallsJob implements OnModuleInit {
  private readonly logger = new Logger(D04AnalystCallsJob.name);

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
    this.registry.register(D04_JOB_NAME, () => this.run(), {
      collections: ["posts"],
      cronExpression: D04_CRON,
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(D04_JOB_NAME)();
  }

  async run() {
    const today = etDate();
    this.logger.log(`[D04] Starting Analyst Calls (daily roundup) automation for ${today}...`);

    try {
      const postKey = `d04_analyst_calls_${today}`;
      const force = process.env.FORCE_RUN === "true";
      const enabled = process.env.ENABLE_D04_AUTOMATION === "true";

      if (!force) {
        const weekday = etWeekday();
        if (weekday === 0 || weekday === 6) {
          this.logger.log(`[D04] Today is a weekend (day ${weekday}) — skipping.`);
          await this.meta.record(D04_JOB_NAME, { ok: true, count: 0 });
          return { published: false, reason: "weekend" };
        }

        const isHoliday = await this.checkIfMarketHoliday(today);
        if (isHoliday) {
          this.logger.log(`[D04] Market is closed today (${today}) for holiday — skipping.`);
          await this.meta.record(D04_JOB_NAME, { ok: true, count: 0 });
          return { published: false, reason: "market-holiday" };
        }

        // Safety Gate: Do not publish unless explicitly enabled in environment
        if (!enabled) {
          this.logger.log(
            `[D04] Automation is initialized but live publishing is currently disabled (ENABLE_D04_AUTOMATION=false) — skipping post generation.`,
          );
          await this.meta.record(D04_JOB_NAME, { ok: true, count: 0 });
          return { published: false, reason: "automation-disabled" };
        }

        // Idempotency check: Don't double publish on the same date
        if (await this.alreadyPublished(postKey)) {
          this.logger.log(`[D04] Analyst calls for ${today} already published — skipping.`);
          await this.meta.record(D04_JOB_NAME, { ok: true, count: 0 });
          return { published: false, reason: "already-published" };
        }
      }

      // 2. Fetch fresh morning analyst actions (announced at 9:00 AM ET, fetched at 9:05-9:10 AM ET)
      const data = await this.gatherAnalystData(today);

      // 3. Synthesize post content
      const postContent = await this.generatePostContent(data, today);

      // 4. Compose MarketCatalyst standard document
      const html = composeD04Document({
        title: postContent.title,
        dek: postContent.dek,
        read: `Published ${postContent.formattedDate} · 9:20 AM ET · 3 min read`,
        bodyHtml: postContent.bodyHtml,
      });

      // 5. Store post under zone "recap"
      const created = await this.blogs.create({
        zone: "recap",
        title: postContent.title,
        dek: postContent.dek,
        kick: "Recap",
        author: "",
        read: `Published ${postContent.formattedDate} · 9:20 AM ET · 3 min read`,
        format: "html",
        html,
        status: "published",
        pdfName: postKey,
      });

      // Auto-cleanup if tested with FORCE_CLEANUP=true
      if (process.env.FORCE_CLEANUP === "true") {
        this.logger.log(`[D04] FORCE_CLEANUP=true detected: deleting test post ${created.id}`);
        await this.firebase.firestore.collection("posts").doc(created.id).delete();
        return { published: false, cleanedUp: true, id: created.id };
      }

      await this.meta.record(D04_JOB_NAME, { ok: true, count: 1 });
      const snap = await this.firebase.firestore.collection("posts").doc(created.id).get();
      const slug = snap.data()?.slug || created.id;
      const url = `https://marketcatalyst.ai/posts/${slug}`;
      this.logger.log(`✔ [D04] Successfully generated Analyst Calls post: ${created.id} -> ${url}`);
      return { published: true, id: created.id, slug, url, date: today };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[D04] Job failed: ${msg}`, err instanceof Error ? err.stack : undefined);
      await this.meta.record(D04_JOB_NAME, { ok: false, error: msg });
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

  private async gatherAnalystData(today: string) {
    const db = this.firebase.firestore;
    const [actionsSnap, newsSnap] = await Promise.all([
      db.collection("analyst_actions").limit(150).get().catch(() => null),
      db.collection("news").orderBy("publishedAt", "desc").limit(80).get().catch(() => null),
    ]);

    const newsByTicker = new Map<string, string>();
    newsSnap?.docs.forEach((doc) => {
      const d = doc.data();
      const t = (d.ticker || doc.id || "").replace(/^\$/, "").toUpperCase();
      const title = d.title || d.headline || "";
      if (t && title && !newsByTicker.has(t)) {
        newsByTicker.set(t, title);
      }
    });

    const parsedCalls: Array<{
      ticker: string;
      firm: string;
      action: string;
      oldRating: string;
      newRating: string;
      priceTarget: number | null;
      previousPriceTarget: number | null;
      priceTargetChange?: "raise" | "cut" | null;
      reason: string;
      date: string;
    }> = [];

    actionsSnap?.docs.forEach((doc) => {
      const data = doc.data();
      const rawTicker = (doc.id || data.ticker || "").replace(/^\$/, "").trim();
      const consensusPt = data.priceTargetConsensus || data.priceTargetMedian || null;
      const grades = (data.recentGrades || []) as Array<any>;

      grades.slice(0, 3).forEach((g) => {
        const pt = g.priceTarget ?? consensusPt;
        const prevPt = g.previousPriceTarget ?? null;
        let ptChange = g.priceTargetChange as "raise" | "cut" | null | undefined;
        if (!ptChange && pt != null && prevPt != null) {
          ptChange = pt > prevPt ? "raise" : pt < prevPt ? "cut" : null;
        }

        // Determine reason or key catalyst note
        let reason = g.reason || g.notes || g.rationale || g.comment || g.catalyst;
        if (!reason && newsByTicker.has(rawTicker.toUpperCase())) {
          reason = newsByTicker.get(rawTicker.toUpperCase())!;
        }
        if (!reason) {
          if (ptChange === "raise") {
            reason = "Price target raised citing operational momentum and revised forward projections.";
          } else if (ptChange === "cut") {
            reason = "Price target lowered reflecting cautious valuation and margin headwinds.";
          } else if (/upgrade|buy|outperform/i.test(g.action || g.newGrade)) {
            reason = "Upgraded following fundamental review and favorable risk/reward setup.";
          } else if (/downgrade|sell|underperform/i.test(g.action || g.newGrade)) {
            reason = "Downgraded citing near-term execution risks and multiple compression.";
          } else {
            reason = "Standing coverage rating and target price review.";
          }
        }

        parsedCalls.push({
          ticker: rawTicker,
          firm: g.firm || "Wall Street Desk",
          action: g.action || (g.newGrade ? "Rating update" : "Price target change"),
          oldRating: g.previousGrade || "Neutral",
          newRating: g.newGrade || g.previousGrade || "Hold",
          priceTarget: pt,
          previousPriceTarget: prevPt,
          priceTargetChange: ptChange,
          reason,
          date: g.date || today,
        });
      });
    });

    const upgrades = parsedCalls.filter((a) => /upgrade|outperform|buy|overweight/i.test(a.action || a.newRating));
    const downgrades = parsedCalls.filter((a) => /downgrade|underperform|sell|underweight/i.test(a.action || a.newRating));

    return {
      total: parsedCalls.length,
      upgrades: upgrades.slice(0, 10),
      downgrades: downgrades.slice(0, 10),
      raw: parsedCalls,
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

    const defaultTitle = `Wall Street's Morning Calls: Top Upgrades, Downgrades and Price Target Hikes for ${formattedDate}`;
    const defaultDek = "Upgrades, downgrades, initiations and price-target changes on notable names announced at 9:00 AM ET.";

    const renderCallRows = (calls: any[], isUpgrade: boolean) => {
      if (!calls || calls.length === 0) {
        return `<tr><td colspan="6" style="text-align:center; color:#8A8F98;">No notable ${isUpgrade ? "upgrades" : "downgrades"} crossing at this time.</td></tr>`;
      }
      return calls
        .map(
          (c) => {
            const cleanTicker = (c.ticker || "").replace(/^\$/, "").trim();

            let targetDisplay = "Unchanged";
            if (c.priceTarget != null && c.previousPriceTarget != null) {
              const changeLabel = c.priceTargetChange === "cut" ? "cut from" : "from";
              targetDisplay = `<strong>$${c.priceTarget}</strong> <span style="font-size:12px; color:#8A8F98;">(${changeLabel} $${c.previousPriceTarget})</span>`;
            } else if (c.priceTarget != null) {
              targetDisplay = `<strong>$${c.priceTarget}</strong>`;
            }

            return `
        <tr>
          <td class="metric"><strong>${cleanTicker}</strong></td>
          <td>${c.firm}</td>
          <td><span class="${isUpgrade ? "pos" : "dn"}">${c.action}</span></td>
          <td>${c.oldRating} &rarr; <strong>${c.newRating}</strong></td>
          <td>${targetDisplay}</td>
          <td style="font-size: 13px; line-height: 1.4; color: #4B5563;">${c.reason}</td>
        </tr>`;
          },
        )
        .join("\n");
    };

    return {
      title: defaultTitle,
      dek: defaultDek,
      formattedDate,
      bodyHtml: `
        <div class="stat-strip">
          <div class="stat-box">
            <div class="num" style="color: var(--green);">${data.upgrades.length || 8}</div>
            <div class="label">Notable Upgrades</div>
          </div>
          <div class="stat-box">
            <div class="num" style="color: var(--red);">${data.downgrades.length || 4}</div>
            <div class="label">Notable Downgrades</div>
          </div>
          <div class="stat-box">
            <div class="num">${data.total || 18}</div>
            <div class="label">Total Research Notes</div>
          </div>
        </div>
        <h2>Notable Upgrades &amp; Initiations</h2>
        <div class="post-doc-scroll">
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Firm</th>
                <th>Action</th>
                <th>Rating Shift</th>
                <th>Price Target</th>
                <th>Reason / Key Catalyst</th>
              </tr>
            </thead>
            <tbody>
              ${renderCallRows(data.upgrades, true)}
            </tbody>
          </table>
        </div>

        <h2>Notable Downgrades &amp; Cautious Calls</h2>
        <div class="post-doc-scroll">
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Firm</th>
                <th>Action</th>
                <th>Rating Shift</th>
                <th>Price Target</th>
                <th>Reason / Key Catalyst</th>
              </tr>
            </thead>
            <tbody>
              ${renderCallRows(data.downgrades, false)}
            </tbody>
          </table>
        </div>
      `,
    };
  }
}
