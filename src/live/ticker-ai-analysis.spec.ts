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

/**
 * The scheduling rule that decides which tickers get analysed each cycle.
 * Pure comparator, extracted here because the bug it fixes was invisible in
 * types and only showed up as 369 tickers never being analysed.
 */
function rank(
  entries: Array<[string, { n: number }]>,
  lastUpdated: Map<string, string>,
  take: number,
): string[] {
  return entries
    .map(([ticker, v]) => ({ ticker, v, last: lastUpdated.get(ticker) ?? null }))
    .sort((a, b) => {
      if (!a.last && b.last) return -1;
      if (a.last && !b.last) return 1;
      if (a.last && b.last && a.last !== b.last) return a.last < b.last ? -1 : 1;
      return b.v.n - a.v.n;
    })
    .slice(0, take)
    .map((r) => r.ticker);
}

describe("ticker analysis scheduling", () => {
  const entries: Array<[string, { n: number }]> = [
    ["NVDA", { n: 20 }],  // busiest, already analysed
    ["PDD",  { n: 1 }],   // quiet, never analysed
    ["AAPL", { n: 15 }],  // busy, analysed a while ago
  ];

  it("puts never-analysed tickers ahead of busy ones", () => {
    const last = new Map([["NVDA", "2026-08-24T10:00:00Z"], ["AAPL", "2026-08-24T09:00:00Z"]]);
    // The old rule took NVDA+AAPL by volume and PDD never ran.
    expect(rank(entries, last, 1)).toEqual(["PDD"]);
  });

  it("then prefers the least recently updated", () => {
    const last = new Map([
      ["NVDA", "2026-08-24T10:00:00Z"],
      ["AAPL", "2026-08-24T09:00:00Z"],
      ["PDD",  "2026-08-24T11:00:00Z"],
    ]);
    expect(rank(entries, last, 2)).toEqual(["AAPL", "NVDA"]);
  });

  it("uses article count only to break ties", () => {
    const same = "2026-08-24T10:00:00Z";
    const last = new Map([["NVDA", same], ["AAPL", same], ["PDD", same]]);
    expect(rank(entries, last, 2)).toEqual(["NVDA", "AAPL"]);
  });

  it("covers every ticker over successive cycles instead of starving the tail", () => {
    const all: Array<[string, { n: number }]> =
      Array.from({ length: 30 }, (_, i) => [`T${i}`, { n: i }]);
    const last = new Map<string, string>();
    let clock = 0;
    for (let cycle = 0; cycle < 10; cycle++) {
      for (const t of rank(all, last, 3)) {
        last.set(t, new Date(Date.UTC(2026, 7, 24, 0, clock++)).toISOString());
      }
    }
    // 10 cycles x 3 = 30 slots, and fairness means 30 DISTINCT tickers.
    expect(last.size).toBe(30);
  });
});

import { TickerAiAnalysisService } from "./ticker-ai-analysis.service";
import { analysisDocId, GENERAL_TTL_MS } from "./ticker-ai-analysis.types";

describe("general analysis freshness (1-hour TTL)", () => {
  const at = (ms: number) =>
    ({ lastUpdatedAt: new Date(Date.now() - ms).toISOString() }) as never;

  it("serves the stored read inside the window", () => {
    expect(TickerAiAnalysisService.isFresh(at(5 * 60_000))).toBe(true);
    expect(TickerAiAnalysisService.isFresh(at(59 * 60_000))).toBe(true);
  });
  it("regenerates once the window has passed", () => {
    expect(TickerAiAnalysisService.isFresh(at(GENERAL_TTL_MS + 1000))).toBe(false);
    expect(TickerAiAnalysisService.isFresh(at(3 * 60 * 60_000))).toBe(false);
  });
  it("treats a missing or malformed record as stale", () => {
    expect(TickerAiAnalysisService.isFresh(null)).toBe(false);
    expect(TickerAiAnalysisService.isFresh({ lastUpdatedAt: "nonsense" } as never)).toBe(false);
  });
});

describe("append-only record ids", () => {
  it("separates the two analysis types for one ticker", () => {
    const t = "2026-08-26T20:15:30.123Z";
    expect(analysisDocId("NVDA", "general", t)).not.toBe(
      analysisDocId("NVDA", "announcement", t),
    );
  });
  it("gives each generation its own id so history accumulates", () => {
    const a = analysisDocId("NVDA", "general", "2026-08-26T20:15:30.000Z");
    const b = analysisDocId("NVDA", "general", "2026-08-26T21:15:30.000Z");
    expect(a).not.toBe(b);
  });
  it("produces ids that sort chronologically", () => {
    const a = analysisDocId("NVDA", "general", "2026-08-26T09:00:00.000Z");
    const b = analysisDocId("NVDA", "general", "2026-08-26T21:00:00.000Z");
    expect([b, a].sort()).toEqual([a, b]);
  });
});
