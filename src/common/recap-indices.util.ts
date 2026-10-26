export interface IndexRow {
  id: string;
  label: string;
  value: number | null;
  change?: number | null;
  pctChange: number | null;
  isProxy?: boolean;
  proxyTicker?: string | null;
  unit?: string | null;
  source?: string;
}

/**
 * Ensures "Nasdaq" is the Nasdaq Composite (^IXIC), and any QQQ / NDX proxy is labeled "Nasdaq-100".
 */
export function formatRecapIndices(
  rawIndices: IndexRow[],
  ixicQuote?: { price: number; pctChange: number; change?: number } | null,
): IndexRow[] {
  const result: IndexRow[] = [];

  for (const idx of rawIndices) {
    const isQqqOrNdx = idx.id === "NDX" || idx.id === "QQQ" || idx.proxyTicker === "QQQ";
    if (isQqqOrNdx) {
      result.push({
        ...idx,
        label: "Nasdaq-100",
      });
    } else if (idx.id === "IXIC" || idx.id === "^IXIC" || idx.label === "Nasdaq" || idx.label === "Nasdaq Composite") {
      result.push({
        ...idx,
        id: "IXIC",
        label: "Nasdaq",
      });
    } else {
      result.push(idx);
    }
  }

  if (ixicQuote && ixicQuote.price != null) {
    const ixicRow: IndexRow = {
      id: "IXIC",
      label: "Nasdaq",
      value: ixicQuote.price,
      pctChange: ixicQuote.pctChange,
      change: ixicQuote.change ?? null,
      isProxy: false,
      proxyTicker: null,
      source: "fmp",
    };
    const existingIdx = result.findIndex((r) => r.id === "IXIC" || r.label === "Nasdaq");
    if (existingIdx >= 0) {
      result[existingIdx] = ixicRow;
    } else {
      const spxIdx = result.findIndex((r) => r.id === "SPX" || r.label === "S&P 500");
      if (spxIdx >= 0) {
        result.splice(spxIdx + 1, 0, ixicRow);
      } else {
        result.unshift(ixicRow);
      }
    }
  }

  return result;
}

/** FMP's Nasdaq Composite symbol (what quote pages call "Nasdaq"). */
export const NASDAQ_COMPOSITE_FMP = "^IXIC";

/**
 * The Nasdaq Composite itself, for formatRecapIndices. market_indices only
 * holds the QQQ-based Nasdaq-100 proxy, so without this the recap had no
 * "Nasdaq" row at all. The change is measured from the previous close (FMP's
 * EOD `change` is close − open: +61.39 on Oct 23 2026 against a real −53.52).
 * Null when FMP has no quote; the recap then simply omits the row.
 */
export async function nasdaqCompositeQuote(fmp: {
  getQuote(symbol: string): Promise<{ price: number; changePercentage: number; previousClose: number | null } | null>;
} | null | undefined): Promise<{ price: number; pctChange: number; change: number | null } | null> {
  const q = await fmp?.getQuote(NASDAQ_COMPOSITE_FMP).catch(() => null);
  if (!q) return null;
  return {
    price: q.price,
    pctChange: Math.round(q.changePercentage * 100) / 100,
    change: q.previousClose != null ? Math.round((q.price - q.previousClose) * 100) / 100 : null,
  };
}
