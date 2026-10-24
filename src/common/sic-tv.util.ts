import {
  type TvSector,
  isTvIndustry,
  sectorForIndustry,
} from "./tv-taxonomy";

/**
 * SEC SIC code -> TradingView (RBICS) sector + industry.
 *
 * This is the ONLY place a ticker gets classified. Polygon returns `sic_code`
 * for every listed name, including one that IPO'd this morning, so routing all
 * classification through here is what makes a brand-new ticker land in the
 * right sector on its FIRST sync rather than waiting on a backfill.
 *
 * Structure mirrors the util it replaces: exact 4-digit codes first (they carry
 * the megacaps and would otherwise be mis-grouped by their major group), then a
 * 2-digit major-group fallback. An unmapped code returns nulls — a missing
 * sector is recoverable, a wrong one silently corrupts every ranking that
 * groups by it.
 */

export interface TvClassification {
  sector: TvSector | null;
  industry: string | null;
}

const NONE: TvClassification = { sector: null, industry: null };

/**
 * Bitcoin-mining / AI-compute data-centre operators. The SEC files most of
 * them under SIC 6199 "Finance Services", which made IREN, MARA, RIOT … show
 * as Finance. They run data centres that sell compute, so they are classified
 * as Technology Services / Data Processing Services regardless of SIC.
 * Financial firms that merely touch crypto (brokers, exchanges, treasuries,
 * ETFs) are deliberately absent.
 */
export const COMPUTE_INFRA_TICKERS: readonly string[] = [
  "IREN", "HUT", "MARA", "RIOT", "CLSK", "CIFR", "HIVE", "ABTC", "BITF",
  "WULF", "CORZ", "BTBT", "BTDR", "SDIG", "APLD", "CANG", "SOS", "BTCM",
  "GREE", "ARBK", "SLNH", "DGHI", "MIGI", "SATO",
];
/**
 * Well-known names whose SEC SIC code lands on the wrong TradingView industry
 * (XOM's SIC 2911 "petroleum refining" reads as a refiner, not an integrated
 * major; ETN's switchgear code as machinery). Sector follows the industry.
 */
const INDUSTRY_OVERRIDES: Record<string, { sector: TvSector; industry: string }> = {
  XOM: { sector: "Energy Minerals", industry: "Integrated Oil" },
  CVX: { sector: "Energy Minerals", industry: "Integrated Oil" },
  ETN: { sector: "Producer Manufacturing", industry: "Electrical Products" },
  COST: { sector: "Retail Trade", industry: "Specialty Stores" },
  // SIC 2911 (refining) is ConocoPhillips' legacy code; it has been a pure
  // exploration & production company since the 2012 Phillips 66 spin-off.
  COP: { sector: "Energy Minerals", industry: "Oil & Gas Production" },
  // SIC 3600 is the old GE conglomerate's code; after the 2024 spin-offs GE
  // is GE Aerospace (jet engines).
  GE: { sector: "Electronic Technology", industry: "Aerospace & Defense" },
  // SIC 3829 "measuring & controlling devices": Thermo Fisher's instruments
  // are life-science and clinical lab equipment.
  TMO: { sector: "Health Technology", industry: "Medical Specialties" },
};

const TICKER_OVERRIDES: Record<string, TvClassification> = {
  ...Object.fromEntries(
    COMPUTE_INFRA_TICKERS.map((t) => [t, { sector: "Technology Services" as TvSector, industry: "Data Processing Services" }]),
  ),
  ...INDUSTRY_OVERRIDES,
};

/**
 * Applies the ticker overrides to an already-stored doc (companies / movers
 * written before the override existed), leaving every other doc untouched.
 */
export function withTickerOverride<T extends Record<string, unknown>>(doc: T): T {
  const o = TICKER_OVERRIDES[String(doc.ticker ?? "").trim().toUpperCase()];
  return o && (doc.sector !== o.sector || doc.industry !== o.industry)
    ? { ...doc, sector: o.sector, industry: o.industry }
    : doc;
}

