/**
 * Pure FMP → Polygon-shape mapping helpers for MarketDataService.
 *
 * Every consumer in this codebase reads Polygon's shapes (PolygonAggBar,
 * ticker-details field names, Polygon status vocabularies). The router fetches
 * from FMP first and maps INTO those shapes here, so no consumer changes.
 */

const HOUR_MS = 3_600_000;

const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
});

export interface EtParts {
  date: string; // YYYY-MM-DD
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** ET calendar date / clock for an instant. */
export function etParts(ms: number): EtParts {
  const p: Record<string, string> = {};
  for (const part of ET_FMT.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    weekday: WEEKDAYS.indexOf(p.weekday),
  };
}

// Offset memo keyed by "YYYY-MM-DD HH" — a 30-minute doc maps ~8k bars and
// Intl formatting per bar is the slow part. US DST changes on a whole hour.
const offsetMemo = new Map<string, number>();

/**
 * FMP stamps intraday bars in ET WALL-CLOCK time with no offset
 * ("2026-10-16 12:45:00"). Returns the epoch ms of that ET wall time.
 */
export function etWallToEpochMs(wall: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(wall.trim());
  if (!m) return NaN;
  const [, y, mo, d, hh = "00", mi = "00", ss = "00"] = m;
  const naive = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
  const key = `${y}-${mo}-${d} ${hh}`;
  const hit = offsetMemo.get(key);
  if (hit !== undefined) return naive + hit;
  // ET is UTC−4 (EDT) or UTC−5 (EST): pick the offset whose instant reads back
  // as the same ET date + hour.
  for (const offH of [4, 5]) {
    const t = naive + offH * HOUR_MS;
    const p = etParts(t);
    if (p.date === `${y}-${mo}-${d}` && p.hour === +hh) {
      if (offsetMemo.size > 50_000) offsetMemo.clear();
      offsetMemo.set(key, offH * HOUR_MS);
      return t;
    }
  }
  // Non-existent wall time (the DST spring-forward hour) — EST is the safe guess.
  return naive + 5 * HOUR_MS;
}

/** Midnight ET of a YYYY-MM-DD date — the `t` Polygon stamps on daily bars. */
export const etMidnightMs = (date: string): number => etWallToEpochMs(`${date.slice(0, 10)} 00:00:00`);

/** Tickers routed straight to Polygon: indices (I:), options (O:), crypto (X:), FX (C:). */
export const isPolygonOnlyTicker = (ticker: string): boolean => ticker.includes(":");

/** Polygon writes class shares with a dot (BRK.B); FMP with a dash (BRK-B). */
export const toFmpSymbol = (ticker: string): string => ticker.toUpperCase().replace(/\.([A-Z]{1,2})$/, "-$1");

export const fromFmpSymbol = (symbol: string): string => symbol.replace(/-([A-Z]{1,2})$/, ".$1");

/**
 * FMP's calendars/bulk files are GLOBAL (".TO", ".HK", "^GSPC", "600000.SS").
 * A US listing is 1–5 letters, optionally a 1–2 letter class suffix.
 */
export const isUsSymbol = (symbol: string): boolean => /^[A-Z]{1,5}(-[A-Z]{1,2})?$/.test(symbol);

/** Polygon's integer dividend frequency (payments/year; 0 = one-time). */
export function frequencyToNumber(freq: unknown): number | null {
  switch (String(freq ?? "").toLowerCase()) {
    case "monthly": return 12;
    case "quarterly": return 4;
    case "semi-annual":
    case "semiannual": return 2;
    case "annual":
    case "annually": return 1;
    case "irregular":
    case "special":
    case "one-time":
    case "onetime": return 0;
    default: return null;
  }
}

/** Polygon's frequency LABEL vocabulary (dividends calendar). */
export function frequencyToLabel(freq: unknown): string | null {
  switch (frequencyToNumber(freq)) {
    case 12: return "Monthly";
    case 4: return "Quarterly";
    case 2: return "Semi-Annual";
    case 1: return "Annual";
    case 0: return "One-Time";
    default: return null;
  }
}

/** Polygon dividend_type: "SC" special cash for irregular payouts, else "CD". */
export const dividendTypeFor = (freq: unknown): string => (frequencyToNumber(freq) === 0 ? "SC" : "CD");

/**
 * FMP IPO `actions` → Polygon `ipo_status` (the vocabulary the IPO screen
 * keys its labels and colours on: pending / priced / history / withdrawn …).
 */
export function ipoStatusFor(action: unknown, date: string, today: string): string {
  const a = String(action ?? "").toLowerCase();
  if (a.includes("withdraw")) return "withdrawn";
  if (a.includes("postpone")) return "postponed";
  if (a.includes("priced")) return date && date < today ? "history" : "priced";
  if (a.includes("expected") || a.includes("filed") || a.includes("amended")) return "pending";
  return a || "pending";
}

/** FMP "5 - 7" / "5" / null → Polygon-style "5-7" / "5" / null. */
export function normalizePriceRange(range: unknown): { price: string | null; single: number | null } {
  if (range == null) return { price: null, single: null };
  const nums = String(range).match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (nums.length === 0) return { price: null, single: null };
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return lo === hi ? { price: String(lo), single: lo } : { price: `${lo}-${hi}`, single: null };
}

/** FMP exchange short name → the MIC Polygon puts in `primary_exchange`. */
export function exchangeToMic(exchange: unknown): string | null {
  const e = String(exchange ?? "").toUpperCase().replace(/\s+/g, "");
  if (!e) return null;
  if (e.startsWith("NASDAQ")) return "XNAS";
  if (e === "NYSEARCA" || e === "ARCA") return "ARCX";
  if (e === "AMEX" || e === "NYSEAMERICAN" || e === "NYSEMKT") return "XASE";
  if (e.startsWith("NYSE")) return "XNYS";
  if (e === "BATS" || e === "CBOE") return "BATS";
  if (e.startsWith("OTC") || e === "PNK") return "OTC";
  return e;
}

export interface CsvBar {
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Parses FMP's `eod-bulk` CSV ("symbol","date","open","low","high","close","adjClose","volume"). */
export function parseEodBulkCsv(csv: string): CsvBar[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.replace(/"/g, "").trim());
  const idx = (name: string) => header.indexOf(name);
  const iSym = idx("symbol"), iDate = idx("date"), iO = idx("open"), iH = idx("high"),
    iL = idx("low"), iC = idx("close"), iV = idx("volume");
  if ([iSym, iDate, iO, iH, iL, iC, iV].some((i) => i < 0)) return [];
  const out: CsvBar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",").map((v) => v.replace(/"/g, "").trim());
    const bar = {
      symbol: f[iSym],
      date: f[iDate],
      open: Number(f[iO]),
      high: Number(f[iH]),
      low: Number(f[iL]),
      close: Number(f[iC]),
      volume: Number(f[iV]),
    };
    if (bar.symbol && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) out.push(bar);
  }
  return out;
}

/** US equity session phase at an instant, by the ET clock (holidays handled by the caller). */
export type SessionPhase = "pre" | "open" | "post" | "closed";

export function sessionPhase(ms: number, closeMinute = 16 * 60): SessionPhase {
  const p = etParts(ms);
  if (p.weekday === 0 || p.weekday === 6) return "closed";
  const min = p.hour * 60 + p.minute;
  if (min >= 4 * 60 && min < 9 * 60 + 30) return "pre";
  if (min >= 9 * 60 + 30 && min < closeMinute) return "open";
  if (min >= closeMinute && min < 20 * 60) return "post";
  return "closed";
}
