import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { LlmGatewayService } from "../vendors/llm-gateway.service";
import { BlogsAdminService } from "../blogs/blogs-admin.service";
import { buildRecapPdf, type RecapFacts, type RecapNarrative } from "./recap-pdf.builder";

/**
 * Publishes the daily recap to the blog as a PDF.
 *
 * Runs after `recaps` has frozen the day's snapshot at 18:45 ET, and reads that
 * snapshot rather than the live collections — the recap for a session must not
 * change when the underlying data advances the next morning.
 *
 * **Where the numbers come from.** Every figure printed is taken from the
 * snapshot. The model is given those figures and asked only for prose. It is
 * never asked what the market did, and no value it returns is printed as data.
 * That division is the whole point: an LLM asked for today's closing levels
 * will invent plausible ones, and this publishes to a public financial site.
 *
 * **Why it saves as a Draft.** Nothing model-written reaches readers unseen; the
 * post appears in the admin's Recap zone and goes live on one click.
 */

const JOB_NAME = "recap-blog";
/** After `recaps` (18:45 ET) has composed the snapshot this reads. */
const CRON = "0 19 * * 1-5";
/** Per provider. Generous because this runs in a job, not behind the 60s Hosting rewrite. */
const LLM_TIMEOUT_MS = 90_000;

@Injectable()
export class RecapBlogJob implements OnModuleInit {
  private readonly logger = new Logger(RecapBlogJob.name);

  constructor(
    private readonly firebase: FirebaseAdminService,
    private readonly meta: SyncMetaService,
    private readonly registry: SyncRegistry,
    private readonly llm: LlmGatewayService,
    private readonly blogs: BlogsAdminService,
  ) {}

  onModuleInit() {
    this.registry.register(JOB_NAME, () => this.run(), {
      collections: ["blogs"],
      cronExpression: CRON,
      timeZone: "America/New_York",
    });
  }

  async scheduled() {
    await this.registry.get(JOB_NAME)();
  }

  async run() {
    try {
      const facts = await this.loadFacts();
      if (!facts) {
        // No snapshot means the market did not trade (holiday) or the upstream
        // job has not landed. Neither is an error worth alerting on, and
        // inventing a recap for a day with no data is the one thing not to do.
        this.logger.log("no recap snapshot for today — nothing to publish");
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { published: false, reason: "no-snapshot" };
      }

      // daily_recap_YYYY-MM-DD.pdf — the date is also what the duplicate check
      // keys on, so the name is load-bearing, not just cosmetic.
      const name = `daily_recap_${facts.date}.pdf`;
      if (await this.alreadyPublished(name)) {
        this.logger.log(`recap for ${facts.date} already published — skipping`);
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { published: false, reason: "already-published" };
      }

      const narrative = await this.writeNarrative(facts);
      const pdf = await buildRecapPdf(facts, narrative);

      await this.blogs.create({
        zone: "recap",
        title: narrative.headline,
        dek: "",
        kick: "MarketCatalyst",
        author: "Desk",
        read: "",
        html: this.textFallback(facts, narrative),
        // Draft: a person decides whether model-written commentary goes public.
        status: "Draft",
        pdfDataUri: `data:application/pdf;base64,${pdf.buffer.toString("base64")}`,
        pdfName: name,
        pdfPages: pdf.pages,
        pdfAspect: pdf.aspect,
      });

      await this.meta.record(JOB_NAME, { ok: true, count: 1 });
      this.logger.log(
        `recap blog draft for ${facts.date}: ${pdf.pages} pages, ${(pdf.buffer.length / 1024).toFixed(0)} KB`,
      );
      return { published: true, date: facts.date, pages: pdf.pages };
    } catch (err) {
      await this.meta.record(JOB_NAME, { ok: false, error: (err as Error).message });
      throw err;
    }
  }

