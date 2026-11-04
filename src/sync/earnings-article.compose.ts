/**
 * Facts + checked copy → the article (skill §4 order), as the blog's
 * "simple" template document — the same shell the blog tool uses for the
 * hand-written earnings posts, so automated ones look identical.
 */
import { blogSlug, composeDocument } from "../blogs/blogs-admin.service";
import { SIMPLE_THEME, composeSimpleBody } from "../mcp/blog-templates/simple";
import {
  buildEarningsBodyHtml,
  type EarningsArticleInput,
  type EarningsChangeRow,
  type EarningsScorecardRow,
  type EarningsStatBox,
  type RelatedCard,
} from "./earnings-article-html.builder";
import {
  apDate,
  changeCell,
  epsName,
  etIso,
  etTime,
  formatEps,
  formatGapPct,
  formatMoneyProse,
  type ArticleFacts,
  type Verdict,
} from "./earnings-article.facts";
import { epsText, reactionSentence, revText, type ArticleCopy, type Bullet } from "./earnings-article.writer";

const GREEN = "#1E8449" as const;
const RED = "#C0392B" as const;
const BLUE = "#2563EB" as const;

const tone = (v: Verdict) => (v === "beat" ? GREEN : v === "miss" ? RED : BLUE);
const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${formatGapPct(v)}`;

function statBoxes(f: ArticleFacts): [EarningsStatBox, EarningsStatBox, EarningsStatBox] {
  const yoyLabel = (pct: number | null, comparable: boolean) =>
    pct == null || !comparable ? "" : pct === 0 ? ", flat YoY" : `, ${pct > 0 ? "up" : "down"} ${formatGapPct(pct)} YoY`;
  const epsComparable = f.eps.yearAgo != null && Math.sign(f.eps.actual) === Math.sign(f.eps.yearAgo);
  const eps: EarningsStatBox = {
    num: epsText(f, f.eps.actual),
    label: `${epsName(f, true)}${yoyLabel(f.eps.yoyPct, epsComparable)}${f.eps.estimate != null ? ` vs. ${epsText(f, f.eps.estimate)} estimate` : ""}`,
    color: tone(f.eps.verdict),
  };
  const rev: EarningsStatBox = {
    num: revText(f, f.revenue.actual),
    label: `Revenue${yoyLabel(f.revenue.yoyPct, true)}${f.revenue.estimate != null ? ` vs. ${revText(f, f.revenue.estimate)} estimate` : ""}`,
    color: tone(f.revenue.verdict),
  };
  let third: EarningsStatBox;
  const r = f.reaction;
  if (r) {
    const where = r.session === "regular" ? "in regular trading" : r.session === "premarket" ? "premarket" : "after hours";
    third = { num: signed(r.pct), label: `Shares ${where} as of ${etTime(r.at)}`, color: r.pct > 0 ? GREEN : r.pct < 0 ? RED : BLUE };
  } else if (f.record.epsOf >= 4) {
    third = {
      num: `${f.record.epsBeats} of ${f.record.epsOf}`,
      label: `EPS beats in the last ${f.record.epsOf} reports`,
      color: f.record.epsBeats >= f.record.epsOf / 2 ? GREEN : RED,
    };
  } else if (f.revenue.qoqPct != null) {
    third = { num: signed(f.revenue.qoqPct), label: "Revenue change from the previous quarter", color: f.revenue.qoqPct >= 0 ? GREEN : RED };
  } else if (f.next?.revenueAvg != null) {
    third = { num: formatMoneyProse(f.next.revenueAvg).replace(" billion", "B").replace(" million", "M"), label: "Next-quarter revenue consensus", color: BLUE };
  } else {
    third = { num: f.quarter.replace(/^fiscal /, "FQ"), label: `Reported ${apDate(f.reportDate)}`, color: BLUE };
  }
  return [eps, rev, third];
}

function scorecard(f: ArticleFacts): EarningsScorecardRow[] {
  const rows: EarningsScorecardRow[] = [];
  const cls = (v: Verdict) => (v === "beat" ? "pos" : v === "miss" ? "dn" : "") as "pos" | "dn" | "";
  if (f.eps.estimate != null && f.eps.gapText) {
    rows.push({ parameter: epsName(f, true), expected: epsText(f, f.eps.estimate), actual: epsText(f, f.eps.actual), beatMissText: f.eps.gapText, beatMissClass: cls(f.eps.verdict) });
  }
  if (f.revenue.estimate != null && f.revenue.gapText) {
    rows.push({ parameter: "Revenue", expected: revText(f, f.revenue.estimate), actual: revText(f, f.revenue.actual), beatMissText: f.revenue.gapText, beatMissClass: cls(f.revenue.verdict) });
  }
  return rows;
}

function changeGrid(f: ArticleFacts): EarningsChangeRow[] {
  const row = (metric: string, actual: number, yearAgo: number | null, prior: number | null, fmt: (v: number) => string): EarningsChangeRow => {
    const y = changeCell(actual, yearAgo, fmt);
    const q = changeCell(actual, prior, fmt);
    return { metric, yoyText: y?.text ?? null, yoyClass: y?.cls ?? "", qoqText: q?.text ?? null, qoqClass: q?.cls ?? "" };
  };
  return [
    row(epsName(f, true), f.eps.actual, f.eps.yearAgo, f.eps.prior, formatEps),
    row("Revenue", f.revenue.actual, f.revenue.yearAgo, f.revenue.prior, (v) => revText(f, v)),
  ];
}

export function byOurCalculation(f: ArticleFacts): string {
  const parts: string[] = [];
  if (f.revenue.gap != null && f.revenue.verdict !== "inline") {
    parts.push(`revenue was ${formatMoneyProse(Math.abs(f.revenue.gap))} ${f.revenue.gap > 0 ? "above" : "below"} the estimate`);
  }
  if (f.eps.gap != null && f.eps.verdict !== "inline") {
    parts.push(`${epsName(f)} was ${formatEps(Math.abs(f.eps.gap))} ${f.eps.gap > 0 ? "above" : "below"} it`);
  }
  const sentences: string[] = [];
  if (parts.length) sentences.push(`By our calculation, ${parts.join(" and ")}.`);
  if (f.revenue.prior != null && f.eps.prior != null) {
    sentences.push(
      `${sentences.length ? "The" : "By our calculation, the"} QoQ column compares with the previous quarter's revenue of ${revText(f, f.revenue.prior, true)} and ${epsName(f)} of ${formatEps(f.eps.prior)}.`,
    );
  }
  if (f.revenue.yearAgo != null && f.eps.yearAgo != null) {
    sentences.push(
      `${sentences.length ? "The" : "By our calculation, the"} YoY column compares with ${revText(f, f.revenue.yearAgo, true)} and ${formatEps(f.eps.yearAgo)} in the same quarter a year earlier.`,
    );
  }
  return sentences.join(" ");
}

