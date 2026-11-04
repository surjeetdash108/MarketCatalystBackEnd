/**
 * The words of an earnings article, written in code from the FMP facts.
 *
 * Every sentence is assembled from computed figures (earnings-article.facts),
 * so nothing is printed that FMP did not report or that code did not
 * calculate. Wording follows the skill: verdict words from §3, the lede's two
 * sentences, title under 100 characters, description 138–160 (§5), and number
 * formats from §6.
 */
import {
  apDate,
  etTime,
  epsName,
  formatEps,
  formatGapPct,
  formatMoney,
  formatMoneyProse,
  moneyDecimals,
  type ArticleFacts,
} from "./earnings-article.facts";

export interface Bullet {
  label: string;
  text: string;
}

export interface ArticleCopy {
  title: string;
  dek: string;
  description: string;
  lede: string;
  watch: Bullet[];
}

export function epsText(f: ArticleFacts, v: number): string {
  return formatEps(v);
}

export function revText(f: ArticleFacts, v: number, prose = false): string {
  const d = moneyDecimals(f.revenue.actual, f.revenue.estimate);
  return prose ? formatMoneyProse(v, d) : formatMoney(v, d);
}

export function reactionSentence(f: ArticleFacts): string | null {
  const r = f.reaction;
  if (!r) return null;
  const session =
    r.session === "regular" ? "in regular trading" : r.session === "premarket" ? "in premarket trading" : "in after-hours trading";
  const move = r.pct > 0 ? `rose ${formatGapPct(r.pct)}` : r.pct < 0 ? `fell ${formatGapPct(r.pct)}` : "were unchanged";
  if (r.session === "regular") return `Shares ${move} ${session} as of ${etTime(r.at)}, at ${formatEps(r.price)}.`;
  return `Shares ${move} ${session} as of ${etTime(r.at)}, to ${formatEps(r.price)} from a ${formatEps(r.reference)} close.`;
}

/** "third quarter of 2026" / "fiscal third quarter of 2026". */
export function quarterNoun(f: ArticleFacts): string {
  return f.quarterWords.replace(/-quarter (\d{4})$/, " quarter of $1");
}

function verdictVerb(f: ArticleFacts): string {
  switch (f.overall) {
    case "beat":
      return f.eps.verdict === "beat" && f.revenue.verdict === "beat" ? "Beats" : "Tops";
    case "miss":
      return f.eps.verdict === "miss" && f.revenue.verdict === "miss" ? "Misses" : "Falls Short of";
    case "inline":
      return "Matches";
    default:
      return "Reports";
  }
}

export function fallbackTitle(f: ArticleFacts): string {
  const q = f.quarter.replace(/^fiscal /, "Fiscal ");
  const rev = revText(f, f.revenue.actual);
  const eps = epsText(f, f.eps.actual);
  const yoy = f.revenue.yoyPct;
  const growth = yoy == null || yoy === 0 ? "" : ` as Revenue ${yoy > 0 ? "Rises" : "Falls"} ${formatGapPct(yoy)} to ${rev}`;
  const n = f.shortName;
  let t: string;
  if (f.overall === "mixed") {
    t =
      f.eps.verdict === "beat"
        ? `${n} ${q} EPS Tops Estimates at ${eps}, but Revenue Misses at ${rev}`
        : `${n} ${q} Revenue Tops Estimates at ${rev}, but EPS Misses at ${eps}`;
  } else if (f.overall === "none") {
    t = yoy != null ? `${n} ${q} Revenue ${yoy >= 0 ? "Rises" : "Falls"} ${formatGapPct(yoy)} to ${rev}` : `${n} Reports ${q} Revenue of ${rev}`;
  } else {
    t = `${n} ${verdictVerb(f)} ${q} Estimates${growth}`;
    if (t.length > 95) t = `${n} ${verdictVerb(f)} ${q} Estimates With ${rev} in Revenue`;
  }
  return t.length <= 99 ? t : t.slice(0, 99).replace(/\s+\S*$/, "");
}

