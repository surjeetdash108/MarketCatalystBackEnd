/**
 * What kind of economic-calendar event this is, from its name.
 *
 * The vendors (FMP, FRED) send speeches, minutes and data releases in one list
 * with no type field. Speeches and reports never carry previous/estimate/actual
 * figures, while a data release can be missing them only because it has not
 * been published yet (or the vendor gave no consensus). The calendar pop-up
 * needs to tell those apart (QA row 185), so the API labels each event here.
 */
export type MacroEventKind = "speech" | "report" | "data";

const SPEECH_RE = /\b(speech|speaks|remarks|testimony|hearing|press conference)\b/i;
const REPORT_RE = /\b(minutes|beige book|monetary policy report)\b/i;

export function macroEventKind(name: string | null | undefined): MacroEventKind {
  const n = name ?? "";
  if (SPEECH_RE.test(n)) return "speech";
  if (REPORT_RE.test(n)) return "report";
  return "data";
}