/** Exact 4-digit SIC -> industry. Sector is derived from the industry, so the
 *  two can never disagree. */
const EXACT_INDUSTRY: Record<number, string> = {
  // ── Technology / electronics ────────────────────────────────────────────
  3674: "Semiconductors",
  3559: "Electronic Production Equipment",
  3827: "Electronic Equipment/Instruments",
  3825: "Electronic Equipment/Instruments",
  3670: "Electronic Components",
  3672: "Electronic Components",
  3677: "Electronic Components",
  3678: "Electronic Components",
  3679: "Electronic Components",
  3571: "Computer Processing Hardware",
  3572: "Computer Peripherals",
  3575: "Computer Peripherals",
  3576: "Computer Communications",
  3577: "Computer Peripherals",
  3661: "Telecommunications Equipment",
  3663: "Telecommunications Equipment",
  3669: "Telecommunications Equipment",
  3585: "Industrial Machinery",
  // ── Software / internet services ────────────────────────────────────────
  7372: "Packaged Software",
  7371: "Information Technology Services",
  7373: "Information Technology Services",
  7374: "Data Processing Services",
  7370: "Internet Software/Services",
  7375: "Internet Software/Services",
  7379: "Information Technology Services",
  // ── Health ──────────────────────────────────────────────────────────────
  2833: "Pharmaceuticals: Other",
  2834: "Pharmaceuticals: Major",
  2835: "Biotechnology",
  2836: "Biotechnology",
  8731: "Biotechnology",
  3826: "Medical Specialties",
  3841: "Medical Specialties",
  3842: "Medical Specialties",
  3843: "Medical Specialties",
  3844: "Medical Specialties",
  3845: "Medical Specialties",
  8062: "Hospital/Nursing Management",
  8071: "Services to the Health Industry",
  8090: "Medical/Nursing Services",
  8093: "Medical/Nursing Services",
  6324: "Managed Health Care",
  5122: "Medical Distributors",
  5912: "Drugstore Chains",
  // ── Energy ──────────────────────────────────────────────────────────────
  1311: "Oil & Gas Production",
  1381: "Contract Drilling",
  1389: "Oilfield Services/Equipment",
  2911: "Oil Refining/Marketing",
  4922: "Oil & Gas Pipelines",
  // "Natural gas transmission & DISTRIBUTION" — local gas utilities file here
  // (RGC Resources, Atmos, National Fuel Gas); pipeline operators use 4922.
  4923: "Gas Distributors",
  4924: "Gas Distributors",
  1221: "Coal",
  // ── Financials ──────────────────────────────────────────────────────────
  6020: "Major Banks",
  6021: "Major Banks",
  6022: "Regional Banks",
  6035: "Savings Banks",
  6036: "Savings Banks",
  6199: "Finance/Rental/Leasing",
  6141: "Finance/Rental/Leasing",
  6153: "Finance/Rental/Leasing",
  6159: "Finance/Rental/Leasing",
  6189: "Finance/Rental/Leasing",
  6211: "Investment Banks/Brokers",
  6221: "Investment Banks/Brokers",
  6282: "Investment Managers",
  6726: "Investment Trusts/Mutual Funds",
  6311: "Life/Health Insurance",
  6321: "Life/Health Insurance",
  6331: "Property/Casualty Insurance",
  6351: "Specialty Insurance",
  6411: "Insurance Brokers/Services",
  6798: "Real Estate Investment Trusts",
  6500: "Real Estate Development",
  6512: "Real Estate Development",
  6552: "Real Estate Development",
  6770: "Financial Conglomerates",
  // ── Consumer / retail ───────────────────────────────────────────────────
  5961: "Internet Retail",
  5311: "Department Stores",
  5331: "Discount Stores",
  5399: "Discount Stores",
  5411: "Food Retail",
  5412: "Food Retail",
  // 55xx are dealers and auto-parts STORES (AutoNation, MarineMax, AutoZone):
  // retailers, not makers of aftermarket parts.
  5500: "Specialty Stores",
  5531: "Specialty Stores",
  5651: "Apparel/Footwear Retail",
  5661: "Apparel/Footwear Retail",
  5621: "Apparel/Footwear Retail",
  5600: "Apparel/Footwear Retail",
  5211: "Home Improvement Chains",
  5731: "Electronics/Appliance Stores",
  5812: "Restaurants",
  5813: "Restaurants",
  7011: "Hotels/Resorts/Cruise lines",
  // Car / equipment rental and leasing (Avis, Hertz, United Rentals).
  7510: "Finance/Rental/Leasing",
  7513: "Finance/Rental/Leasing",
  7514: "Finance/Rental/Leasing",
  7515: "Finance/Rental/Leasing",
  7359: "Finance/Rental/Leasing",
  // 7990 is SEC's GENERAL "Amusement & Recreation Services" bucket, not a
  // casino code — Disney files under it. Mapping it to Casinos/Gaming put DIS
  // in Casinos/Gaming. The specific gaming codes (7011 hotels-casinos, 7993
  // coin-operated devices) still map there; this one is the catch-all and
  // belongs with entertainment.
  7990: "Movies/Entertainment",
  7993: "Casinos/Gaming",
  // ── Consumer products ───────────────────────────────────────────────────
  2080: "Beverages: Non-Alcoholic",
  2086: "Beverages: Non-Alcoholic",
  2082: "Beverages: Alcoholic",
  2084: "Beverages: Alcoholic",
  2085: "Beverages: Alcoholic",
  2111: "Tobacco",
  2844: "Household/Personal Care",
  2840: "Household/Personal Care",
  2300: "Apparel/Footwear",
  3021: "Apparel/Footwear", // rubber & plastic footwear (Crocs) — not an industrial specialty
  3140: "Apparel/Footwear",
  3143: "Apparel/Footwear",
  3144: "Apparel/Footwear",
  3149: "Apparel/Footwear",
  // Consumer goods that the major-group fallback put in manufacturing /
  // electronics: toys & sporting goods, boats, watches, housewares & tools.
  3940: "Recreational Products",
  3942: "Recreational Products",
  3944: "Recreational Products",
  3949: "Recreational Products",
  3730: "Recreational Products",
  3732: "Recreational Products",
  3873: "Other Consumer Specialties",
  3420: "Tools & Hardware",
  // Office furniture (MillerKnoll, Steelcase, HNI) is office equipment.
  2520: "Office Equipment/Supplies",
  2521: "Office Equipment/Supplies",
  2522: "Office Equipment/Supplies",
  2000: "Foods",
  2020: "Foods",
  2030: "Foods",
  2050: "Food: Specialty/Candy",
  2060: "Food: Specialty/Candy",
  2090: "Food: Major Diversified",
  // ── Industrials / manufacturing ─────────────────────────────────────────
  3711: "Motor Vehicles",
  3713: "Trucks/Construction/Farm Machinery",
  3714: "Auto Parts: OEM",
  3715: "Trucks/Construction/Farm Machinery",
  3716: "Motor Vehicles",
  3751: "Recreational Products",
  3721: "Aerospace & Defense",
  3724: "Aerospace & Defense",
  3728: "Aerospace & Defense",
  3760: "Aerospace & Defense",
  3812: "Aerospace & Defense",
  3531: "Trucks/Construction/Farm Machinery",
  3523: "Trucks/Construction/Farm Machinery",
  3510: "Industrial Machinery",
  3540: "Industrial Machinery",
  3550: "Industrial Machinery",
  3560: "Industrial Machinery",
  3561: "Industrial Machinery",
  3567: "Industrial Machinery",
  3600: "Electrical Products",
  3612: "Electrical Products",
  3620: "Electrical Products",
  3640: "Electrical Products",
  3690: "Electrical Products",
  3990: "Miscellaneous Manufacturing",
  // ── Materials / process ─────────────────────────────────────────────────
  2800: "Chemicals: Major Diversified",
  2810: "Chemicals: Major Diversified",
  2820: "Chemicals: Specialty",
  2821: "Chemicals: Specialty",
  2860: "Chemicals: Specialty",
  2870: "Chemicals: Agricultural",
  2851: "Chemicals: Specialty",
  2600: "Pulp & Paper",
  2611: "Pulp & Paper",
  2621: "Pulp & Paper",
  2650: "Containers/Packaging",
  3080: "Containers/Packaging",
  3220: "Containers/Packaging",
  3312: "Steel",
  3316: "Steel",
  3330: "Other Metals/Minerals",
  3334: "Aluminum",
  3350: "Aluminum",
  1040: "Precious Metals",
  1000: "Other Metals/Minerals",
  1220: "Coal",
  3241: "Construction Materials",
  3270: "Construction Materials",
  2400: "Forest Products",
  2430: "Building Products",
  // ── Transport ───────────────────────────────────────────────────────────
  4011: "Railroads",
  4013: "Railroads",
  4210: "Trucking",
  4213: "Trucking",
  4400: "Marine Shipping",
  4412: "Marine Shipping",
  4512: "Airlines",
  4513: "Air Freight/Couriers",
  4731: "Other Transportation",
  // ── Utilities ───────────────────────────────────────────────────────────
  4911: "Electric Utilities",
  4931: "Electric Utilities",
  4932: "Electric Utilities",
  4941: "Water Utilities",
  4991: "Alternative Power Generation",
  // ── Communications / media ──────────────────────────────────────────────
  4813: "Specialty Telecommunications",
  4812: "Wireless Telecommunications",
  4822: "Specialty Telecommunications",
  4841: "Cable/Satellite TV",
  4832: "Broadcasting",
  4833: "Broadcasting",
  7812: "Movies/Entertainment",
  7819: "Movies/Entertainment",
  7900: "Movies/Entertainment",
  2711: "Publishing: Newspapers",
  2721: "Publishing: Books/Magazines",
  2731: "Publishing: Books/Magazines",
  // ── Services / commercial ───────────────────────────────────────────────
  7311: "Advertising/Marketing Services",
  7363: "Personnel Services",
  7361: "Personnel Services",
  8742: "Miscellaneous Commercial Services",
  8711: "Engineering & Construction",
  1600: "Engineering & Construction",
  1623: "Engineering & Construction",
  1531: "Homebuilding",
  4959: "Environmental Services",
  4953: "Environmental Services",
  5045: "Electronics Distributors",
  5065: "Electronics Distributors",
  5140: "Food Distributors",
  5141: "Food Distributors",
  5000: "Wholesale Distributors",
  5010: "Wholesale Distributors",
  5090: "Wholesale Distributors",
  5199: "Wholesale Distributors",
  2750: "Commercial Printing/Forms",
  2761: "Commercial Printing/Forms",
};

