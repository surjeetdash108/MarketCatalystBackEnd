/**
 * Maps an SEC SIC code to the sector vocabulary this app uses everywhere else.
 *
 * WHY THIS EXISTS
 * Polygon/Massive's ticker reference returns `sic_code` + `sic_description`
 * (e.g. 3571 / "ELECTRONIC COMPUTERS") and has no sector field on any plan. The
 * profile adapter previously wrote `sic_description` into BOTH `sector` and
 * `industry`, so `companies.sector` held values like "SURGICAL & MEDICAL
 * INSTRUMENTS & APPARATUS". That broke two things:
 *
 *   1. `tech-rating` groups by `companies.sector` to compute `sectorRank`, so
 *      ranks were computed within an SIC code — a handful of near-identical
 *      companies — instead of a real sector.
 *   2. `companies.sector` could never be joined against the `sectors`
 *      collection, which uses the 11 SPDR sector names.
 *
 * The names below are EXACTLY the keys of SECTOR_ETFS in polygon.service.ts.
 * Keep them in sync or the join silently breaks again.
 *
 * An unmapped code returns null rather than a guess — a wrong sector is worse
 * than a missing one, because it silently pollutes rankings.
 */
export type Sector =
  | "Technology"
  | "Financial Services"
  | "Energy"
  | "Healthcare"
  | "Industrials"
  | "Consumer Defensive"
  | "Consumer Cyclical"
  | "Utilities"
  | "Basic Materials"
  | "Real Estate"
  | "Communication Services"
  // Bitcoin miners / crypto-compute / blockchain-infra names. The vendor dumps
  // them into SIC 6199 "Finance Services", so `sectorFromSic` alone mislabels
  // them Financial Services. Use `resolveSector` (with ticker/description) to
  // land them here instead. NOTE: this is a 12th sector OUTSIDE the 11 SPDR
  // set, so these names have no SPDR sector-performance benchmark to join —
  // correct, since there is no standard crypto sector ETF.
  | "Crypto / Blockchain";

/**
 * Specific 4-digit codes whose major group would otherwise mis-assign them.
 * These matter disproportionately: SIC major group 28 is "Chemicals", but 2834
 * is pharmaceuticals; group 35 is "Industrial Machinery", but 3571 is computers
 * and 3674 is semiconductors. Without these overrides the largest names in the
 * universe land in the wrong sector.
 */
const EXACT: Record<number, Sector> = {
  2833: "Healthcare",
  2834: "Healthcare",
  2835: "Healthcare",
  2836: "Healthcare",
  3571: "Technology",
  3572: "Technology",
  3576: "Technology",
  3577: "Technology",
  3661: "Technology",
  3663: "Technology",
  3669: "Technology",
  3672: "Technology",
  3674: "Technology",
  3675: "Technology",
  3676: "Technology",
  3677: "Technology",
  3678: "Technology",
  3679: "Technology",
  3711: "Consumer Cyclical",
  3713: "Consumer Cyclical",
  3714: "Consumer Cyclical",
  3716: "Consumer Cyclical",
  3751: "Consumer Cyclical",
  3721: "Industrials",
  3724: "Industrials",
  3728: "Industrials",
  3760: "Industrials",
  3812: "Industrials",
  3821: "Healthcare",
  3826: "Healthcare",
  3827: "Healthcare",
  3829: "Healthcare",
  3841: "Healthcare",
  3842: "Healthcare",
  3843: "Healthcare",
  3844: "Healthcare",
  3845: "Healthcare",
  3851: "Healthcare",
  3861: "Technology",
  3873: "Consumer Cyclical",
  5912: "Consumer Defensive",
  // Health insurers / managed care (UnitedHealth, Humana, Centene, Cigna, Molina):
  // SIC 632x sits in the 6000-6499 "Financial Services" range, but GICS/IBD class
  // these as Healthcare. Exact overrides beat the range, so they land correctly.
  6321: "Healthcare", // Accident & health insurance
  6324: "Healthcare", // Hospital & medical service plans
  6798: "Real Estate",
  7812: "Communication Services",
  7819: "Communication Services",
  7822: "Communication Services",
  7829: "Communication Services",
  7841: "Communication Services",
};

