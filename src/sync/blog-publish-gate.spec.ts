import { figureReasons, notCommonStock, textReasons } from "./blog-publish-gate";

describe("blog publish gate", () => {
  it("B-21: placeholders and model notes hold a post", () => {
    expect(textReasons("<p>[Optional note: VNQ, UUP… could not be independently verified for this session.]</p>")).toHaveLength(2);
    expect(textReasons("<p>[LEGAL REVIEW PLACEHOLDER]</p>")).toEqual(["Contains a placeholder"]);
    expect(textReasons("<style>.x{}</style><p>Revenue rose 5%.</p>")).toEqual([]);
  });
  it("B-19: implausible scorecard figures hold a post", () => {
    // AECOM: $3.90B vs a $1.92B 'estimate' (net service revenue).
    expect(figureReasons({ revenueActual: 3.9e9, revenueEstimate: 1.92e9, revenueYoyPct: 2, epsActual: 1.3, epsEstimate: 1.27 })).toHaveLength(1);
    // Shift4: revenue 'down 100%'.
    expect(figureReasons({ revenueActual: 1.3e6, revenueEstimate: 652.4e6, revenueYoyPct: -100, epsActual: null, epsEstimate: null })).toHaveLength(2);
    // A normal quarter passes.
    expect(figureReasons({ revenueActual: 9.1e9, revenueEstimate: 8.9e9, revenueYoyPct: 6.6, epsActual: 1.81, epsEstimate: 1.75 })).toEqual([]);
  });
  it("B-05: warrants, units and notes are not the company's common stock", () => {
    expect(notCommonStock("DAVEW", "Dave")).toBe(true);
    expect(notCommonStock("VSECU", "VSE")).toBe(true);
    expect(notCommonStock("SCCF", "Sachem Capital Corp. 7.125% Not")).toBe(true);
    expect(notCommonStock("DUKB", "Duke Energy Corporation 5.625%")).toBe(true);
    expect(notCommonStock("DAVE", "Dave Inc.")).toBe(false);
    expect(notCommonStock("GOOGL", "Alphabet Inc.")).toBe(false);
  });
});

describe("recap direction check (B-22)", () => {
  const { directionReasons } = jest.requireActual("./blog-publish-gate");
  it("holds a 'market climbs' headline when the S&P 500 fell", () => {
    expect(directionReasons("Broad market climbs on a strong Dow", -0.48)).toHaveLength(1);
  });
  it("lets mixed wording and small moves through", () => {
    expect(directionReasons("Dow climbs while the Nasdaq tumbles", -0.48)).toEqual([]);
    expect(directionReasons("Stocks edge higher", 0.1)).toEqual([]);
    expect(directionReasons("Stocks rally into the close", 0.9)).toEqual([]);
  });

  it("holds a large company's double-digit revenue surprise as a likely basis mismatch (Deere)", () => {
    const r = figureReasons({ revenueActual: 12.115e9, revenueEstimate: 10.38e9, revenueYoyPct: 0.2, epsActual: 3.89, epsEstimate: 4.03 });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/another basis/);
    expect(figureReasons({ revenueActual: 12.115e9, revenueEstimate: 11.5e9, revenueYoyPct: 0.2, epsActual: 3.89, epsEstimate: 4.03 })).toEqual([]);
    // A small company's 17% beat is not flagged by this rule.
    expect(figureReasons({ revenueActual: 117e6, revenueEstimate: 100e6, revenueYoyPct: 5, epsActual: 0.1, epsEstimate: 0.09 })).toEqual([]);
  });

  it("holds revenue up more than 80% year over year", () => {
    expect(figureReasons({ revenueActual: 1.9e8, revenueEstimate: 1.9e8, revenueYoyPct: 85, epsActual: null, epsEstimate: null })).toHaveLength(1);
    expect(figureReasons({ revenueActual: 1.9e8, revenueEstimate: 1.9e8, revenueYoyPct: 75, epsActual: null, epsEstimate: null })).toEqual([]);
  });
});
