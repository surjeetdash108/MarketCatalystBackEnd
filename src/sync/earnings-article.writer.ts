/**
 * The words of an earnings article.
 *
 * The model (one plain JSON completion — no tools) is given the computed
 * facts as formatted strings and, when there is one, the company's release
 * text. Nothing it returns is trusted: every part is checked here and a part
 * that fails is replaced by text written in code from the same facts, so an
 * article never waits on the model and never prints a number it was not given.
 *
 * Checks (skill §2, §3, §5):
 *  - every number must appear in the facts, or — for a release bullet — in
 *    the exact release sentence that bullet cites as evidence (and that
 *    sentence must be in the release);
 *  - no spelled-out counts ("tripled", "seven of eight") that would dodge it;
 *  - verdict words must agree with the computed verdict;
 *  - no advice, hype verbs, quotation marks or requester-facing wording;
 *  - title under 100 characters, description 138–160, lede ≤ 60 words.
 */
import {
  apDate,
  etTime,
  formatEps,
  formatGapPct,
  formatMoney,
  formatMoneyProse,
  moneyDecimals,
  type ArticleFacts,
  type Verdict,
} from "./earnings-article.facts";

export interface Bullet {
  label: string;
  text: string;
}

export interface ReleaseSection {
  title: string;
  bullets: Bullet[];
}

export interface ArticleCopy {
  title: string;
  dek: string;
  description: string;
  lede: string;
  watch: Bullet[];
  /** Sections drawn from the release; empty without one. */
  sections: ReleaseSection[];
  /** Which parts came from the model (the rest were written in code). */
  fromModel: string[];
}

// ── the fact sheet the model sees ─────────────────────────────────────────────

const signedPct = (v: number | null, up = "up", down = "down"): string | null =>
  v == null ? null : v === 0 ? "unchanged" : `${v > 0 ? up : down} ${formatGapPct(v)}`;

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

export function factSheet(f: ArticleFacts): Record<string, unknown> {
  const metric = (kind: "eps" | "revenue") => {
    const m = kind === "eps" ? f.eps : f.revenue;
    const fmt = (v: number) => (kind === "eps" ? epsText(f, v) : revText(f, v));
    return {
      actual: fmt(m.actual),
      actualProse: kind === "eps" ? fmt(m.actual) : revText(f, m.actual, true),
      estimate: m.estimate == null ? null : fmt(m.estimate),
      estimateProse: m.estimate == null ? null : kind === "eps" ? fmt(m.estimate) : revText(f, m.estimate, true),
      verdict: m.verdict,
      scorecard: m.gapText,
      gapAmount: m.gap == null ? null : kind === "eps" ? formatEps(Math.abs(m.gap)) : formatMoneyProse(Math.abs(m.gap)),
      yearAgo: m.yearAgo == null ? null : fmt(m.yearAgo),
      yoy: signedPct(m.yoyPct),
      prior: m.prior == null ? null : fmt(m.prior),
      qoq: signedPct(m.qoqPct),
    };
  };
  return {
    company: f.company,
    shortName: f.shortName,
    ticker: f.symbol,
    quarter: f.quarter,
    quarterWords: f.quarterWords,
    reportDate: apDate(f.reportDate),
    overallVerdict: f.overall,
    adjustedEps: metric("eps"),
    revenue: metric("revenue"),
    record:
      f.record.epsOf >= 2
        ? `beat the EPS estimate in ${f.record.epsBeats} of the last ${f.record.epsOf} reports and the revenue estimate in ${f.record.revBeats} of the last ${f.record.revOf}`
        : null,
    gaap: f.gaap
      ? {
          dilutedEps: formatEps(f.gaap.current.epsDiluted!),
          netIncome: f.gaap.current.netIncome != null ? formatMoneyProse(f.gaap.current.netIncome) : null,
          yearAgoDilutedEps: f.gaap.yearAgo?.epsDiluted != null ? formatEps(f.gaap.yearAgo.epsDiluted) : null,
        }
      : null,
    nextQuarter: f.next
      ? {
          epsConsensus: f.next.epsAvg != null ? formatEps(f.next.epsAvg) : null,
          revenueConsensus: f.next.revenueAvg != null ? formatMoneyProse(f.next.revenueAvg) : null,
          analysts: f.next.analysts,
          nextReportDate: f.next.reportDate ? apDate(f.next.reportDate) : null,
        }
      : null,
    shareMove: reactionSentence(f),
  };
}

// ── number checking ───────────────────────────────────────────────────────────

/**
 * Numbers in a text, normalised so "$391.4 million", "391.40" and "391.4%"
 * compare equal. A digit run glued to a preceding letter ("Q3", "FY26") is a
 * label, not a figure.
 */