/** 2-digit SIC major group -> industry, used when no exact code matches. */
const MAJOR_GROUP_INDUSTRY: Record<number, string> = {
  1: "Agricultural Commodities/Milling",
  2: "Agricultural Commodities/Milling",
  // 7 (agricultural services) and 9 (fishing/hunting/trapping) were the two
  // holes in SIC's agriculture division — AquaBounty (0900, salmon) fell
  // through and kept an FMP GICS label instead of a TradingView one.
  7: "Agricultural Commodities/Milling",
  8: "Forest Products",
  9: "Agricultural Commodities/Milling",
  10: "Other Metals/Minerals",
  12: "Coal",
  13: "Oil & Gas Production",
  14: "Other Metals/Minerals",
  15: "Homebuilding",
  16: "Engineering & Construction",
  17: "Engineering & Construction",
  20: "Foods",
  21: "Tobacco",
  22: "Textiles",
  23: "Apparel/Footwear",
  24: "Forest Products",
  25: "Home Furnishings",
  26: "Pulp & Paper",
  27: "Publishing: Books/Magazines",
  28: "Chemicals: Major Diversified",
  29: "Oil Refining/Marketing",
  30: "Industrial Specialties",
  31: "Apparel/Footwear",
  32: "Construction Materials",
  33: "Steel",
  34: "Metal Fabrication",
  35: "Industrial Machinery",
  36: "Electrical Products",
  37: "Motor Vehicles",
  38: "Electronic Equipment/Instruments",
  39: "Miscellaneous Manufacturing",
  40: "Railroads",
  41: "Other Transportation",
  42: "Trucking",
  44: "Marine Shipping",
  45: "Airlines",
  46: "Oil & Gas Pipelines",
  47: "Other Transportation",
  48: "Specialty Telecommunications",
  49: "Electric Utilities",
  50: "Wholesale Distributors",
  51: "Wholesale Distributors",
  52: "Home Improvement Chains",
  53: "Discount Stores",
  54: "Food Retail",
  55: "Specialty Stores",
  56: "Apparel/Footwear Retail",
  57: "Electronics/Appliance Stores",
  58: "Restaurants",
  59: "Specialty Stores",
  60: "Major Banks",
  61: "Finance/Rental/Leasing",
  62: "Investment Banks/Brokers",
  63: "Property/Casualty Insurance",
  64: "Insurance Brokers/Services",
  65: "Real Estate Development",
  67: "Investment Managers",
  70: "Hotels/Resorts/Cruise lines",
  72: "Other Consumer Services",
  73: "Information Technology Services",
  75: "Automotive Aftermarket",
  78: "Movies/Entertainment",
  79: "Casinos/Gaming",
  80: "Medical/Nursing Services",
  82: "Other Consumer Services",
  83: "Other Consumer Services",
  87: "Miscellaneous Commercial Services",
  89: "Miscellaneous Commercial Services",
};