function gaapSection(f: ArticleFacts): { title: string; bullets: Bullet[] } | null {
  if (!f.gaap) return null;
  const { current: c, yearAgo: y } = f.gaap;
  const bullets: Bullet[] = [];
  if (f.epsBasis === "adjusted") {
    bullets.push({
      label: "GAAP EPS",
      text: `GAAP diluted EPS was ${formatEps(c.epsDiluted!)}${y?.epsDiluted != null ? `, against ${formatEps(y.epsDiluted)} a year earlier` : ""}.`,
    });
  }
  if (c.netIncome != null) {
    const ni = (v: number) => (v < 0 ? `a net loss of ${formatMoneyProse(-v)}` : `net income of ${formatMoneyProse(v)}`);
    bullets.push({
      label: c.netIncome < 0 ? "Net loss" : "Net income",
      text: `The company reported ${ni(c.netIncome)} on a GAAP basis${y?.netIncome != null && y.netIncome !== 0 ? `, compared with ${ni(y.netIncome)} a year earlier` : ""}.`,
    });
  }
  return { title: "GAAP results", bullets };
}

function recordSection(f: ArticleFacts, includeNext: boolean): { title: string; bullets: Bullet[] } | null {
  const bullets: Bullet[] = [];
  if (f.record.epsOf >= 2) {
    bullets.push({ label: "EPS record", text: `${epsName(f, true)} beat the estimate in ${f.record.epsBeats} of the last ${f.record.epsOf} reports, including this one.` });
  }
  if (f.record.revOf >= 2) {
    bullets.push({ label: "Revenue record", text: `Revenue beat the estimate in ${f.record.revBeats} of the last ${f.record.revOf} reports.` });
  }
  if (f.revenueTrend.length >= 3) {
    const vals = f.revenueTrend.map((v) => revText(f, v, true));
    bullets.push({
      label: "Revenue trend",
      text: `Revenue over the last ${vals.length} reports, oldest first: ${vals.slice(0, -1).join(", ")} and ${vals[vals.length - 1]}.`,
    });
  }
  if (includeNext && f.next) {
    const parts = [
      f.next.epsAvg != null ? `EPS of ${formatEps(f.next.epsAvg)}` : null,
      f.next.revenueAvg != null ? `revenue of ${formatMoneyProse(f.next.revenueAvg)}` : null,
    ].filter(Boolean);
    if (parts.length) {
      bullets.push({
        label: "Next quarter",
        text: `Consensus calls for ${parts.join(" and ")}${f.next.analysts ? ` from ${f.next.analysts} analyst${f.next.analysts === 1 ? "" : "s"}` : ""}${f.next.reportDate ? `, with the next report expected on ${apDate(f.next.reportDate)}` : ""}.`,
      });
    }
  }
  return bullets.length ? { title: "Track record and expectations", bullets } : null;
}

