/**
 * AI-infrastructure investment themes — groups stocks into the sub-sectors
 * that make up the AI buildout (compute, the fabs/equipment that make the
 * chips, the power/cooling/real-estate that houses them, the platforms that
 * sell the resulting capacity, and the wider supply chain around all of it).
 *
 * WHY RULES, NOT A TICKER LIST
 * No vendor or Firestore collection carries this taxonomy (checked Polygon/
 * FMP/Finnhub/FRED and every top-level Firestore collection), so the THEME
 * DEFINITIONS here are hand-authored — but membership is computed dynamically
 * from the existing `companies` collection instead of being a hardcoded
 * ticker list, so a newly-listed or newly-classified company shows up in the
 * right theme on its next sync with zero manual maintenance.
 *
 * Each theme narrows the `companies` collection to a candidate pool via its
 * TradingView `industry` value(s) (`tv-taxonomy.ts`), then confirms actual
 * membership with a keyword test against `name`+`description`. The industry
 * filter alone isn't enough — TV's single "Semiconductors" industry holds
 * GPU designers, foundries, equipment makers and packaging/test houses all
 * together — so the keyword step is what actually separates them. This is
 * the same two-step pattern `resolveSector`'s `looksCrypto()` already uses to
 * pull bitcoin miners out of the "Financial Services" bucket.
 *
 * A ticker can land in more than one theme when the business genuinely spans
 * both (e.g. Broadcom designs AI accelerators AND the networking silicon
 * that ties them together) — themes are investment groupings, not a
 * partition. `fallbackOnly` themes are the exception: they only claim
 * companies no earlier (non-fallback) theme already matched, so they act as
 * a residual bucket rather than double-counting into it.
 *
 * `icon` is a short semantic token for the frontend to map to its own icon
 * set — this service has no opinion on the actual glyph.
 */
import { isTvIndustry } from "./tv-taxonomy";
import { classifyFromSic } from "./sic-tv.util";

export interface AiInfrastructureTheme {
  key: string;
  title: string;
  icon: string;
  blurb: string;
  /** TradingView `industry` values (tv-taxonomy.ts) that narrow the
   *  candidate pool before the keyword test runs. */
  industries: string[];
  /** Tested against `${name} ${description}`. Omitted for the one theme
   *  (Defense & Aerospace) where the industry alone is unambiguous. */
  keywords?: RegExp;
  /** Only matches companies no earlier theme in this list already claimed —
   *  makes this a residual/catch-all bucket instead of a normal theme. */
  fallbackOnly?: boolean;
}

