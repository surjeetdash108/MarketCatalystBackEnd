import { readGuidance } from "./guidance.util";

describe("readGuidance", () => {
  it("returns empty on null/blank input", () => {
    for (const v of [null, undefined, "", "   "]) {
      expect(readGuidance(v as string)).toEqual({
        mentioned: false, direction: null, snippet: null, range: null,
      });
    }
  });

  it("ignores a release that never mentions guidance", () => {
    const r = readGuidance("Revenue rose 8% to $4.2 billion. Net income was $500 million.");
    expect(r.mentioned).toBe(false);
    expect(r.direction).toBeNull();
  });

  it("detects a raise, verb first", () => {
    const r = readGuidance("The Company raises its full-year 2026 guidance to reflect strong demand.");
    expect(r.direction).toBe("raised");
    expect(r.snippet).toContain("raises");
  });

  it("detects a raise, noun first", () => {
    expect(readGuidance("Full-year guidance was increased following the quarter.").direction).toBe("raised");
  });

  it("detects a cut", () => {
    expect(readGuidance("Management lowered its full-year outlook on softer volumes.").direction).toBe("cut");
  });

  it("detects a withdrawal as a cut", () => {
    expect(readGuidance("The Company withdrew its fiscal 2026 guidance amid uncertainty.").direction).toBe("cut");
  });

  it("detects reaffirmation", () => {
    expect(readGuidance("The Company reaffirms its previously issued full-year guidance.").direction).toBe("reaffirmed");
  });

  it("reports mixed when both directions appear", () => {
    const r = readGuidance("We raised our revenue guidance and lowered our EPS guidance for the year.");
    expect(r.direction).toBe("mixed");
  });

  it("captures a numeric range near the guidance wording", () => {
    const r = readGuidance("For fiscal 2026 the Company now expects guidance of $4.10 to $4.30 per share.");
    expect(r.range).toBe("$4.10 to $4.30");
  });

  it("prefers the range near guidance over an earlier income-statement figure", () => {
    const r = readGuidance(
      "Revenue of $1.00 to $2.00 billion was reported last year. " +
      "Separately, full-year guidance is now $4.10 to $4.30 per share.",
    );
    expect(r.range).toBe("$4.10 to $4.30");
  });

  it("still reports mentioned + range when no direction verb is present", () => {
    // ~44% of real releases look like this — the range is what later lets
    // direction be derived by diffing consecutive quarters.
    const r = readGuidance("For full-year 2026, the Company expects adjusted EPS of $7.10 to $7.30.");
    expect(r.mentioned).toBe(true);
    expect(r.direction).toBeNull();
    expect(r.range).toBe("$7.10 to $7.30");
  });

  it("survives newline-heavy stripped filing HTML", () => {
    const r = readGuidance("The Company\n\n   raises   its\nfull-year\n\nguidance.");
    expect(r.direction).toBe("raised");
  });

  it("ignores safe-harbor boilerplate discussing guidance as a risk", () => {
    // Real Helmerich & Payne failure: this paragraph made the release read "cut".
    const r = readGuidance(
      "The Company reported strong results. All statements other than statements " +
      "of historical facts are forward-looking statements, including whether we " +
      "may be required to reduce our guidance for the year.",
    );
    expect(r.direction).toBeNull();
  });

  it("strips the EDGAR exhibit document header", () => {
    const r = readGuidance(
      "EX-99.1 2 earningsrelease.htm EX-99.1 Document Exhibit 99.1 " +
      "Acme raises full-year guidance.",
    );
    expect(r.direction).toBe("raised");
    expect(r.snippet).not.toContain("EX-99.1");
  });

  it("caps an over-long snippet", () => {
    const r = readGuidance(`The Company raises guidance ${"x".repeat(900)}`);
    expect(r.snippet!.length).toBeLessThanOrEqual(320);
  });
});

describe("readGuidance range validity", () => {
  it("rejects a descending pair joined by 'and' (real BKNG case)", () => {
    // "$145 and $137" came from a results table, not a guidance range.
    const r = readGuidance("Full-year outlook discussion. Revenue per share of $145 and $137, respectively.");
    expect(r.range).toBeNull();
  });
  it("accepts 'between X and Y'", () => {
    const r = readGuidance("The Company expects full-year guidance between $4.10 and $4.30.");
    expect(r.range).toBe("between $4.10 and $4.30");
  });
  it("rejects a descending 'to' range", () => {
    expect(readGuidance("Guidance of $9.00 to $2.00 is nonsense.").range).toBeNull();
  });
  it("trims trailing punctuation from a range", () => {
    expect(readGuidance("Outlook is $1.10 to $1.20, up sharply.").range).toBe("$1.10 to $1.20");
  });
});

describe("readGuidance snippet anchoring", () => {
  it("anchors the snippet to the match, not the table of contents (real SPG case)", () => {
    const toc = "TABLE OF CONTENTS Financial Information 39 - 42 Guidance Reconciliation 43 ";
    const real = "Simon Reports Second Quarter Results and Increases Guidance for Full Year 2026 Real Estate FFO";
    const r = readGuidance(toc + real + " More filler text follows here.");
    expect(r.direction).toBe("raised");
    expect(r.snippet).toContain("Increases Guidance");
    expect(r.snippet).not.toContain("TABLE OF CONTENTS");
  });
});