/** Inclusive major-group ranges, applied when no exact override matches. */
const RANGES: Array<[number, number, Sector]> = [
  [100, 999, "Consumer Defensive"], // agriculture, livestock
  [1000, 1099, "Basic Materials"], // metal mining
  [1200, 1299, "Energy"], // coal
  [1300, 1399, "Energy"], // oil & gas extraction
  [1400, 1499, "Basic Materials"], // nonmetallic minerals
  [1500, 1799, "Industrials"], // construction
  [2000, 2199, "Consumer Defensive"], // food, tobacco
  [2200, 2399, "Consumer Cyclical"], // textiles, apparel
  [2400, 2499, "Basic Materials"], // lumber
  [2500, 2599, "Consumer Cyclical"], // furniture
  [2600, 2699, "Basic Materials"], // paper
  [2700, 2799, "Communication Services"], // printing & publishing
  [2800, 2899, "Basic Materials"], // chemicals (pharma overridden above)
  [2900, 2999, "Energy"], // petroleum refining
  [3000, 3399, "Basic Materials"], // rubber, plastics, stone, metals
  [3400, 3599, "Industrials"], // fabricated metal, machinery
  [3600, 3699, "Technology"], // electronic & electrical equipment
  [3700, 3799, "Industrials"], // transportation equipment
  [3800, 3899, "Healthcare"], // instruments (measurement overridden)
  [3900, 3999, "Consumer Cyclical"], // misc manufacturing
  [4000, 4499, "Industrials"], // rail, trucking, water transport
  [4500, 4599, "Industrials"], // air transport
  [4600, 4799, "Energy"], // pipelines
  [4800, 4899, "Communication Services"], // communications
  [4900, 4999, "Utilities"], // electric, gas, sanitary
  [5000, 5199, "Industrials"], // wholesale
  [5200, 5399, "Consumer Cyclical"], // building materials, general merch
  [5400, 5499, "Consumer Defensive"], // food stores
  [5500, 5799, "Consumer Cyclical"], // auto dealers, furniture, retail
  [5800, 5899, "Consumer Cyclical"], // eating & drinking places
  [5900, 5999, "Consumer Cyclical"], // misc retail (drug stores overridden)
  [6000, 6499, "Financial Services"], // banks, credit, insurance
  [6500, 6599, "Real Estate"], // real estate
  [6600, 6799, "Financial Services"], // investment offices (REITs overridden)
  [7000, 7099, "Consumer Cyclical"], // hotels
  [7200, 7299, "Consumer Cyclical"], // personal services
  [7300, 7399, "Technology"], // business & computer services
  [7500, 7699, "Consumer Cyclical"], // auto & misc repair
  [7700, 7999, "Communication Services"], // entertainment
  [8000, 8099, "Healthcare"], // health services
  [8100, 8199, "Industrials"], // legal services
  [8200, 8299, "Consumer Defensive"], // educational services
  [8300, 8399, "Healthcare"], // social services
  [8400, 8999, "Industrials"], // engineering, accounting, research
  [9100, 9999, "Industrials"], // public administration
];

/**
 * @param sicCode Polygon's `sic_code` — a string or number, 4 digits.
 * @returns one of the 11 canonical sector names, or null when unmappable.
 */
export function sectorFromSic(
  sicCode: string | number | null | undefined,
): Sector | null {
  if (sicCode == null || sicCode === "") return null;
  const code = Number(sicCode);
  if (!Number.isFinite(code) || code <= 0) return null;

  const exact = EXACT[code];
  if (exact) return exact;

  for (const [lo, hi, sector] of RANGES) {
    if (code >= lo && code <= hi) return sector;
  }
  return null;
}

/**
 * Curated Bitcoin-mining / crypto-compute / blockchain-infrastructure tickers
 * the vendor miscodes as Financial Services (SIC 6199 "Finance Services"). These
 * are reclassified to "Crypto / Blockchain" regardless of description. Legit
 * financials that merely touch crypto (HOOD brokerage, FIGR capital markets)
 * are deliberately absent.
 */
const CRYPTO_TICKERS = new Set([
  "IREN", "HUT", "MARA", "RIOT", "CLSK", "CIFR", "HIVE", "ABTC", "SECZ",
  "BITF", "WULF", "CORZ", "BTBT", "BTDR", "SDIG", "APLD", "CANG", "CAN",
  "SOS", "BTCM", "NCTY", "GREE", "ARBK", "SLNH", "DGHI", "BTOG", "CCG",
  "BTM", "HODL", "MIGI", "SATO", "GLXY", "BMNR",
]);