export const AI_INFRASTRUCTURE_THEMES: AiInfrastructureTheme[] = [
  {
    key: "gpu-ai-compute",
    title: "GPU & AI Compute",
    icon: "cpu",
    blurb:
      "Chip designers building the GPUs and AI accelerators that train and run large models.",
    industries: ["Semiconductors"],
    keywords:
      /\b(GPUs?|graphics processing units?|AI accelerators?|AI chips?|AI PCs?|AI SoCs?|NPUs?|neural processing units?|data ?center CPUs?)\b/i,
  },
  {
    key: "semiconductor-equipment",
    title: "Semiconductor Equipment",
    icon: "wrench",
    blurb:
      "The lithography, deposition, etch and process-control tool makers every advanced chip fab depends on.",
    industries: [
      "Semiconductors",
      "Electronic Production Equipment",
      "Electronic Equipment/Instruments",
    ],
    keywords:
      /\b(wafer fabrication|semiconductor (manufacturing|fabrication) equipment|deposition|etching?|lithography|process control)\b/i,
  },
  {
    key: "foundries-manufacturing",
    title: "Foundries & Manufacturing",
    icon: "factory",
    blurb:
      "The contract fabs that actually manufacture the leading-edge chips fabless designers sell.",
    industries: ["Semiconductors"],
    // Singular only: equipment/packaging vendors describe their CUSTOMERS as
    // "foundries" (plural) — e.g. Applied Materials sells to "foundries",
    // Amkor packages for "foundries" — while an actual foundry describes
    // itself in the singular ("is ... a chip foundry", "Intel Foundry").
    keywords: /\bfoundry\b/i,
  },
  {
    key: "advanced-packaging-testing",
    title: "Advanced Packaging & Testing",
    icon: "package",
    blurb:
      "OSAT and packaging specialists solving the interconnect bottleneck between the die and the board.",
    industries: [
      "Semiconductors",
      "Electronic Equipment/Instruments",
      "Electronic Production Equipment",
    ],
    keywords:
      /\b(advanced packaging|chip packaging|OSAT|assembly and test|semiconductor testing|test equipment)\b/i,
  },
  {
    key: "memory-storage",
    title: "Memory & Storage",
    icon: "database",
    blurb:
      "DRAM, HBM, flash and disk suppliers whose capacity constraints set the pace of AI server builds.",
    industries: [
      "Semiconductors",
      "Computer Peripherals",
      "Computer Processing Hardware",
    ],
    keywords:
      /\b(DRAM|NAND|memory chips?|flash memory|hard disk drives?|solid.state drives?|SSDs?|data storage)\b/i,
  },
  {
    key: "optical-photonics",
    title: "Optical & Photonics",
    icon: "sun",
    blurb:
      "Optical components, transceivers and lasers forming the physical links between GPU clusters.",
    industries: [
      "Electronic Equipment/Instruments",
      "Telecommunications Equipment",
      "Semiconductors",
    ],
    keywords:
      /\b(optical (components?|networking|transceivers?)|photonics?|lasers?)\b/i,
  },
  {
    key: "networking-data-movement",
    title: "Networking & Data Movement",
    icon: "network",
    blurb:
      "Switches, interconnects and networking silicon that tie thousands of GPUs into one cluster.",
    industries: [
      "Computer Communications",
      "Telecommunications Equipment",
      "Semiconductors",
    ],
    keywords:
      /\b(networking|network switches?|ethernet|data center interconnects?|interconnects?)\b/i,
  },
  {
    key: "power-infrastructure",
    title: "Power Infrastructure",
    icon: "zap",
    blurb:
      "Electrical distribution, switchgear and backup-power suppliers keeping AI datacenters energized.",
    industries: [
      "Electrical Products",
      "Electronic Components",
      "Industrial Machinery",
      "Industrial Conglomerates",
    ],
    keywords:
      /\b(power management|power infrastructure|power distribution|electrical equipment|electrical components|switchgear|transformers?|busway|uninterruptible power)\b/i,
  },
  {
    key: "cooling-thermal",
    title: "Cooling & Thermal",
    icon: "snowflake",
    blurb:
      "Liquid cooling and thermal-management suppliers solving the heat density of AI compute racks.",
    industries: [
      "Electrical Products",
      "Electronic Components",
      "Industrial Machinery",
    ],
    keywords:
      /\b(cooling|thermal management|liquid cooling|HVAC|air conditioning)\b/i,
  },
  {
    key: "datacenter-construction",
    title: "Datacenter Construction",
    icon: "crane",
    blurb:
      "Engineering and construction firms physically building out AI datacenter capacity.",
    industries: [
      "Engineering & Construction",
      "Industrial Machinery",
      "Industrial Conglomerates",
    ],
    keywords: /\bdata centers?\b/i,
  },
  {
    key: "datacenter-reits",
    title: "Datacenter REITs",
    icon: "building-2",
    blurb:
      "Landlords leasing the physical shell, power and interconnection hyperscalers build AI capacity in.",
    industries: ["Real Estate Investment Trusts", "Real Estate Development"],
    keywords: /\bdata centers?\b/i,
  },
  {
    key: "nuclear-grid-energy",
    title: "Nuclear & Grid Energy",
    icon: "radiation",
    blurb:
      "Nuclear, grid and power-generation utilities repositioned by surging AI datacenter power demand.",
    industries: [
      "Electric Utilities",
      "Alternative Power Generation",
      "Gas Distributors",
    ],
    keywords:
      /\b(nuclear|power grid|grid infrastructure|grid modernization|power generation|transmission (line|infrastructure))\b/i,
  },
  {
    key: "ai-cloud-hyperscalers",
    title: "AI Cloud & Hyperscalers",
    icon: "cloud",
    blurb:
      "Hyperscalers and cloud platforms selling AI compute and models on top of the buildout.",
    industries: [
      "Internet Software/Services",
      "Packaged Software",
      "Data Processing Services",
      "Information Technology Services",
      "Internet Retail",
    ],
    keywords:
      /\b(cloud computing|cloud infrastructure|cloud platform|hyperscalers?|large language models?)\b/i,
  },
  {
    key: "neocloud-bitcoin-miners",
    title: "NeoCloud & Bitcoin Miners",
    icon: "bitcoin",
    blurb:
      "GPU-cloud upstarts and power-rich bitcoin miners repurposing their sites for AI hosting.",
    industries: [
      "Finance/Rental/Leasing",
      "Data Processing Services",
      "Internet Software/Services",
    ],
    keywords:
      /\b(bitcoin|cryptocurrency|crypto|blockchain|digital asset mining|hash rate|GPU cloud|AI cloud|AI factor(y|ies)|high.performance computing|HPC)\b/i,
  },
  {
    key: "content-delivery-networks",
    title: "Content Delivery Networks",
    icon: "globe",
    blurb:
      "Edge-delivery networks forming the last-mile infrastructure that connects AI services to users.",
    industries: [
      "Internet Software/Services",
      "Specialty Telecommunications",
      "Information Technology Services",
    ],
    keywords: /\b(content delivery|CDN|edge network|edge delivery)\b/i,
  },
  {
    key: "rare-earths",
    title: "Rare Earths",
    icon: "pickaxe",
    blurb:
      "Critical-minerals miners and processors supplying the rare-earth inputs chip and magnet makers need.",
    industries: [
      "Other Metals/Minerals",
      "Precious Metals",
      "Steel",
      "Aluminum",
    ],
    keywords: /\brare earths?\b/i,
  },
  {
    key: "semi-materials-eda",
    title: "Semi Materials & EDA",
    icon: "flask",
    blurb:
      "Specialty materials and chip-design software forming the invisible foundation under every fab.",
    industries: [
      "Semiconductors",
      "Chemicals: Specialty",
      "Chemicals: Major Diversified",
      "Packaged Software",
    ],
    keywords:
      /\b(electronic design automation|EDA (software|tools)|semiconductor materials|silicon wafers?)\b/i,
  },
  {
    key: "industrial-edge-ai",
    title: "Industrial & Edge AI",
    icon: "settings",
    blurb:
      "Automation, robotics and machine-vision suppliers bringing AI compute out of the datacenter.",
    industries: [
      "Industrial Machinery",
      "Electronic Equipment/Instruments",
      "Industrial Conglomerates",
    ],
    keywords:
      /\b(industrial automation|edge AI|edge computing|robotics|machine vision)\b/i,
  },
  {
    key: "defense-aerospace",
    title: "Defense & Aerospace",
    icon: "shield",
    blurb:
      "Defense and aerospace primes applying AI compute to sensing, autonomy and mission systems.",
    industries: ["Aerospace & Defense"],
  },
  {
    key: "space-satellite",
    title: "Space & Satellite",
    icon: "satellite",
    blurb:
      "Launch and satellite operators building the orbital infrastructure AI applications increasingly ride on.",
    industries: [
      "Aerospace & Defense",
      "Specialty Telecommunications",
      "Telecommunications Equipment",
    ],
    keywords:
      /\b(satellites?|space (launch|infrastructure|systems)|orbital|rockets?)\b/i,
  },
  {
    key: "battery-power-storage",
    title: "Battery & Power Storage",
    icon: "battery",
    blurb:
      "Battery and energy-storage suppliers buffering the power demand AI datacenters place on the grid.",
    industries: [
      "Electrical Products",
      "Chemicals: Specialty",
      "Auto Parts: OEM",
    ],
    keywords: /\b(batter(y|ies)|energy storage|power storage)\b/i,
  },
  {
    key: "ems-supply-chain",
    title: "EMS & Supply Chain",
    icon: "boxes",
    blurb:
      "Electronics manufacturing services and contract manufacturers forming the physical supply chain behind AI hardware.",
    industries: ["Electronic Components", "Electronic Equipment/Instruments"],
    keywords:
      /\b(electronics manufacturing services|contract manufactur(er|ing)|supply chain)\b/i,
  },
  {
    key: "electrical-component-suppliers",
    title: "Electrical & Component Suppliers",
    icon: "plug",
    blurb:
      "Connector and electronic-component suppliers forming the unglamorous connective tissue of AI hardware.",
    industries: ["Electronic Components", "Electrical Products"],
    keywords:
      /\b(connectors?|electronic components|interconnect (solutions|products))\b/i,
  },
  {
    key: "fabless-specialty-semis",
    title: "Fabless & Specialty Semis",
    icon: "chip",
    blurb:
      "Mid- and small-cap fabless chip designers serving AI-adjacent workloads outside the headline GPU race.",
    industries: ["Semiconductors"],
    fallbackOnly: true,
  },
  {
    key: "speculative-emerging-tech",
    title: "Speculative & Emerging Tech",
    icon: "rocket",
    blurb:
      "Smaller AI-exposed names that don't yet fit a more specific infrastructure theme.",
    industries: [
      "Packaged Software",
      "Internet Software/Services",
      "Information Technology Services",
      "Electronic Equipment/Instruments",
    ],
    keywords: /\bartificial intelligence\b/i,
    fallbackOnly: true,
  },
];