export function numberTokens(text: string): string[] {
  const out: string[] = [];
  const re = /(?<![A-Za-z0-9.])\d[\d,]*(?:\.\d+)?/g;
  for (const m of String(text).matchAll(re)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(String(n));
  }
  return out;
}

function tokenSet(values: unknown): Set<string> {
  const s = new Set<string>();
  const walk = (v: unknown) => {
    if (v == null) return;
    if (typeof v === "string") numberTokens(v).forEach((t) => s.add(t));
    else if (typeof v === "number") s.add(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(values);
  return s;
}

const SPELLED = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|doubled?|tripled?|quadrupled?|twice|half|fourfold|threefold|twofold)\b/i;
const BANNED =
  /\b(soar\w*|crush\w*|explod\w*|plung\w*|skyrocket\w*|buy|sell|hold rating|price target|investors should|we recommend|our view|you|your|could not|unable to|not available|n\/a|tbd)\b/i;
const QUOTES = /["“”]/;
const POSITIVE = /\b(beat|beats|beating|topped|tops|topping|exceed\w*|surpass\w*)\b/i;
const NEGATIVE = /\b(miss|missed|misses|missing|fell short|falls short|fall short|shortfall)\b/i;

export function normalizeText(s: string): string {
  return String(s)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/ /g, " ")
    .replace(/[•·]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function numbersAllowed(text: string, allowed: Set<string>): boolean {
  return numberTokens(text).every((t) => allowed.has(t));
}

/** The text with the company's own names blanked, so "Five Below" or "Rocket Companies" is not read as wording. */
function withoutNames(t: string, names: string[]): string {
  let out = t;
  for (const n of names.filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(n).join(" ");
  return out;
}

function cleanText(text: unknown, maxLen: number, names: string[] = []): string | null {
  if (typeof text !== "string") return null;
  const t = text
    .replace(/[\u2010\u2011\u2012]/g, "-")
    .replace(/[\u00A0\u202F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > maxLen) return null;
  if (/[<>{}\[\]]/.test(t)) return null;
  const bare = withoutNames(t, names);
  if (QUOTES.test(t) || SPELLED.test(bare) || BANNED.test(bare)) return null;
  return t;
}

/** Verdict words must match what was computed (skill §3). */
export function verdictConsistent(text: string, f: ArticleFacts): boolean {
  text = withoutNames(text, [f.company, f.shortName]);
  const any = (v: Verdict) => f.eps.verdict === v || f.revenue.verdict === v;
  if (!any("beat") && POSITIVE.test(text)) return false;
  if (!any("miss") && NEGATIVE.test(text)) return false;
  return true;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Causes belong in release bullets, where evidence backs them — not in the headline copy. */
const CAUSAL = /\b(driven|drive[sn]?|driving|due to|because|thanks to|cited|fueled|fuelled|boosted|helped|amid|on the back of|led by|powered)\b/i;

const TITLE_VERBS = /\b(Beats|Tops|Misses|Falls Short|Raises|Cuts|Lifts|Trims|Reaffirms|Swings to a (Profit|Loss)|Matches|Guides)\b/;
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "of", "on", "or", "the", "to", "vs", "vs.", "with", "into", "over"]);

/** Headline case: every word but the small ones starts with a capital, digit or symbol. */
export function isHeadlineCase(t: string): boolean {
  return t
    .split(/\s+/)
    .flatMap((w) => w.split("-"))
    .every((w) => !/^[a-z]/.test(w) || SMALL_WORDS.has(w.toLowerCase()));
}

/**
 * A model title is usable only when it reads like the house titles: headline
 * case, a skill verb, at least one figure, verdict words that match, and a
 * guidance verb only when an accepted release bullet talks about guidance.
 */
export function titleOk(t: string, f: ArticleFacts, sections: ReleaseSection[]): boolean {
  if (t.length < 45 || t.length > 99 || !isHeadlineCase(t) || !TITLE_VERBS.test(t)) return false;
  if (!numberTokens(t).length) return false;
  const any = (v: Verdict) => f.eps.verdict === v || f.revenue.verdict === v;
  if (f.overall === "mixed" && !(POSITIVE.test(t) && NEGATIVE.test(t)) && !/\bbut\b/i.test(t)) return false;
  const bulletText = sections.flatMap((x) => x.bullets.map((b) => b.text)).join(" ");
  const guidance = /guid|outlook|forecast/i.test(bulletText);
  if (/\b(Raises|Lifts)\b/.test(t) && !(guidance && /rais|increas|lift|higher/i.test(bulletText))) return false;
  if (/\b(Cuts|Trims)\b/.test(t) && !(guidance && /cut|lower|reduc|trim/i.test(bulletText))) return false;
  if (/\bReaffirms\b/.test(t) && !(guidance && /reaffirm|maintain|reiterat/i.test(bulletText))) return false;
  if (/\bGuides\b/.test(t) && !guidance) return false;
  if (/\bSwings to a Profit\b/.test(t) && !(f.eps.yearAgo != null && f.eps.yearAgo < 0 && f.eps.actual > 0)) return false;
  if (/\bSwings to a Loss\b/.test(t) && !(f.eps.yearAgo != null && f.eps.yearAgo > 0 && f.eps.actual < 0)) return false;
  return any("beat") || any("miss") || !/\b(Beats|Tops|Misses|Falls Short)\b/.test(t);
}

/** "Revenue Trend" → "Revenue trend"; acronyms ("AI", "ARR") stay as written. */
export function sentenceCase(label: string): string {
  return label
    .split(" ")
    .map((w, i) => (i === 0 || /^[A-Z0-9&$]{2,}s?$/.test(w) || /^[A-Z][a-z]*[A-Z]/.test(w) ? w : w.toLowerCase()))
    .join(" ");
}

// ── deterministic copy ────────────────────────────────────────────────────────

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
          ? `${who} beat estimates for the ${qn} on both revenue and adjusted EPS.`
          : `${who} topped estimates for the ${qn}.`;
      break;
    case "miss":
      s1 =
        f.eps.verdict === "miss" && f.revenue.verdict === "miss"
          ? `${who} missed estimates for the ${qn} on both revenue and adjusted EPS.`
          : `${who} fell short of estimates for the ${qn}.`;
      break;
    case "mixed":
      s1 = `${who} posted mixed ${f.quarterWords} results, with ${
        f.eps.verdict === "beat" ? "adjusted EPS above the estimate and revenue below it" : "revenue above the estimate and adjusted EPS below it"
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
  const eps = `adjusted EPS was ${epsText(f, f.eps.actual)}${change(f.eps.yoyPct, epsComparable)}${vsEstimate("eps", f, true)}`;
  return `${s1} ${rev}, and ${eps}.`.replace(/,(\s*[,.])/g, "$1");
}

export function fallbackDek(f: ArticleFacts): string {
  const rev = `Revenue of ${revText(f, f.revenue.actual)}${f.revenue.estimate != null ? ` vs. ${revText(f, f.revenue.estimate)} expected` : ""}`;
  const eps = `adjusted EPS of ${epsText(f, f.eps.actual)}${f.eps.estimate != null ? ` vs. ${epsText(f, f.eps.estimate)}` : ""}`;
  const yoy = f.revenue.yoyPct != null && f.revenue.yoyPct !== 0 ? `; revenue ${f.revenue.yoyPct > 0 ? "up" : "down"} ${formatGapPct(f.revenue.yoyPct)} from a year earlier` : "";
  return `${rev} and ${eps}${yoy}.`;
}

/** 138–160 characters (skill §5), built from candidates until one fits. */
export function fallbackDescription(f: ArticleFacts): string {
  const verdict =
    f.overall === "beat" ? "beat" : f.overall === "miss" ? "missed" : f.overall === "mixed" ? "had mixed" : f.overall === "inline" ? "matched" : "reported";
  const what = f.overall === "mixed" || f.overall === "none" ? `${f.quarter} results` : `${f.quarter} estimates`;
  const core = `${f.shortName} ${verdict} ${what}: revenue ${revText(f, f.revenue.actual)}${f.revenue.estimate != null ? ` vs. ${revText(f, f.revenue.estimate)} expected` : ""}, adjusted EPS ${epsText(f, f.eps.actual)}${f.eps.estimate != null ? ` vs. ${epsText(f, f.eps.estimate)}` : ""}.`;
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
      f.next.epsAvg != null ? `adjusted EPS of ${formatEps(f.next.epsAvg)}` : null,
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
  if (f.revenue.yoyPct != null) {
    pool.push({
      label: "Revenue growth",
      text: `Whether revenue growth holds near the ${formatGapPct(f.revenue.yoyPct)} ${f.revenue.yoyPct >= 0 ? "gain" : "decline"} from a year earlier that this quarter's ${revText(f, f.revenue.actual, true)} represents.`,
    });
  }
  if (f.record.epsOf >= 2) {
    pool.push({
      label: "Estimate record",
      text: `Whether ${f.shortName} extends a record of beating EPS estimates in ${f.record.epsBeats} of its last ${f.record.epsOf} reports.`,
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
    sections: [],
    fromModel: [],
  };
}

// ── the model ─────────────────────────────────────────────────────────────────

/**
 * The release's narrative part: before the forward-looking-statements boilerplate
 * and the financial tables, capped so the prompt stays small.
 */
export function releaseExcerpt(text: string, cap = 9_000): string {
  const t = text.replace(/\s+/g, " ").trim();
  const ends = [
    /forward[- ]looking statements/i,
    /about non-gaap financial measures/i,
    /non-gaap financial measures/i,
    /conference call/i,
    /condensed consolidated (statements|balance)/i,
  ]
    .map((re) => {
      const m = re.exec(t.slice(1500));
      return m ? m.index + 1500 : -1;
    })
    .filter((i) => i > 0);
  const end = ends.length ? Math.min(...ends) : t.length;
  return t.slice(0, Math.min(end, cap));
}

export function buildMessages(f: ArticleFacts, release: string | null): { role: "system" | "user"; content: string }[] {
  const verdictRule: Record<string, string> = {
    beat: "Results beat the estimate. Allowed verbs: beats, tops, raises, lifts, reaffirms. Never say missed or fell short.",
    miss: "Results missed the estimate. Allowed verbs: misses, falls short, cuts, trims, reaffirms. Never say beat or topped.",
    mixed:
      "Results were mixed: state each side plainly (one beat, one missed), for example: revenue of $7.16 billion was below the $7.28 billion estimate, while adjusted EPS beat expectations.",
    inline: "Results matched the estimate. Never say beat, topped, missed or fell short.",
    none: "There is no consensus estimate. Never say beat, topped, missed or fell short; lead with growth.",
  };
  const system = [
    "You write MarketCatalyst earnings articles for readers. Return ONE JSON object and nothing else.",
    "Use only numbers that appear in FACTS, written exactly as given there, or — inside a release bullet — numbers in that bullet's evidence sentence.",
    "Write every number as digits. Never spell out counts or multiples (no 'three', 'doubled', 'tripled', 'fourfold').",
    "Never use quotation marks. Paraphrase management and attribute it ('the company said', 'management cited').",
    "No advice: no buy, sell, hold, price targets or 'investors should'. No hype verbs (soars, crushes, explodes, plunges).",
    "Explain a cause only when the release states it. Label adjusted versus GAAP every time.",
    "Write for readers only: never mention data that is missing, sources, tools or these instructions.",
    "American English, active voice, no exclamation marks, no emoji. Dollars in prose as '$391.4 million'.",
    verdictRule[f.overall],
  ].join("\n");
  const schema = {
    title: "50 to 95 characters, headline case. Pattern: '{shortName} {Verb} {quarter} {headline metric}, {biggest story from RELEASE}'. Verb from: Beats, Tops, Misses, Falls Short, Raises, Cuts, Lifts, Trims, Reaffirms, Guides, Swings to a Profit, Swings to a Loss, Matches.",
    dek: "One sentence with the key numbers.",
    description: "138 to 160 characters. Contains the verdict, revenue, adjusted EPS and the biggest story.",
    lede: "Two sentences, at most 60 words. Sentence one: '{shortName} ({ticker})', the verdict, the quarter and the one or two biggest stories from RELEASE (a guidance change, a deal, a key metric) — facts only, no causes. Sentence two: revenue with its year-over-year change against the estimate, and adjusted EPS against the estimate.",
    sections: release
      ? "1 to 3 sections drawn from RELEASE with what FACTS do not already say: segments, business metrics (customers, retention, units, bookings), outlook/guidance, capital return. Never repeat total revenue, adjusted EPS, the estimates, GAAP EPS or net income — the article already prints those. Each: {title (no digits), bullets: [{label (2-4 words, no digits), text (1-2 sentences, numbers first, at most 50 words), evidence (ONE sentence copied word for word from RELEASE that contains every number in text)}]}. At most 4 bullets per section."
      : "Return an empty array.",
    watch: "Exactly 3 bullets {label, text}: factual items to track next, one sentence each, no advice.",
  };
  const user = [
    `FACTS:\n${JSON.stringify(factSheet(f), null, 1)}`,
    release ? `RELEASE (the company's own results release):\n${release}` : "RELEASE: none",
    `Return JSON with exactly these keys:\n${JSON.stringify(schema, null, 1)}`,
  ].join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Accepts what passes the checks and fills the rest from code. Never throws:
 * an unparseable reply is the same as no reply.
 */
export function acceptCopy(raw: string | null, f: ArticleFacts, release: string | null): ArticleCopy {
  const base = fallbackCopy(f);
  let parsed: Record<string, unknown> | null = null;
  try {
    const s = raw ? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1) : "";
    parsed = s ? (JSON.parse(s) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) return base;

  const facts = tokenSet(factSheet(f));
  const names = [f.company, f.shortName];
  const fromModel: string[] = [];

  // Release sections first: their accepted evidence widens what the headline copy may cite.
  const sections: ReleaseSection[] = [];
  const evidenceTokens = new Set<string>();
  const releaseNorm = release ? normalizeText(release) : "";
  if (release && Array.isArray(parsed.sections)) {
    for (const sec of parsed.sections.slice(0, 3) as Array<Record<string, unknown>>) {
      const title = cleanText(sec?.title, 60, names);
      if (!title || /\d/.test(title) || !Array.isArray(sec.bullets)) continue;
      const bullets: Bullet[] = [];
      for (const b of sec.bullets.slice(0, 4) as Array<Record<string, unknown>>) {
        const label = cleanText(b?.label, 40, names)?.replace(/\.$/, "");
        const text = cleanText(b?.text, 360, names);
        const evidence = typeof b?.evidence === "string" ? b.evidence : "";
        if (!label || /\d/.test(label) || !text || words(text) > 60) continue;
        const ev = normalizeText(evidence);
        if (ev.length < 20 || ev.length > 600 || !releaseNorm.includes(ev)) continue;
        const allowed = new Set([...facts, ...numberTokens(evidence)]);
        if (!numbersAllowed(text, allowed)) continue;
        // A release bullet must add something the scorecard does not already say.
        const own = numberTokens(text);
        if (own.length && own.every((t) => facts.has(t))) continue;
        if (!verdictConsistent(text, f) && !/estimate|consensus|expect/i.test(evidence)) continue;
        bullets.push({ label: sentenceCase(label), text: /[.!?]$/.test(text) ? text : `${text}.` });
        numberTokens(text).filter((t) => !facts.has(t)).forEach((t) => evidenceTokens.add(t));
      }
      if (bullets.length) sections.push({ title: sentenceCase(title), bullets });
    }
    if (sections.length) fromModel.push("sections");
  }

  const allowed = new Set([...facts, ...evidenceTokens]);
  // The code-written headline copy is already complete; the model's replaces it
  // only when it adds the release's story (a figure from an accepted bullet).
  const addsStory = (t: string) => numberTokens(t).some((n) => evidenceTokens.has(n));
  const ok = (t: string | null, extra?: (s: string) => boolean): t is string =>
    !!t && numbersAllowed(t, allowed) && verdictConsistent(t, f) && !CAUSAL.test(withoutNames(t, names)) && (!extra || extra(t));

  const title = cleanText(parsed.title, 99, names);
  const dek = cleanText(parsed.dek, 300, names);
  const description = cleanText(parsed.description, 160, names);
  const lede = cleanText(parsed.lede, 600, names);
  const out: ArticleCopy = { ...base, sections, fromModel };
  if (ok(title, (t) => addsStory(t) && titleOk(t, f, sections) && t.toLowerCase().startsWith(f.shortName.toLowerCase().split(" ")[0]))) {
    out.title = title;
    fromModel.push("title");
  }
  if (ok(dek, (t) => addsStory(t) && t.split(/[.!?](\s|$)/).filter((x) => x && x.trim()).length <= 2)) {
    out.dek = dek;
    fromModel.push("dek");
  }
  if (ok(description, (t) => addsStory(t) && t.length >= 138 && t.length <= 160)) {
    out.description = description;
    fromModel.push("description");
  }
  if (
    ok(lede, (t) =>
      addsStory(t) &&
      t.includes(`(${f.symbol})`) &&
      words(t) <= 60 &&
      t.includes(epsText(f, f.eps.actual)) &&
      (t.includes(revText(f, f.revenue.actual, true)) || t.includes(revText(f, f.revenue.actual))),
    )
  ) {
    out.lede = lede;
    fromModel.push("lede");
  }
  if (Array.isArray(parsed.watch)) {
    const watch: Bullet[] = [];
    for (const b of parsed.watch.slice(0, 3) as Array<Record<string, unknown>>) {
      const label = cleanText(b?.label, 40, names)?.replace(/\.$/, "");
      const text = cleanText(b?.text, 300, names);
      if (label && !/\d/.test(label) && ok(text ?? null) && words(text!) <= 45) {
        watch.push({ label: sentenceCase(label), text: /[.!?]$/.test(text!) ? text! : `${text}.` });
      }
    }
    if (watch.length === 3) {
      out.watch = watch;
      fromModel.push("watch");
    }
  }
  return out;
}