/** True when name+description clearly reads as a crypto-mining / blockchain-
 *  compute business, and NOT a conventional financial firm that merely mentions
 *  crypto (broker, lender, asset manager, insurer, capital-markets fintech). */
function looksCrypto(text: string): boolean {
  const t = text.toLowerCase();
  const cryptoSignal =
    /\bbitcoin\b|\bcrypto(currency)?\b|\bblockchain\b|\bdigital asset|\bhash\s?rate\b/.test(
      t,
    );
  if (!cryptoSignal) return false;
  const financialGuard =
    /\bbrokerage\b|broker-dealer|retail broker|\blending\b|\bloans?\b|\bmortgage\b|\binsurance\b|asset management|capital markets|\bbank\b|\bexchange\b/.test(
      t,
    );
  const computeSignal =
    /\bmining\b|\bminer\b|\bhash|data cent(er|re)|high-performance computing|\bhpc\b|\bcompute\b/.test(
      t,
    );
  return computeSignal && !financialGuard;
}

/**
 * FMP's `/stable/profile` `sector` is a GICS label whose vocabulary happens to
 * match this app's canonical 11 sectors EXACTLY (Technology, Financial Services,
 * Healthcare, …). Accept a value ONLY when it is exactly one of those names
 * (case-insensitive) — an unrecognised or renamed vendor label degrades to null
 * so the caller falls back to the SIC mapping instead of writing a stray string
 * that `companies.sector` can never join against `sectors` or group for
 * sectorRank. This exact-match whitelist IS the "verify the mapping" the
 * apphosting.yaml SECTORS_FALLBACK caveat asked for.
 *
 * "Crypto / Blockchain" is intentionally NOT reachable from FMP: FMP miscodes
 * miners inconsistently (IREN→Technology but MARA/RIOT/WULF→Financial Services),
 * so that reclassification stays with the curated CRYPTO_TICKERS set / the
 * looksCrypto description guard, which resolveSector applies ABOVE this.
 */
const FMP_SECTOR_WHITELIST: Record<string, Sector> = {
  technology: "Technology",
  "financial services": "Financial Services",
  energy: "Energy",
  healthcare: "Healthcare",
  industrials: "Industrials",
  "consumer defensive": "Consumer Defensive",
  "consumer cyclical": "Consumer Cyclical",
  utilities: "Utilities",
  "basic materials": "Basic Materials",
  "real estate": "Real Estate",
  "communication services": "Communication Services",
};

/** FMP profile `sector` → canonical Sector, or null when unrecognised. */
export function normalizeFmpSector(
  raw: string | null | undefined,
): Sector | null {
  if (!raw) return null;
  return FMP_SECTOR_WHITELIST[raw.trim().toLowerCase()] ?? null;
}

/**
 * Canonical sector with two refinements layered on the raw SIC mapping:
 *
 *   1. Crypto miners — the vendor dumps them into SIC 6199 "Finance Services",
 *      so a curated ticker set (always) plus a guarded description rule (only
 *      when the resolved sector is the ambiguous "Financial Services")
 *      reclassify them to "Crypto / Blockchain". This wins over everything.
 *   2. FMP's GICS `sector` (when provided via meta.fmpSector and it is one of
 *      the canonical 11 names) is PREFERRED over the SIC mapping, because SIC is
 *      a coarse free-text bucket (IREN → "Finance Services") while FMP carries a
 *      real sector classification (IREN → "Technology"). SIC remains the
 *      fallback when FMP is off / unknown / an unrecognised label.
 *
 * Everything else falls back to `sectorFromSic`.
 */
export function resolveSector(
  sicCode: string | number | null | undefined,
  meta?: {
    ticker?: string | null;
    name?: string | null;
    description?: string | null;
    fmpSector?: string | null;
  },
): Sector | null {
  const ticker = meta?.ticker?.toUpperCase();
  if (ticker && CRYPTO_TICKERS.has(ticker)) return "Crypto / Blockchain";
  // Prefer FMP's verified GICS sector over the coarse SIC bucket; SIC is the
  // fallback when FMP gave nothing usable.
  const base = normalizeFmpSector(meta?.fmpSector) ?? sectorFromSic(sicCode);
  if (base === "Financial Services") {
    const text = `${meta?.name ?? ""} ${meta?.description ?? ""}`.trim();
    if (text && looksCrypto(text)) return "Crypto / Blockchain";
  }
  return base;
}
