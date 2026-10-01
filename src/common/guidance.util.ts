/**
 * Reads company guidance out of an earnings press release (8-K exhibit 99.x).
 *
 * WHY THIS IS DERIVED RATHER THAN READ FROM A VENDOR
 * No configured vendor supplies guidance. Polygon has no feed for it, and FMP's
 * analyst-estimates are *consensus*, not company guidance — labelling those as
 * guidance would be wrong. The company's own words in the 8-K press release are
 * the primary source, and SEC EDGAR serves them free.
 *
 * Deriving it from NEWS HEADLINES was measured and rejected: across a month of
 * the `news` collection only 22 of 7,450 articles matched a guidance pattern,
 * and most were misattributed — Polygon tags an article with every ticker it
 * mentions, so "Energy Transfer Just Raised Its 2026 Guidance" arrived tagged
 * META. Filing text has no such attribution problem.
 *
 * Measured on 50 recent earnings 8-Ks: 90% mention guidance, 46% state a
 * direction in words, 50% carry a numeric range. The gap between those last two
 * is companies that publish a new range without saying which way it moved —
 * `range` is captured so direction can later be derived by diffing consecutive
 * quarters. That is why a release with no direction still returns `mentioned`
 * and `range` rather than nothing.
 */

export type GuidanceDirection =
  | "raised"
  | "cut"
  | "mixed"
  | "reaffirmed"
  | null;

export interface GuidanceRead {
  /** The release talks about forward guidance at all. */
  mentioned: boolean;
  /** Direction stated IN WORDS. Null when the release only restates a range. */
  direction: GuidanceDirection;
  /** The sentence the verdict came from, so a human can audit the call. */
  snippet: string | null;
  /** Raw numeric range as written, e.g. "$4.10 to $4.30". Null when absent. */
  range: string | null;
}

/**
 * PRECISION NOTE — why these are tight, verb-governs-noun patterns.
 *
 * A first pass used loose proximity (`verb [^.]{0,70} guidance`). Measured on
 * 50 live filings it produced ~70% precision: Cisco read "raised" off "GAAP EPS
 * increased 31% year over year", Simon Property off its TABLE OF CONTENTS, and
 * Marathon off a capex line ("Garyville Jet Flexibility Increasing"). Stripped
 * filing HTML has no usable sentence structure once whitespace is collapsed, so
 * a 70-character window happily bridges unrelated fragments.
 *
 * These require the direction verb to actually GOVERN the guidance noun — at
 * most five intervening words ("raise our 2026 AFFO per share guidance") — and
 * matching runs per sentence rather than across the whole blob.
 */