  /** The frozen snapshot for the most recent session, plus the day's sentiment. */
  private async loadFacts(): Promise<RecapFacts | null> {
    const db = this.firebase.firestore;
    const snap = await db.collection("recaps").orderBy("date", "desc").limit(1).get();
    const doc = snap.docs[0];
    if (!doc) return null;
    const d = doc.data();

    const sentimentDoc = await db
      .collection("market_sentiment")
      .doc("fear_greed")
      .get()
      .catch(() => null);
    const s = sentimentDoc?.exists ? sentimentDoc.data() : null;

    return {
      date: String(d.date ?? doc.id),
      indices: Array.isArray(d.indices) ? d.indices : [],
      topGainers: Array.isArray(d.topGainers) ? d.topGainers : [],
      topLosers: Array.isArray(d.topLosers) ? d.topLosers : [],
      sectorLeaders: Array.isArray(d.sectorLeaders) ? d.sectorLeaders : [],
      sectorLaggards: Array.isArray(d.sectorLaggards) ? d.sectorLaggards : [],
      internals: d.internals ?? null,
      sentiment: s ? { value: s.value ?? null, label: s.label ?? null } : null,
    };
  }

  /**
   * One recap per session, so a re-run or a manual trigger cannot duplicate it.
   * Keyed on the generated filename, which carries the session date — the blog
   * document has no field of its own for this, and matching on the title would
   * break the moment the model words a headline differently.
   */
  private async alreadyPublished(pdfName: string): Promise<boolean> {
    const snap = await this.firebase.firestore
      .collection("blogs")
      .where("pdfName", "==", pdfName)
      .limit(1)
      .get();
    return !snap.empty;
  }

  /**
   * Asks the model for prose only, and hands it the figures it must write
   * around. Anything it returns that is missing or malformed degrades to a
   * plain factual sentence rather than failing the run — a recap with dull
   * copy is publishable; a recap with invented numbers is not.
   */
  private async writeNarrative(facts: RecapFacts): Promise<RecapNarrative> {
    const movers = [...facts.topGainers.slice(0, 3), ...facts.topLosers.slice(0, 3)];
    const system =
      "You are the market editor for MarketCatalyst, writing the end-of-day recap. " +
      "You are given the session's real figures. Write ONLY prose about them. " +
      "Never state a price, level, percentage or date that is not in the data given — " +
      "if you do not know why something moved, say so plainly. " +
      "No hype, no advice, no predictions presented as fact. " +
      "Reply with JSON only, no code fence, matching exactly: " +
      '{"headline":string,"summary":[string,string],"moverNotes":{TICKER:string},' +
      '"stories":[{"title":string,"body":string}],"takeaway":string,"tags":[string]}. ' +
      "headline: under 90 characters, states the session's dominant theme. " +
      "summary: two paragraphs, 60-90 words each. " +
      "moverNotes: one entry per ticker given, 2-3 sentences; if no catalyst is " +
      "supplied, write that no confirmed catalyst was identified. " +
      "stories: 3-5 themes visible IN THE DATA (breadth, sector rotation, volatility, " +
      "macro assets) — not outside news you cannot verify. " +
      "takeaway: 2-3 sentences on what to watch next session. tags: 6-8 short labels.";

    const payload = {
      date: facts.date,
      sentiment: facts.sentiment,
      indices: facts.indices.map((i) => ({
        label: i.label, level: i.value, changePct: i.pctChange, isProxy: !!i.isProxy,
      })),
      breadth: facts.internals,
      sectorLeaders: facts.sectorLeaders,
      sectorLaggards: facts.sectorLaggards,
      movers: movers.map((m) => ({ ticker: m.ticker, name: m.name, price: m.price, changePct: m.pctChange })),
    };

    const raw = await this.llm
      .chat(
        [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(payload) },
        ],
        { timeoutMs: LLM_TIMEOUT_MS },
      )
      .catch((err) => {
        this.logger.warn(`narrative generation failed: ${(err as Error).message}`);
        return null;
      });

