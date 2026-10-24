import { fmpInsiderRows, form4InsiderRows, isDerivativeSecurity, plausiblePrice } from "./insider-rows.util";

describe("insider rows", () => {
  const fmpRow = (over: Record<string, unknown> = {}) => ({
    symbol: "STRL",
    filingDate: "2026-09-23",
    transactionDate: "2026-09-21",
    reportingCik: "0001671928",
    transactionType: "G-Gift",
    securitiesOwned: 290593,
    reportingName: "CUTILLO JOSEPH A",
    typeOfOwner: "director, officer: Chief Executive Officer",
    acquisitionOrDisposition: "D",
    securitiesTransacted: 40000,
    price: 0,
    url: "https://www.sec.gov/Archives/edgar/data/874238/x-index.htm",
    ...over,
  });

  it("maps FMP rows onto the insider_transactions shape", () => {
    const [r] = fmpInsiderRows("STRL", [fmpRow()]);
    expect(r).toMatchObject({
      ticker: "STRL",
      ownerName: "CUTILLO JOSEPH A",
      isOfficer: true,
      officerTitle: "Chief Executive Officer",
      transactionDate: "2026-09-21",
      transactionCode: "G",
      acquiredOrDisposed: "D",
      shares: 40000,
      pricePerShare: null, // $0 gift — no fabricated dollar value
      sharesOwnedAfter: 290593,
      filingDate: "2026-09-23",
      url: "https://www.sec.gov/Archives/edgar/data/874238/x-index.htm",
      vendor: "fmp",
    });
  });

  it("keeps the caller's ticker, else converts FMP's class-share symbol (BRK-B → BRK.B)", () => {
    expect(fmpInsiderRows("BRK.B", [fmpRow({ symbol: "BRK-B" })])[0].ticker).toBe("BRK.B");
    expect(fmpInsiderRows("", [fmpRow({ symbol: "BRK-B" })])[0].ticker).toBe("BRK.B");
    expect(fmpInsiderRows("", [fmpRow({ symbol: "aapl" })])[0].ticker).toBe("AAPL");
  });

  it("labels non-officer roles and drops Form 3 holding statements", () => {
    const rows = fmpInsiderRows("STRL", [
      fmpRow({ typeOfOwner: "director", transactionType: "A-Award", acquisitionOrDisposition: "A", price: 0 }),
      fmpRow({ typeOfOwner: "10 percent owner", transactionType: "S-Sale", price: 888 }),
      fmpRow({ securitiesTransacted: 0, transactionType: "" }), // Form 3: a position, not a trade
      fmpRow({ transactionDate: "" }),
    ]);
    expect(rows.map((r) => [r.officerTitle, r.isOfficer, r.transactionCode, r.pricePerShare])).toEqual([
      ["Director", false, "A", null],
      ["10% owner", false, "S", 888],
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  it("keeps only plausible per-share prices", () => {
    expect(plausiblePrice("536.08")).toBe(536.08);
    expect([0, -1, "", null, "x", 2_110_482].map((v) => plausiblePrice(v))).toEqual([null, null, null, null, null, null]);
  });

  it("maps a parsed SEC Form 4 the way the nightly job always stored it", () => {
    const rows = form4InsiderRows("STRL", "0001-26-000123", "2026-10-07", {
      issuer: { ticker: "STRL", name: "Sterling Infrastructure" },
      owner: { name: "Hargis Katherine", isOfficer: true, officerTitle: "General Counsel" },
      transactions: [{
        transactionDate: { value: "2026-10-05" },
        transactionCoding: { transactionCode: "A" },
        transactionAmounts: {
          transactionShares: { value: "1000" },
          transactionPricePerShare: { value: "0" },
          transactionAcquiredDisposedCode: { value: "A" },
        },
        postTransactionAmounts: { sharesOwnedFollowingTransaction: { value: "1000" } },
      }],
    });
    expect(rows).toEqual([{
      id: "0001-26-000123_0",
      ticker: "STRL",
      issuerName: "Sterling Infrastructure",
      ownerName: "Hargis Katherine",
      isOfficer: true,
      officerTitle: "General Counsel",
      transactionDate: "2026-10-05",
      transactionCode: "A",
      acquiredOrDisposed: "A",
      shares: 1000,
      pricePerShare: null,
      sharesOwnedAfter: 1000,
      filingDate: "2026-10-07",
      vendor: "sec",
    }]);
  });
});

describe("isDerivativeSecurity / Form 4 Table I only (E2E Oct 2026, category H)", () => {
  it("treats options, SARs, RSUs/PSUs and deferred units as derivative", () => {
    for (const n of ["Employee Stock Option (Right to buy)", "Stock Options (right to buy)", "Share Appreciation Right",
      "Restricted Share Unit", "Performance Share Units", "Performance Stock Unit", "Deferred Stock Units", "Warrants"]) {
      expect(isDerivativeSecurity(n)).toBe(true);
    }
  });
  it("keeps the common stock itself, including class shares and MLP common units", () => {
    for (const n of ["Common Stock", "Class A Common Stock", "Common Sotck", "Common Units", "Ordinary Shares", "Restricted Stock", ""]) {
      expect(isDerivativeSecurity(n)).toBe(false);
    }
  });
  it("shows the stock award, not the option grant beside it (BGS)", () => {
    const base = { transactionDate: "2026-08-10", filingDate: "2026-08-12", transactionType: "A-Award", acquisitionOrDisposition: "A", reportingName: "Mills Robert D" };
    const rows = fmpInsiderRows("BGS", [
      { ...base, securitiesTransacted: 900000, price: 3.4, securityName: "Employee Stock Option (Right t" },
      { ...base, securitiesTransacted: 134408, price: 0, securityName: "Common Stock" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shares: 134408, pricePerShare: null, transactionCode: "A" });
  });
});