/**
 * Classify a ticker from its SIC code. Returns both fields together so the
 * sector is always the one the industry rolls up to — they cannot drift apart.
 */
export function classifyFromSic(
  sicCode: string | number | null | undefined,
  ticker?: string | null,
): TvClassification {
  const override = ticker ? TICKER_OVERRIDES[ticker.trim().toUpperCase()] : undefined;
  if (override) return override;
  const code =
    typeof sicCode === "number" ? sicCode : parseInt(String(sicCode ?? ""), 10);
  if (!Number.isFinite(code) || code <= 0) return NONE;

  const exact = EXACT_INDUSTRY[code];
  const industry = exact ?? MAJOR_GROUP_INDUSTRY[Math.floor(code / 100)] ?? null;
  if (!industry || !isTvIndustry(industry)) return NONE;

  const sector = sectorForIndustry(industry);
  return sector ? { sector, industry } : NONE;
}

/**
 * Canonical SIC code resolution across all backend adapters and services.
 *
 * 1. SEC EDGAR is the official regulatory filing authority for US-listed companies.
 *    Corporate pivots, reverse mergers, and SPAC acquisitions are reflected promptly
 *    in SEC filings (10-K, 8-K, 10-Q), whereas third-party reference databases frequently
 *    harbor stale, historical pre-pivot SIC codes.
 * 2. If SEC EDGAR has no valid non-zero SIC code (or for foreign issuers / errors),
 *    fall back to Polygon's reference sic_code.
 * 3. Returns null if neither source provides a usable non-zero SIC code.
 */