function vsEstimate(kind: "eps" | "revenue", f: ArticleFacts, prose: boolean): string {
  const m = kind === "eps" ? f.eps : f.revenue;
  if (m.estimate == null) return "";
  const est = kind === "eps" ? epsText(f, m.estimate) : revText(f, m.estimate, prose);
  if (m.verdict === "beat") return ` above the ${est} estimate`;
  if (m.verdict === "miss") return ` below the ${est} estimate`;
  return ` in line with the ${est} estimate`;
}

export function fallbackLede(f: ArticleFacts): string {
  const who = `${f.shortName} (${f.symbol})`;
  const qn = quarterNoun(f);
  let s1: string;
  switch (f.overall) {
    case "beat":
      s1 =
        f.eps.verdict === "beat" && f.revenue.verdict === "beat"
          ? `${who} beat estimates for the ${qn} on both revenue and ${epsName(f)}.`
          : `${who} topped estimates for the ${qn}.`;
      break;
    case "miss":
      s1 =
        f.eps.verdict === "miss" && f.revenue.verdict === "miss"
          ? `${who} missed estimates for the ${qn} on both revenue and ${epsName(f)}.`
          : `${who} fell short of estimates for the ${qn}.`;
      break;
    case "mixed":
      s1 = `${who} posted mixed ${f.quarterWords} results, with ${
        f.eps.verdict === "beat" ? `${epsName(f)} above the estimate and revenue below it` : `revenue above the estimate and ${epsName(f)} below it`
      }.`;
      break;
    case "inline":
      s1 = `${who} matched estimates for the ${qn}.`;
      break;
    default:
      s1 = `${who} reported results for the ${qn}.`;
  }
  const change = (pct: number | null, ok: boolean) =>
    pct == null || !ok ? "" : pct === 0 ? ", unchanged from a year earlier," : `, ${pct > 0 ? "up" : "down"} ${formatGapPct(pct)} from a year earlier,`;
  const epsComparable = f.eps.yearAgo != null && Math.sign(f.eps.actual) === Math.sign(f.eps.yearAgo);
  const rev = `Revenue was ${revText(f, f.revenue.actual, true)}${change(f.revenue.yoyPct, true)}${vsEstimate("revenue", f, true)}`;
  const eps = `${epsName(f)} was ${epsText(f, f.eps.actual)}${change(f.eps.yoyPct, epsComparable)}${vsEstimate("eps", f, true)}`;
  return `${s1} ${rev}, and ${eps}.`.replace(/,(\s*[,.])/g, "$1");
}

export function fallbackDek(f: ArticleFacts): string {
  const rev = `Revenue of ${revText(f, f.revenue.actual)}${f.revenue.estimate != null ? ` vs. ${revText(f, f.revenue.estimate)} expected` : ""}`;
  const eps = `${epsName(f)} of ${epsText(f, f.eps.actual)}${f.eps.estimate != null ? ` vs. ${epsText(f, f.eps.estimate)}` : ""}`;
  const yoy = f.revenue.yoyPct != null && f.revenue.yoyPct !== 0 ? `; revenue ${f.revenue.yoyPct > 0 ? "up" : "down"} ${formatGapPct(f.revenue.yoyPct)} from a year earlier` : "";
  return `${rev} and ${eps}${yoy}.`;
}

