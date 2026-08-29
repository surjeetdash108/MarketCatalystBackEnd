import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FirebaseAdminService } from "../common/firebase-admin.provider";
import { SyncMetaService } from "../common/sync-meta.service";
import { SyncRegistry } from "../common/sync-registry.service";
import { LlmGatewayService } from "../vendors/llm-gateway.service";
import { BlogsAdminService } from "../blogs/blogs-admin.service";
import { type RecapFacts, type RecapNarrative } from "./recap-pdf.builder";
import { buildRecapHtml, type RecapPeriod } from "./recap-html.builder";
import { ensureRecapHero } from "./recap-hero";

/**
 * Publishes the daily recap to the blog as an HTML article.
 *
 * It used to publish a PDF. A page is better here for the same reasons a
 * newspaper is not a fax: it reflows on a phone, search engines can read it,
 * the charts stay sharp at any size, and a change to the blog's shared design
 * restyles every past recap without regenerating a single file.
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
/** Matches recaps.job — a session's breadth is provisional until this much of
 *  the universe has reported. */
const BREADTH_MIN_COVERAGE = 0.5;

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

      // The date is what the duplicate check keys on, so this is load-bearing
      // rather than cosmetic. Kept in the pdfName field the collection already
      // has, so one run per session stays enforced across the format change.
      const period: RecapPeriod = "daily";
      const name = `${period}_recap_${facts.date}`;
      if (await this.alreadyPublished(name)) {
        this.logger.log(`recap for ${facts.date} already published — skipping`);
        await this.meta.record(JOB_NAME, { ok: true, count: 0 });
        return { published: false, reason: "already-published" };
      }

      const narrative = await this.writeNarrative(facts, period);
      const body = buildRecapHtml(facts, narrative, period);
      // Our own brand mark: a system-written post has no photograph, and an
      // empty hero shows as "Image not available" on the article and a blank
      // thumbnail on the board.
      const hero = await ensureRecapHero(this.firebase);

      await this.blogs.create({
        zone: "recap",
        title: narrative.headline,
        // The four-line summary doubles as the post's excerpt, so the article's
        // standfirst and the board card show the same lines.
        dek: narrative.summary4.join(" "),
        kick: "MarketCatalyst",
        author: "Desk",
        read: "",
        format: "html",
        html: body,
        heroImageUrl: hero,
        // Draft: a person decides whether model-written commentary goes public.
        status: "Draft",
        // Not a document any more, but the name still keys the duplicate check.
        pdfName: name,
      });

      await this.meta.record(JOB_NAME, { ok: true, count: 1 });
      this.logger.log(
        `recap blog draft for ${facts.date}: ${(body.length / 1024).toFixed(0)} KB of HTML, ` +
          `${facts.indices.length} indices, ${facts.sectorLeaders.length + facts.sectorLaggards.length} sectors` +
          `${hero ? "" : " (no hero image)"}`,
      );
      return { published: true, date: facts.date, bytes: body.length };
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

    /**
     * Breadth is re-read live rather than taken from the frozen snapshot, and
     * only used once enough of the universe has a bar for the session. Daily
     * bars arrive late: a snapshot written at 18:45 ET can hold a handful of
     * tickers, and one published "4 advancing, 14 declining" for a session that
     * finished 91 to 89. Below the threshold the recap omits breadth rather
     * than stating something that will be revised.
     */
    const breadthDoc = await db
      .collection("market_breadth")
      .doc(String(d.date ?? doc.id))
      .get()
      .catch(() => null);
    const b = breadthDoc?.exists ? breadthDoc.data() : null;
    const covered = typeof b?.covered === "number" ? b.covered : null;
    const universe = typeof b?.universe === "number" ? b.universe : null;
    const settled =
      covered != null && universe ? covered / universe >= BREADTH_MIN_COVERAGE : false;
    if (b && !settled) {
      this.logger.warn(
        `breadth for ${d.date} omitted — coverage ${covered ?? "unknown"}/${universe ?? "?"}`,
      );
    }

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
      // Live value when settled; otherwise nothing — never the snapshot's
      // possibly-partial copy.
      internals: settled ? (b as RecapFacts["internals"]) : null,
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
  private async writeNarrative(facts: RecapFacts, period: RecapPeriod = "daily"): Promise<RecapNarrative> {
    const movers = [...facts.topGainers.slice(0, 3), ...facts.topLosers.slice(0, 3)];
    /* What this recap covers, in the words the copy should use. A weekly recap
       that says "today" is wrong about its own subject. */
    const covers = period === "weekly" ? "the week" : period === "monthly" ? "the month" : "the session";
    const nextUnit = period === "weekly" ? "week" : period === "monthly" ? "month" : "session";
    const system =
      `You are the market editor for MarketCatalyst, writing the ${period} recap. ` +
      `You are given the real figures for ${covers}. Write ONLY prose about them. ` +
      "Never state a price, level, percentage or date that is not in the data given — " +
      "and for any series marked isProxy, describe DIRECTION ONLY, never the level: " +
      "it tracks a proxy instrument, so its number is not the index it is named after " +
      "(write \"volatility eased\", never \"the VIX fell below 18\"). " +
      "if you do not know why something moved, say so plainly. " +
      "No hype, no advice, no predictions presented as fact. " +
      "Reply with JSON only, no code fence, matching exactly: " +
      '{"headline":string,"summary4":[string,string,string,string],' +
      '"summary":[string,string],"moverNotes":{TICKER:string},' +
      '"stories":[{"title":string,"body":string}],"takeaway":string,"tags":[string]}. ' +
      "headline: under 90 characters, states the session's dominant theme. " +
      "summary4: EXACTLY four lines, each one sentence under 120 characters, " +
      "each a distinct takeaway from the session — this is the summary shown " +
      "beside the document, so it must stand alone. " +
      "summary: two paragraphs, 60-90 words each. " +
      "moverNotes: one entry per ticker given, 2-3 sentences; if no catalyst is " +
      "supplied, write that no confirmed catalyst was identified. " +
      "stories: 3-5 themes visible IN THE DATA (breadth, sector rotation, volatility, " +
      "macro assets) — not outside news you cannot verify. " +
      `takeaway: 2-3 sentences on what to watch next ${nextUnit}. tags: 6-8 short labels. ` +
      // The page draws charts from the same figures: a scaled bar per index, a
      // scaled bar per sector, and an advancers/decliners bar. Prose that names
      // the shape a reader is looking at is worth more than prose that repeats
      // the number printed beside it.
      "The article shows three charts built from these same figures: index " +
      "returns as scaled bars, sector returns as scaled bars, and advancers " +
      "against decliners as one proportion bar. Write so the prose EXPLAINS " +
      "those shapes rather than restating them — which end of the sector board " +
      "carried the move, whether the index result was broad or concentrated, " +
      "whether breadth agreed with the index. Do not describe a chart that is " +
      "not listed here, and do not give a number a shape it does not have. " +
      `Frame everything as ${covers}: say "${covers}" rather than "today" when ` +
      "the two differ, and compare against the span the figures actually cover.";

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

    const summary4 = strArr(parsed.summary4).slice(0, 4);

    return {
      headline,
      // Falls back to lines built from the figures: this is the post's excerpt
      // as well as a panel in the document, so an empty one would leave the
      // article page and the board card with nothing to show.
      summary4: summary4.length ? summary4 : this.factualKeyPoints(facts),
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

  /** Four lines straight from the data, for when the model gives none. */
  private factualKeyPoints(facts: RecapFacts): string[] {
    const lines: string[] = [];
    const pick = (re: RegExp) => facts.indices.find((i) => re.test(i.label) && i.pctChange != null);
    const move = (i: RecapFacts["indices"][number] | undefined, label: string) =>
      i ? `${label} closed ${i.pctChange! >= 0 ? "up" : "down"} ${Math.abs(i.pctChange!).toFixed(2)}%.` : null;

    const equities = [
      move(pick(/s&p/i), "The S&P 500"),
      move(pick(/nasdaq/i), "The Nasdaq"),
      move(pick(/dow/i), "The Dow"),
    ].filter((x): x is string => !!x);
    lines.push(...equities.slice(0, 2));

    const b = facts.internals;
    if (b?.advancers != null && b?.decliners != null) {
      lines.push(`Breadth finished ${b.advancers} advancing to ${b.decliners} declining.`);
    }
    const leader = facts.sectorLeaders[0];
    const laggard = facts.sectorLaggards[0];
    if (leader?.pctChange != null && laggard?.pctChange != null) {
      lines.push(
        `${leader.sector} led sectors at ${leader.pctChange >= 0 ? "+" : ""}${leader.pctChange.toFixed(2)}%, ` +
          `${laggard.sector} lagged at ${laggard.pctChange >= 0 ? "+" : ""}${laggard.pctChange.toFixed(2)}%.`,
      );
    }
    if (facts.sentiment?.value != null) {
      lines.push(`Market temperature reads ${facts.sentiment.value}/100 (${facts.sentiment.label ?? "—"}).`);
    }
    return lines.slice(0, 4);
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