export function resolveSicCode(
  secSic: string | number | null | undefined,
  polygonSic: string | number | null | undefined,
): string | number | null {
  const cleanSec = secSic != null ? String(secSic).trim() : "";
  if (cleanSec !== "" && cleanSec !== "0") return cleanSec;

  const cleanPoly = polygonSic != null ? String(polygonSic).trim() : "";
  if (cleanPoly !== "" && cleanPoly !== "0") return cleanPoly;

  return null;
}


/**
 * Vendor (FMP profile) industry -> TradingView industry, used ONLY when no SIC
 * code exists at all. Banks that report to the FDIC/Fed instead of the SEC
 * (Preferred Bank, PFBC) have no EDGAR SIC and Polygon carries none, so they
 * showed N/A. Exact names first, then prefixes; an unmapped industry stays
 * null — a missing sector beats a guessed one.
 */
const VENDOR_INDUSTRY: Record<string, string> = {
  "banks - regional": "Regional Banks",
  "banks - diversified": "Major Banks",
  "banks": "Regional Banks",
  "asset management": "Investment Managers",
  "capital markets": "Investment Banks/Brokers",
  "financial - capital markets": "Investment Banks/Brokers",
  "financial - credit services": "Finance/Rental/Leasing",
  "financial - mortgages": "Finance/Rental/Leasing",
  "insurance - life": "Life/Health Insurance",
  "insurance - property & casualty": "Property/Casualty Insurance",
  "insurance - diversified": "Multi-Line Insurance",
  "insurance - specialty": "Specialty Insurance",
  "insurance - brokers": "Insurance Brokers/Services",
  "insurance - reinsurance": "Specialty Insurance",
  "software - application": "Packaged Software",
  "software - infrastructure": "Packaged Software",
  "semiconductors": "Semiconductors",
  "biotechnology": "Biotechnology",
  "drug manufacturers - general": "Pharmaceuticals: Major",
  "drug manufacturers - specialty & generic": "Pharmaceuticals: Generic",
  "medical - devices": "Medical Specialties",
  "medical - instruments & supplies": "Medical Specialties",
  "oil & gas exploration & production": "Oil & Gas Production",
  "oil & gas integrated": "Integrated Oil",
  "oil & gas midstream": "Oil & Gas Pipelines",
  "oil & gas refining & marketing": "Oil Refining/Marketing",
  "oil & gas equipment & services": "Oilfield Services/Equipment",
  "oil & gas drilling": "Contract Drilling",
  "regulated electric": "Electric Utilities",
  "regulated gas": "Gas Distributors",
  "regulated water": "Water Utilities",
  "renewable utilities": "Alternative Power Generation",
  "restaurants": "Restaurants",
  "specialty retail": "Specialty Stores",
  "auto - dealerships": "Specialty Stores",
  "packaged foods": "Foods",
  "beverages - non-alcoholic": "Beverages: Non-Alcoholic",
  "aerospace & defense": "Aerospace & Defense",
};
const VENDOR_INDUSTRY_PREFIX: Array<[string, string]> = [
  ["reit - ", "Real Estate Investment Trusts"],
  ["real estate - ", "Real Estate Development"],
  ["banks", "Regional Banks"],
];

export function classifyFromVendorIndustry(industry: string | null | undefined): TvClassification {
  const key = String(industry ?? "").trim().toLowerCase();
  if (!key) return NONE;
  const tv = VENDOR_INDUSTRY[key] ?? VENDOR_INDUSTRY_PREFIX.find(([p]) => key.startsWith(p))?.[1] ?? null;
  if (!tv || !isTvIndustry(tv)) return NONE;
  const sector = sectorForIndustry(tv);
  return sector ? { sector, industry: tv } : NONE;
}

/** The SIC classification, or — only when it came back empty — the vendor-industry one. */
export function withVendorIndustryFallback(
  sicClass: TvClassification,
  vendorIndustry: string | null | undefined,
): TvClassification {
  return sicClass.sector ? sicClass : classifyFromVendorIndustry(vendorIndustry);
}
