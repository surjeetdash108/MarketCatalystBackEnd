import { coerceBody, extractJson } from "./ticker-ai-analysis.service";
import { buildCreatePrompt, buildUpdatePrompt } from "./ticker-ai-analysis.prompt";
import type { AnalysisBody } from "./ticker-ai-analysis.types";

const news = [
  { id: "n1", headline: "Acme beats Q2 estimates", summary: "EPS $1.42 vs $1.28.",
    source: "Reuters", publishedAt: "2026-08-20T12:00:00Z", tag: "earnings" },
];

describe("extractJson", () => {
  it("pulls a fenced object out of a chatty reply", () => {
    const r = extractJson('Sure!\n```json\n{"summary":"ok"}\n```\nHope that helps');
    expect(r).toEqual({ summary: "ok" });
  });
  it("survives braces inside strings", () => {
    expect(extractJson('{"summary":"a } b","sentiment":"positive"}'))
      .toEqual({ summary: "a } b", sentiment: "positive" });
  });
  it("returns null when there is no object", () => {
    expect(extractJson("no json here")).toBeNull();
  });
});

describe("coerceBody", () => {
  it("rejects a reply with neither summary nor assessment", () => {
    expect(coerceBody({ sentiment: "positive" })).toBeNull();
    expect(coerceBody(null)).toBeNull();
  });
  it("clamps confidence into 0-1 and defaults a bad sentiment", () => {
    const b = coerceBody({ summary: "s", confidence: 7, sentiment: "bullish" })!;
    expect(b.confidence).toBe(1);
    expect(b.sentiment).toBe("neutral");
  });
  it("defaults confidence when the model omits it", () => {
    expect(coerceBody({ summary: "s" })!.confidence).toBe(0.5);
  });
  it("coerces array fields and drops blanks", () => {
    const b = coerceBody({ summary: "s", risks: ["a", "", "b"], opportunities: "nope" })!;
    expect(b.risks).toEqual(["a", "b"]);
    expect(b.opportunities).toEqual([]);
  });
  it("keeps 'mixed' as a valid sentiment", () => {
    expect(coerceBody({ summary: "s", sentiment: "mixed" })!.sentiment).toBe("mixed");
  });
});

describe("prompts", () => {
  it("Case 1 asks for a first analysis and carries the news", () => {
    const p = buildCreatePrompt("ACME", "Acme Inc", news);
    expect(p).toContain("ACME");
    expect(p).toContain("beats Q2 estimates");
    expect(p).toContain("first analysis");
    expect(p).not.toContain("PREVIOUS ANALYSIS");
  });

  it("Case 2 supplies the prior analysis and demands reconciliation", () => {
    const prev = {
      summary: "Steady quarter", sentiment: "neutral", overallAssessment: "Hold pattern",
      keyDevelopments: ["prior item"], risks: ["margin"], opportunities: [],
    } as unknown as AnalysisBody;
    const p = buildUpdatePrompt("ACME", "Acme Inc", prev, "2026-08-01T00:00:00Z", news);
    expect(p).toContain("PREVIOUS ANALYSIS");
    expect(p).toContain("Steady quarter");
    // §6: must not be a blind overwrite NOR a concatenation.
    expect(p).toMatch(/do not simply append/i);
    expect(p).toMatch(/reconcile/i);
    expect(p).toMatch(/immaterial/i);
  });
});
