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
  | 'Technology'
  | 'Financial Services'
  | 'Energy'
  | 'Healthcare'
  | 'Industrials'
  | 'Consumer Defensive'
  | 'Consumer Cyclical'
  | 'Utilities'
  | 'Basic Materials'
  | 'Real Estate'
  | 'Communication Services';

/**
 * Specific 4-digit codes whose major group would otherwise mis-assign them.
 * These matter disproportionately: SIC major group 28 is "Chemicals", but 2834
 * is pharmaceuticals; group 35 is "Industrial Machinery", but 3571 is computers
 * and 3674 is semiconductors. Without these overrides the largest names in the
 * universe land in the wrong sector.
 */
const EXACT: Record<number, Sector> = {
  2833: 'Healthcare', 2834: 'Healthcare', 2835: 'Healthcare', 2836: 'Healthcare',
  3571: 'Technology', 3572: 'Technology', 3576: 'Technology', 3577: 'Technology',
  3661: 'Technology', 3663: 'Technology', 3669: 'Technology',
  3672: 'Technology', 3674: 'Technology', 3675: 'Technology', 3676: 'Technology',
  3677: 'Technology', 3678: 'Technology', 3679: 'Technology',
  3711: 'Consumer Cyclical', 3713: 'Consumer Cyclical', 3714: 'Consumer Cyclical',
  3716: 'Consumer Cyclical', 3751: 'Consumer Cyclical',
  3721: 'Industrials', 3724: 'Industrials', 3728: 'Industrials', 3760: 'Industrials',
  3812: 'Industrials',
  3821: 'Healthcare', 3826: 'Healthcare', 3827: 'Healthcare', 3829: 'Healthcare',
  3841: 'Healthcare', 3842: 'Healthcare', 3843: 'Healthcare', 3844: 'Healthcare',
  3845: 'Healthcare', 3851: 'Healthcare',
  3861: 'Technology', 3873: 'Consumer Cyclical',
  5912: 'Consumer Defensive',
  6798: 'Real Estate',
  7812: 'Communication Services', 7819: 'Communication Services',
  7822: 'Communication Services', 7829: 'Communication Services',
  7841: 'Communication Services',
};

/** Inclusive major-group ranges, applied when no exact override matches. */
const RANGES: Array<[number, number, Sector]> = [
  [100, 999, 'Consumer Defensive'],       // agriculture, livestock
  [1000, 1099, 'Basic Materials'],        // metal mining
  [1200, 1299, 'Energy'],                 // coal
  [1300, 1399, 'Energy'],                 // oil & gas extraction
  [1400, 1499, 'Basic Materials'],        // nonmetallic minerals
  [1500, 1799, 'Industrials'],            // construction
  [2000, 2199, 'Consumer Defensive'],     // food, tobacco
  [2200, 2399, 'Consumer Cyclical'],      // textiles, apparel
  [2400, 2499, 'Basic Materials'],        // lumber
  [2500, 2599, 'Consumer Cyclical'],      // furniture
  [2600, 2699, 'Basic Materials'],        // paper
  [2700, 2799, 'Communication Services'], // printing & publishing
  [2800, 2899, 'Basic Materials'],        // chemicals (pharma overridden above)
  [2900, 2999, 'Energy'],                 // petroleum refining
  [3000, 3399, 'Basic Materials'],        // rubber, plastics, stone, metals
  [3400, 3599, 'Industrials'],            // fabricated metal, machinery
  [3600, 3699, 'Technology'],             // electronic & electrical equipment
  [3700, 3799, 'Industrials'],            // transportation equipment
  [3800, 3899, 'Healthcare'],             // instruments (measurement overridden)
  [3900, 3999, 'Consumer Cyclical'],      // misc manufacturing
  [4000, 4499, 'Industrials'],            // rail, trucking, water transport
  [4500, 4599, 'Industrials'],            // air transport
  [4600, 4799, 'Energy'],                 // pipelines
  [4800, 4899, 'Communication Services'], // communications
  [4900, 4999, 'Utilities'],              // electric, gas, sanitary
  [5000, 5199, 'Industrials'],            // wholesale
  [5200, 5399, 'Consumer Cyclical'],      // building materials, general merch
  [5400, 5499, 'Consumer Defensive'],     // food stores
  [5500, 5799, 'Consumer Cyclical'],      // auto dealers, furniture, retail
  [5800, 5899, 'Consumer Cyclical'],      // eating & drinking places
  [5900, 5999, 'Consumer Cyclical'],      // misc retail (drug stores overridden)
  [6000, 6499, 'Financial Services'],     // banks, credit, insurance
  [6500, 6599, 'Real Estate'],            // real estate
  [6600, 6799, 'Financial Services'],     // investment offices (REITs overridden)
  [7000, 7099, 'Consumer Cyclical'],      // hotels
  [7200, 7299, 'Consumer Cyclical'],      // personal services
  [7300, 7399, 'Technology'],             // business & computer services
  [7500, 7699, 'Consumer Cyclical'],      // auto & misc repair
  [7700, 7999, 'Communication Services'], // entertainment
  [8000, 8099, 'Healthcare'],             // health services
  [8100, 8199, 'Industrials'],            // legal services
  [8200, 8299, 'Consumer Defensive'],     // educational services
  [8300, 8399, 'Healthcare'],             // social services
  [8400, 8999, 'Industrials'],            // engineering, accounting, research
  [9100, 9999, 'Industrials'],            // public administration
];

/**
 * @param sicCode Polygon's `sic_code` — a string or number, 4 digits.
 * @returns one of the 11 canonical sector names, or null when unmappable.
 */
export function sectorFromSic(
  sicCode: string | number | null | undefined,
): Sector | null {
  if (sicCode == null || sicCode === '') return null;
  const code = Number(sicCode);
  if (!Number.isFinite(code) || code <= 0) return null;

  const exact = EXACT[code];
  if (exact) return exact;

  for (const [lo, hi, sector] of RANGES) {
    if (code >= lo && code <= hi) return sector;
  }
  return null;
}