export interface ComposeOptions {
  /** Epoch ms the post is created; the article is stamped one minute earlier (skill §7). */
  createdMs: number;
  related: RelatedCard[];
  /** True when the company's Form 8-K release was found and used. */
  has8k: boolean;
  /** Slug override (when the blog assigned a "-2" suffix, or on a later edit). */
  slug?: string;
  /** Epoch ms of a later edit — sets dateModified only. */
  modifiedMs?: number;
}

export interface ComposedArticle {
  input: EarningsArticleInput;
  title: string;
  dek: string;
  read: string;
  slug: string;
  /** The full "simple"-template document, as the blog stores it. */
  documentHtml: string;
}

const proseWords = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<section class="mc-ra"[\s\S]*?<\/section>|<div class="disclaimer">[\s\S]*?<\/div>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;

export function composeArticle(f: ArticleFacts, copy: ArticleCopy, opts: ComposeOptions): ComposedArticle {
  const slug = opts.slug ?? blogSlug(copy.title);
  const stamp = opts.createdMs - 60_000;
  const sections = [
    ...copy.sections,
    gaapSection(f),
    recordSection(f, copy.fromModel.includes("watch")),
  ].filter((s): s is { title: string; bullets: Bullet[] } => !!s && s.bullets.length > 0);

  const related = opts.related.slice(0, 4) as [RelatedCard, RelatedCard, RelatedCard, RelatedCard];
  const sources =
    `Results are from ${f.shortName}'s ${apDate(f.reportDate)} results release${opts.has8k ? " and Form 8-K" : ""}. ` +
    `Estimates are consensus figures. The prior-quarter and year-ago comparison figures are from ${f.shortName}'s earlier quarterly reports. ` +
    `Items labeled by our calculation are our own arithmetic. This article is informational only and is not investment advice.`;

  const input: EarningsArticleInput = {
    company: f.company,
    ticker: f.symbol,
    period: f.quarter.replace(/^fiscal /, "Fiscal "),
    announcedDateFormatted: apDate(f.reportDate),
    announcedIsoDate: etIso(stamp),
    modifiedIsoDate: opts.modifiedMs ? etIso(opts.modifiedMs) : undefined,
    slug,
    stripCode: f.symbol.toLowerCase().replace(/[^a-z]/g, "").slice(0, 5) || "mc",
    title: copy.title,
    dek: copy.dek,
    metaDescription: copy.description,
    readTime: "",
    lede: copy.lede,
    stockMove: reactionSentence(f),
    stockMoveTone: f.reaction && f.reaction.pct > 0 ? "pos" : "dn",
    statBoxes: statBoxes(f),
    scorecardRows: scorecard(f),
    changeRows: changeGrid(f),
    hasQoq: f.hasQoq,
    hasYoy: f.hasYoy,
    byOurCalculation: byOurCalculation(f),
    industrySections: sections,
    whatToWatchBullets: copy.watch,
    sourcesText: sources,
    relatedCards: related,
  };
  const body = buildEarningsBodyHtml(input);
  const minutes = Math.max(1, Math.ceil(proseWords(body) / 230));
  input.readTime = `${minutes} min read`;
  const etStamp = etTime(stamp).replace(" a.m.", " AM").replace(" p.m.", " PM");
  const read = `Published ${apDate(etIso(stamp).slice(0, 10)).replace(".", "")} · ${etStamp} · ${minutes} min read`;
  const documentHtml = composeDocument(
    composeSimpleBody({ title: copy.title, dek: copy.dek, kick: "Earnings", read, bodyHtml: body }),
    SIMPLE_THEME,
  );
  return { input, title: copy.title, dek: copy.dek, read, slug, documentHtml };
}