    return this.coerceNarrative(raw, facts, movers.map((m) => m.ticker));
  }

  /** Parses the model's reply defensively and fills every gap with a factual default. */
  private coerceNarrative(raw: string | null, facts: RecapFacts, tickers: string[]): RecapNarrative {
    let parsed: Record<string, unknown> = {};
    if (raw) {
      // Models wrap JSON in prose or a fence often enough to be worth handling.
      const body = raw.replace(/^[^{]*/, "").replace(/[^}]*$/, "");
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        this.logger.warn("narrative was not valid JSON — falling back to factual copy");
      }
    }

    const str = (v: unknown, fallback: string): string =>
      typeof v === "string" && v.trim() ? v.trim() : fallback;
    const strArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];

    const headline = str(parsed.headline, this.factualHeadline(facts));
    const summary = strArr(parsed.summary);
    const notes: Record<string, string> = {};
    const rawNotes = (parsed.moverNotes ?? {}) as Record<string, unknown>;
    for (const t of tickers) {
      notes[t] = str(rawNotes[t], "No confirmed catalyst was identified for this move.");
    }
    const stories = Array.isArray(parsed.stories)
      ? (parsed.stories as Record<string, unknown>[])
          .map((s) => ({ title: str(s?.title, ""), body: str(s?.body, "") }))
          .filter((s) => s.title && s.body)
          .slice(0, 5)
      : [];

    return {
      headline,
      summary: summary.length ? summary.slice(0, 3) : [this.factualSummary(facts)],
      moverNotes: notes,
      stories,
      takeaway: str(parsed.takeaway, "Levels and breadth from this session are the reference for the next open."),
      tags: strArr(parsed.tags).slice(0, 8).length
        ? strArr(parsed.tags).slice(0, 8)
        : ["Daily Recap", "Markets", "MarketCatalyst"],
    };
  }

  /** Used when the model is unavailable — states only what the data says. */
  private factualHeadline(facts: RecapFacts): string {
    const sp = facts.indices.find((i) => /s&p|spx|s and p/i.test(i.label));
    const pct = sp?.pctChange;
    if (pct == null) return `Market recap — ${facts.date}`;
    const dir = pct > 0 ? "higher" : pct < 0 ? "lower" : "flat";
    return `Stocks close ${dir}: S&P 500 ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  }

  private factualSummary(facts: RecapFacts): string {
    const parts = facts.indices
      .filter((i) => i.pctChange != null)
      .slice(0, 5)
      .map((i) => `${i.label} ${i.pctChange! >= 0 ? "+" : ""}${i.pctChange!.toFixed(2)}%`);
    const b = facts.internals;
    const breadth = b?.advancers != null && b?.decliners != null
      ? ` Breadth finished ${b.advancers} advancing to ${b.decliners} declining.`
      : "";
    return `Closing levels for ${facts.date}: ${parts.join(", ")}.${breadth}`;
  }

  /**
   * The post's text body. The page renders the PDF and hides this, but it is
   * what search engines and link previews read (it is published as the article
   * body in the page's JSON-LD), so it carries the day's real figures.
   */
  private textFallback(facts: RecapFacts, narrative: RecapNarrative): string {
    const lines = [
      `# ${narrative.headline}`,
      "",
      ...narrative.summary,
      "",
      "## Closing levels",
      ...facts.indices.map(
        (i) => `- ${i.label}: ${i.value ?? "—"} (${i.pctChange == null ? "—" : `${i.pctChange >= 0 ? "+" : ""}${i.pctChange.toFixed(2)}%`})`,
      ),
    ];
    if (narrative.stories.length) {
      lines.push("", "## What moved the market");
      for (const s of narrative.stories) lines.push(`### ${s.title}`, s.body);
    }
    lines.push("", "## Key takeaway", narrative.takeaway);
    return lines.join("\n");
  }
}
