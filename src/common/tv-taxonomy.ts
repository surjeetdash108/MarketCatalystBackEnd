/**
 * The TradingView (FactSet/RBICS) sector + industry vocabulary — the ONE
 * classification this app uses, everywhere.
 *
 * WHY THIS REPLACED THE OLD SCHEME
 * The app previously used an 11-name GICS/SPDR-flavoured sector list derived
 * from SIC major groups, and wrote whatever `industry` string the vendor
 * happened to return. That produced 35 distinct "sectors" in Firestore —
 * including raw SIC descriptions like "FIRE, MARINE & CASUALTY INSURANCE" —
 * and ~170 unnormalised industries, so screener filters, in-sector RS ranks
 * and the heatmap were all grouping on inconsistent keys.
 *
 * These lists are taken verbatim from TradingView's own USA sector/industry
 * pages, so a value shown here matches what a user sees there.
 *
 * NOTE ON SOURCING: no vendor we hold (Polygon, FMP) publishes RBICS, so these
 * values are DERIVED from the SEC SIC code Polygon returns for every ticker —
 * see sic-tv.util.ts. That mapping is the only place a ticker gets classified,
 * which is what makes a newly-listed ticker classify correctly on its first
 * sync instead of waiting for a manual backfill.
 */

export const TV_SECTORS = [
  "Commercial Services",
  "Communications",
  "Consumer Durables",
  "Consumer Non-Durables",
  "Consumer Services",
  "Distribution Services",
  "Electronic Technology",
  "Energy Minerals",
  "Finance",
  "Health Services",
  "Health Technology",
  "Industrial Services",
  "Miscellaneous",
  "Non-Energy Minerals",
  "Process Industries",
  "Producer Manufacturing",
  "Retail Trade",
  "Technology Services",
  "Transportation",
  "Utilities",
] as const;

export type TvSector = (typeof TV_SECTORS)[number];

/** Every industry TradingView lists for USA equities, grouped by its sector.
 *  The grouping is what lets a sector page roll its industries up. */