/**
 * The `industry` this doc SHOULD have per the TV taxonomy. Almost always
 * just `c.industry` verbatim, but some docs pre-date the taxonomy migration
 * (see tv-taxonomy.ts's docblock) and still carry a raw SIC description
 * (e.g. DLR/EQIX: `"REAL ESTATE INVESTMENT TRUSTS"` instead of `"Real Estate
 * Investment Trusts"`). For those, re-derive it from `sicCode` — the same
 * derivation the sync job itself uses (`sic-tv.util.ts`) — rather than
 * either trusting the stale string or dropping the doc from every theme.
 */
function normalizedIndustry(c: Record<string, unknown>): string | null {
  const industry = c.industry;
  if (typeof industry === "string" && isTvIndustry(industry)) return industry;
  return classifyFromSic(c.sicCode as string | number | null | undefined)
    .industry;
}

/**
 * Classifies every (non-delisted) company in `companies` into its matching
 * theme(s), keyed by theme `key`. Runs against the already-cached `companies`
 * array on every request — no new sync job, no persisted classification.
 */
export function classifyAiInfrastructure(
  companies: Array<Record<string, unknown>>,
): Map<string, Array<Record<string, unknown>>> {
  const claimed = new Set<string>();
  const result = new Map<string, Array<Record<string, unknown>>>();

  for (const theme of AI_INFRASTRUCTURE_THEMES) {
    const matches = companies.filter((c) => {
      if (c.delisted === true) return false;
      const ticker = c.ticker;
      if (typeof ticker !== "string") return false;

      const industry = normalizedIndustry(c);
      if (!industry || !theme.industries.includes(industry)) return false;
      if (theme.fallbackOnly && claimed.has(ticker)) return false;
      if (!theme.keywords) return true;
      const name = typeof c.name === "string" ? c.name : "";
      const description =
        typeof c.description === "string" ? c.description : "";
      return theme.keywords.test(`${name} ${description}`);
    });

    result.set(theme.key, matches);
    if (!theme.fallbackOnly) {
      for (const m of matches) claimed.add(m.ticker as string);
    }
  }

  return result;
}