const RAISE =
  /\b(?:rais|increas|boost|lift|hik)\w*\s+(?:[\w$%.,'-]+\s+){0,5}?(?:guidance|outlook|forecast)\b/i;
const RAISE_PASSIVE =
  /\b(?:guidance|outlook|forecast)\b[^.]{0,40}?\b(?:was|were|is|has been|have been|to be)\s+(?:raised|increased|boosted|lifted|hiked)\b/i;
// `withdrew` is irregular — withdraw\w* misses it.
const CUT =
  /\b(?:lower|cut|reduc|trim|slash|withdraw|withdrew|suspend)\w*\s+(?:[\w$%.,'-]+\s+){0,5}?(?:guidance|outlook|forecast)\b/i;
const CUT_PASSIVE =
  /\b(?:guidance|outlook|forecast)\b[^.]{0,40}?\b(?:was|were|is|has been|have been|to be)\s+(?:lowered|cut|reduced|trimmed|slashed|withdrawn|suspended)\b/i;
const REAFFIRM =
  /\b(?:reaffirm|reiterat|maintain|confirm)\w*\s+(?:[\w$%.,'-]+\s+){0,5}?(?:guidance|outlook|forecast)\b/i;

const MENTION = /\b(?:guidance|outlook)\b/i;
/**
 * Safe-harbor boilerplate. Every release carries a forward-looking-statements
 * paragraph that discusses guidance being lowered or withdrawn as a RISK, not
 * as something that happened — Helmerich & Payne read as "cut" purely off
 * "All statements other than statements of historical facts...". These
 * sentences are dropped before any direction matching.
 */
const BOILERPLATE =
  /forward[- ]looking statement|private securities litigation reform act|risks? and uncertaint|statements? other than statements? of historical fact|safe harbo|undue reliance|actual results (?:may|could|might) differ/i;
/**
 * EDGAR renders each exhibit with a document header ("EX-99.1 2 rel.htm EX-99.1
 * Document Exhibit 99.1") ahead of the real text. Left in place it pollutes the
 * title window and every snippet.
 */
const EDGAR_CHROME =
  /^\s*EX-[\d.]+\s+\d+\s+\S+\.(?:htm|html|txt)\s+EX-[\d.]+\s+Document\s*(?:Exhibit\s+[\d.]+)?\s*/i;
const NOW_EXPECTS =
  /\b(?:now expects|continues to expect|expects (?:full[- ]year|fiscal)|for (?:the )?(?:full[- ]year|fiscal year) 20\d\d)/i;
// The decimal part is explicit rather than a loose [\d.,]*, which would swallow
// the sentence-ending period ("$7.10 to $7.30." -> a range with a dot).
// Bare "and" is NOT a separator: "$145 and $137" in a results table is two
// unrelated figures, not a range. It only counts after "between"/"of".
const RANGE =
  /(?:between\s+)?\$\s?(\d[\d,]*(?:\.\d+)?)\s*(?:to|through|-|–|—|and)\s*\$?\s?(\d[\d,]*(?:\.\d+)?)/i;

/** A range must ascend. Rejects "$145 and $137" and other coincidental pairs. */
function validRange(m: RegExpExecArray | null): string | null {
  if (!m) return null;
  const lo = Number(m[1].replace(/,/g, ""));
  const hi = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null;
  // "and" without a leading "between" joins unrelated figures far more often
  // than it delimits a range.
  if (/\band\b/i.test(m[0]) && !/^between/i.test(m[0].trim())) return null;
  return m[0].replace(/\s+/g, " ").replace(/[,;.]+$/, "").trim();
}

/** The pattern that fired, so the snippet can be anchored to its position. */
function firstMatch(s: string, res: RegExp[]): RegExp | null {
  for (const re of res) if (re.test(s)) return re;
  return null;
}
const raiseHit = (s: string) => firstMatch(s, [RAISE, RAISE_PASSIVE]);
const cutHit = (s: string) => firstMatch(s, [CUT, CUT_PASSIVE]);

/**
 * A tight window around the ACTUAL match rather than the enclosing chunk.
 *
 * Simon Property files a large supplemental deck whose opening pages are a
 * table of contents with almost no sentence punctuation, so the chunk holding
 * the match began mid-TOC and the stored snippet read "Guidance Reconciliation
 * ... 2Q 2026 SUPPLEMENTAL" — a correct verdict with a useless audit trail.
 * Anchoring to match.index yields the real sentence wherever it sits.
 */
function snippetAround(hay: string, re: RegExp): string {
  const m = re.exec(hay);
  if (!m) return hay.slice(0, 220).trim();
  const start = Math.max(0, m.index - 70);
  const end = Math.min(hay.length, m.index + m[0].length + 110);
  return `${start > 0 ? "…" : ""}${hay.slice(start, end).trim()}${end < hay.length ? "…" : ""}`;
}

/**
 * Sentence split on terminal punctuation followed by a capital. Filing text is
 * one long run-on after HTML stripping, so this is what keeps a match inside a
 * single statement instead of bridging two unrelated ones.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'(])/)
    .flatMap((s) => (s.length > 600 ? s.match(/.{1,600}/g) ?? [s] : [s]))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param text plain text of the press release (HTML already stripped).
 */
export function readGuidance(text: string | null | undefined): GuidanceRead {
  const empty: GuidanceRead = {
    mentioned: false, direction: null, snippet: null, range: null,
  };
  if (!text || !text.trim()) return empty;
  const t = text.replace(/\s+/g, " ").trim().replace(EDGAR_CHROME, "");
  if (!MENTION.test(t) && !NOW_EXPECTS.test(t)) return empty;

  // The release TITLE is the single highest-precision signal: companies say it
  // outright ("...Reports Q2 Results and Raises Full-Year Guidance"). Check it
  // first so a clear headline wins over anything buried in the tables below.
  // The title window gets the same boilerplate guard as the sentences: a short
  // release can put the safe-harbor paragraph inside the first 300 characters.
  const titleRaw = t.slice(0, 300);
  const title = BOILERPLATE.test(titleRaw) ? "" : titleRaw;
  const guidanceSentences = sentences(t).filter(
    (s) => (MENTION.test(s) || NOW_EXPECTS.test(s)) && !BOILERPLATE.test(s),
  );
  const pool = [title, ...guidanceSentences];

  let direction: GuidanceDirection = null;
  let snippet: string | null = null;
  let up = false, down = false, reaff: string | null = null;

  for (const s of pool) {
    const u = raiseHit(s), d = cutHit(s);
    if (u && !up) { up = true; snippet ??= snippetAround(s, u); }
    if (d && !down) { down = true; if (!up) snippet ??= snippetAround(s, d); }
    if (!u && !d && !reaff && REAFFIRM.test(s)) reaff = snippetAround(s, REAFFIRM);
    // A clear title verdict is enough; no need to scan the tables.
    if (s === title && (u || d)) break;
  }

  if (up && down) direction = "mixed";
  else if (up) direction = "raised";
  else if (down) direction = "cut";
  else if (reaff) { direction = "reaffirmed"; snippet = reaff; }

  // Prefer a range in a sentence that actually talks about guidance, rather
  // than the first dollar figure in the document (usually an income-statement
  // line). Falls back to the guidance-mentioning sentences in order.
  // Real sentences only — NOT the 300-char title slice, which can straddle a
  // sentence boundary and pick up an income-statement figure from before it.
  let range: string | null = null;
  for (const s of guidanceSentences) {
    const v = validRange(RANGE.exec(s));
    if (v) { range = v; break; }
  }

  return {
    mentioned: true,
    direction,
    snippet: snippet ? (snippet.length > 320 ? `${snippet.slice(0, 317)}…` : snippet) : null,
    range,
  };
}