export const TV_INDUSTRIES_BY_SECTOR: Record<TvSector, readonly string[]> = {
  "Commercial Services": [
    "Advertising/Marketing Services",
    "Commercial Printing/Forms",
    "Financial Publishing/Services",
    "Miscellaneous Commercial Services",
    "Personnel Services",
  ],
  Communications: [
    "Cable/Satellite TV",
    "Specialty Telecommunications",
    "Wireless Telecommunications",
  ],
  "Consumer Durables": [
    "Automotive Aftermarket",
    "Building Products",
    "Electronics/Appliances",
    "Home Furnishings",
    "Homebuilding",
    "Motor Vehicles",
    "Other Consumer Specialties",
    "Recreational Products",
    "Tools & Hardware",
  ],
  "Consumer Non-Durables": [
    "Agricultural Commodities/Milling",
    "Apparel/Footwear",
    "Beverages: Alcoholic",
    "Beverages: Non-Alcoholic",
    "Consumer Sundries",
    "Food: Major Diversified",
    "Food: Specialty/Candy",
    "Foods",
    "Household/Personal Care",
    "Textiles",
    "Tobacco",
  ],
  "Consumer Services": [
    "Broadcasting",
    "Casinos/Gaming",
    "Hotels/Resorts/Cruise lines",
    "Media Conglomerates",
    "Movies/Entertainment",
    "Other Consumer Services",
    "Publishing: Books/Magazines",
    "Publishing: Newspapers",
    "Restaurants",
  ],
  "Distribution Services": [
    "Catalog/Specialty Distribution",
    "Electronics Distributors",
    "Food Distributors",
    "Medical Distributors",
    "Wholesale Distributors",
  ],
  "Electronic Technology": [
    "Aerospace & Defense",
    "Computer Communications",
    "Computer Peripherals",
    "Computer Processing Hardware",
    "Electronic Components",
    "Electronic Equipment/Instruments",
    "Electronic Production Equipment",
    "Semiconductors",
    "Telecommunications Equipment",
  ],
  "Energy Minerals": [
    "Coal",
    "Integrated Oil",
    "Oil & Gas Production",
    "Oil Refining/Marketing",
  ],
  Finance: [
    "Finance/Rental/Leasing",
    "Financial Conglomerates",
    "Insurance Brokers/Services",
    "Investment Banks/Brokers",
    "Investment Managers",
    "Investment Trusts/Mutual Funds",
    "Life/Health Insurance",
    "Major Banks",
    "Multi-Line Insurance",
    "Property/Casualty Insurance",
    "Real Estate Development",
    "Real Estate Investment Trusts",
    "Regional Banks",
    "Savings Banks",
    "Specialty Insurance",
  ],
  "Health Services": [
    "Hospital/Nursing Management",
    "Managed Health Care",
    "Medical/Nursing Services",
    "Services to the Health Industry",
  ],
  "Health Technology": [
    "Biotechnology",
    "Medical Specialties",
    "Pharmaceuticals: Generic",
    "Pharmaceuticals: Major",
    "Pharmaceuticals: Other",
  ],
  "Industrial Services": [
    "Contract Drilling",
    "Engineering & Construction",
    "Environmental Services",
    "Oilfield Services/Equipment",
    "Oil & Gas Pipelines",
  ],
  Miscellaneous: ["Miscellaneous"],
  "Non-Energy Minerals": [
    "Aluminum",
    "Construction Materials",
    "Forest Products",
    "Other Metals/Minerals",
    "Precious Metals",
    "Steel",
  ],
  "Process Industries": [
    "Agricultural Commodities/Milling",
    "Chemicals: Agricultural",
    "Chemicals: Major Diversified",
    "Chemicals: Specialty",
    "Containers/Packaging",
    "Industrial Specialties",
    "Pulp & Paper",
  ],
  "Producer Manufacturing": [
    "Auto Parts: OEM",
    "Electrical Products",
    "Industrial Conglomerates",
    "Industrial Machinery",
    "Metal Fabrication",
    "Miscellaneous Manufacturing",
    "Office Equipment/Supplies",
    "Trucks/Construction/Farm Machinery",
  ],
  "Retail Trade": [
    "Apparel/Footwear Retail",
    "Department Stores",
    "Discount Stores",
    "Drugstore Chains",
    "Electronics/Appliance Stores",
    "Food Retail",
    "Home Improvement Chains",
    "Internet Retail",
    "Specialty Stores",
  ],
  "Technology Services": [
    "Data Processing Services",
    "Information Technology Services",
    "Internet Software/Services",
    "Packaged Software",
  ],
  Transportation: [
    "Air Freight/Couriers",
    "Airlines",
    "Marine Shipping",
    "Other Transportation",
    "Railroads",
    "Trucking",
  ],
  Utilities: [
    "Alternative Power Generation",
    "Electric Utilities",
    "Gas Distributors",
    "Water Utilities",
  ],
};

/** Flat list of every industry, deduped (a few appear under two sectors on
 *  TradingView's own pages, e.g. Agricultural Commodities/Milling). */
export const TV_INDUSTRIES: readonly string[] = Array.from(
  new Set(Object.values(TV_INDUSTRIES_BY_SECTOR).flat()),
).sort();

const SECTOR_SET = new Set<string>(TV_SECTORS);
const INDUSTRY_SET = new Set<string>(TV_INDUSTRIES);

export const isTvSector = (v: unknown): v is TvSector =>
  typeof v === "string" && SECTOR_SET.has(v);
export const isTvIndustry = (v: unknown): boolean =>
  typeof v === "string" && INDUSTRY_SET.has(v);

/** The sector an industry rolls up to, or null if the name is not ours. */
export function sectorForIndustry(industry: string | null): TvSector | null {
  if (!industry) return null;
  for (const s of TV_SECTORS) {
    if (TV_INDUSTRIES_BY_SECTOR[s].includes(industry)) return s;
  }
  return null;
}
