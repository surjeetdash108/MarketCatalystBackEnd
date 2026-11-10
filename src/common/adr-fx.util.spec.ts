import {
  parseAdrRatio,
  getFxRateToUsd,
  convertEpsToUsdPerAdr,
  convertFinancialStatementToUsd,
} from "./adr-fx.util";

describe("adr-fx.util", () => {
  describe("parseAdrRatio", () => {
    it("parses fractional words e.g. 'one-fifth' -> 0.2 (MFG)", () => {
      const name =
        "American Depositary Shares (Each representing one-fifth of an Ordinary Share)";
      expect(parseAdrRatio(name)).toBeCloseTo(0.2, 4);
    });

    it("parses fraction numbers e.g. '1/5' -> 0.2", () => {
      const name = "Mizuho Financial Group Inc ADR (1/5 ordinary share)";
      expect(parseAdrRatio(name)).toBeCloseTo(0.2, 4);
    });

    it("parses multiple ordinary shares e.g. 'representing 2 ordinary shares' -> 2", () => {
      const name = "Company ADR representing 2 ordinary shares";
      expect(parseAdrRatio(name)).toBe(2);
    });

    it("parses words e.g. 'representing ten ordinary shares' -> 10", () => {
      const name = "Company ADR (representing ten ordinary shares)";
      expect(parseAdrRatio(name)).toBe(10);
    });

    it("defaults to 1.0 when not an ADR or no ratio specified", () => {
      expect(parseAdrRatio("Apple Inc.")).toBe(1.0);
      expect(parseAdrRatio(null)).toBe(1.0);
    });
  });

  describe("getFxRateToUsd", () => {
    it("returns 1.0 for USD", () => {
      expect(getFxRateToUsd("USD")).toBe(1.0);
    });

    it("returns positive rate for foreign currencies (JPY, EUR, GBP, TWD)", () => {
      const jpy = getFxRateToUsd("JPY");
      expect(jpy).toBeGreaterThan(0);
      expect(jpy).toBeLessThan(0.02); // ~0.0064 USD per JPY

      const eur = getFxRateToUsd("EUR");
      expect(eur).toBeGreaterThan(1.0);

      const twd = getFxRateToUsd("TWD");
      expect(twd).toBeGreaterThan(0.02);
      expect(twd).toBeLessThan(0.05);
    });
  });

  describe("convertEpsToUsdPerAdr", () => {
    it("converts MFG reported JPY 113.87 EPS with 0.2 ADR ratio to realistic USD EPS", () => {
      // Reported JPY EPS: 113.87
      // ADR ratio: 0.2 (1 ADR = 1/5 ordinary share)
      // JPY/USD rate: ~156.8 (USD per JPY: ~0.006377)
      // Expected USD EPS: 113.87 * 0.2 / 156.8 ≈ 0.145 USD
      const usdEps = convertEpsToUsdPerAdr({
        reportedEps: 113.87,
        currency: "JPY",
        adrRatio: 0.2,
      });
      expect(usdEps).toBeGreaterThan(0.13);
      expect(usdEps).toBeLessThan(0.16);
    });

    it("leaves USD common stock unchanged", () => {
      expect(
        convertEpsToUsdPerAdr({
          reportedEps: 3.5,
          currency: "USD",
          adrRatio: 1.0,
        }),
      ).toBe(3.5);
    });
  });

  describe("convertFinancialStatementToUsd", () => {
    it("converts total statement lines by FX and per-share by FX * ADR ratio", () => {
      const jpyStatement = {
        fiscalYear: "2026",
        fiscalPeriod: "Q1",
        endDate: "2026-06-30",
        filingDate: "2026-08-14",
        income: {
          revenues: 1_500_000_000_000, // 1.5 trillion JPY ≈ 9.56 billion USD
          net_income: 200_000_000_000,
          diluted_earnings_per_share: 113.87,
        },
        balanceSheet: {
          total_assets: 250_000_000_000_000,
          total_debt: 10_000_000_000_000,
        },
        cashFlow: {
          free_cash_flow: 50_000_000_000,
        },
      };

      const converted = convertFinancialStatementToUsd({
        statement: jpyStatement,
        currency: "JPY",
        adrRatio: 0.2,
      });

      // Revenues converted to USD (~$9.56B, definitely > 0 and in billions not trillions)
      expect(converted.income.revenues).toBeGreaterThan(5e9);
      expect(converted.income.revenues).toBeLessThan(15e9);

      // EPS converted to USD per ADR (~$0.145)
      expect(converted.income.diluted_earnings_per_share).toBeGreaterThan(0.13);
      expect(converted.income.diluted_earnings_per_share).toBeLessThan(0.16);
    });
  });
});