/** 138–160 characters (skill §5), built from candidates until one fits. */
export function fallbackDescription(f: ArticleFacts): string {
  const verdict =
    f.overall === "beat" ? "beat" : f.overall === "miss" ? "missed" : f.overall === "mixed" ? "had mixed" : f.overall === "inline" ? "matched" : "reported";
  const what = f.overall === "mixed" || f.overall === "none" ? `${f.quarter} results` : `${f.quarter} estimates`;
  const core = `${f.shortName} ${verdict} ${what}: revenue ${revText(f, f.revenue.actual)}${f.revenue.estimate != null ? ` vs. ${revText(f, f.revenue.estimate)} expected` : ""}, ${epsName(f)} ${epsText(f, f.eps.actual)}${f.eps.estimate != null ? ` vs. ${epsText(f, f.eps.estimate)}` : ""}.`;
  const tails = [
    "",
    f.revenue.yoyPct != null ? ` Revenue ${f.revenue.yoyPct >= 0 ? "rose" : "fell"} ${formatGapPct(f.revenue.yoyPct)} from a year earlier.` : "",
    " Full scorecard with YoY and QoQ changes.",
    " See the scorecard and YoY and QoQ changes.",
    " Scorecard inside.",
    " Full scorecard, YoY and QoQ changes, and what to watch next.",
  ];
  const candidates: string[] = [];
  for (const a of tails) for (const b of tails) if (a !== b || a === "") candidates.push(`${core}${a}${b}`.replace(/\s+/g, " ").trim());
  const fit = candidates.find((c) => c.length >= 138 && c.length <= 160);
  if (fit) return fit;
  const short = candidates.filter((c) => c.length < 138).sort((x, y) => y.length - x.length)[0] ?? core;
  const pad = [" With YoY and QoQ changes and next-quarter estimates.", " With the full scorecard.", " Details inside."];
  for (const p of pad) {
    const c = `${short}${p}`;
    if (c.length >= 138 && c.length <= 160) return c;
  }
  return core.length > 160 ? `${core.slice(0, 157).replace(/\s+\S*$/, "")}.` : core;
}

export function fallbackWatch(f: ArticleFacts): Bullet[] {
  const pool: Bullet[] = [];
  if (f.next?.revenueAvg != null || f.next?.epsAvg != null) {
    const parts = [
      f.next.epsAvg != null ? `EPS of ${formatEps(f.next.epsAvg)}` : null,
      f.next.revenueAvg != null ? `revenue of ${formatMoneyProse(f.next.revenueAvg)}` : null,
    ].filter(Boolean);
    pool.push({
      label: "Next-quarter estimates",
      text: `Consensus calls for ${parts.join(" and ")} next quarter${f.next.analysts ? `, based on ${f.next.analysts} analyst${f.next.analysts === 1 ? "" : "s"}` : ""}.`,
    });
  }
  if (f.next?.reportDate) {
    pool.push({ label: "Next report", text: `${f.shortName} is next expected to report on ${apDate(f.next.reportDate)}.` });
  }
  if (f.revenue.yoyPct != null && f.revenue.yoyPct !== 0) {
    pool.push({
      label: "Revenue growth",
      text:
        f.revenue.yoyPct > 0
          ? `Whether revenue keeps growing from a year earlier after this quarter's ${formatGapPct(f.revenue.yoyPct)} increase to ${revText(f, f.revenue.actual, true)}.`
          : `Whether revenue stabilizes after this quarter's ${formatGapPct(f.revenue.yoyPct)} decline from a year earlier to ${revText(f, f.revenue.actual, true)}.`,
    });
  }
  if (f.record.epsOf >= 2) {
    pool.push({
      label: "Estimate record",
      text:
        f.record.epsBeats * 2 >= f.record.epsOf
          ? `Whether ${f.shortName} extends a record of beating EPS estimates in ${f.record.epsBeats} of its last ${f.record.epsOf} reports.`
          : `Whether ${f.shortName} returns to beating EPS estimates, which it did in ${f.record.epsBeats} of its last ${f.record.epsOf} reports.`,
    });
  }
  if (f.reaction) {
    pool.push({ label: "Share reaction", text: `How shares trade in the next regular session after the ${formatGapPct(f.reaction.pct)} ${f.reaction.pct >= 0 ? "gain" : "decline"} ${f.reaction.session === "regular" ? "during the session" : `in ${f.reaction.session} trading`}.` });
  }
  if (f.revenue.qoqPct != null) {
    pool.push({
      label: "Sequential trend",
      text: `Whether revenue builds on its ${formatGapPct(f.revenue.qoqPct)} ${f.revenue.qoqPct >= 0 ? "increase" : "decrease"} from the previous quarter.`,
    });
  }
  return pool.slice(0, 3);
}

export function fallbackCopy(f: ArticleFacts): ArticleCopy {
  return {
    title: fallbackTitle(f),
    dek: fallbackDek(f),
    description: fallbackDescription(f),
    lede: fallbackLede(f),
    watch: fallbackWatch(f),
  };
}

