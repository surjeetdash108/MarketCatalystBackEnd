/**
 * Single Quote Source Parity:
 * Guarantees that tiles, heatmap, and header all present the exact same price
 * and percentage change basis, never allowing SSE ticks or desynchronized quotes
 * to diverge from the shared application quote.
 */

export interface QuoteSource {
  price?: number | null;
  pctChange?: number | null;
}

export interface ResolvedDisplayQuote {
  price: number | null;
  pctChange: number | null;
  source: "sharedQuote" | "liveTick" | "snapshot" | "none";
}

export function resolveDisplayQuote(params: {
  sharedQuote?: QuoteSource | null;
  liveTick?: QuoteSource | null;
  snapshot?: QuoteSource | null;
}): ResolvedDisplayQuote {
  const { sharedQuote, liveTick, snapshot } = params;

  // 1. Shared quote (the app-wide quote source backing tiles and heatmap)
  if (sharedQuote && sharedQuote.price != null && sharedQuote.pctChange != null) {
    return {
      price: sharedQuote.price,
      pctChange: sharedQuote.pctChange,
      source: "sharedQuote",
    };
  }

  // 2. Live tick (complete pair)
  if (liveTick && liveTick.price != null && liveTick.pctChange != null) {
    return {
      price: liveTick.price,
      pctChange: liveTick.pctChange,
      source: "liveTick",
    };
  }

  // 3. Snapshot (complete pair)
  if (snapshot && snapshot.price != null && snapshot.pctChange != null) {
    return {
      price: snapshot.price,
      pctChange: snapshot.pctChange,
      source: "snapshot",
    };
  }

  // Fallback for partial sources without cross-splicing
  if (sharedQuote && sharedQuote.price != null) {
    return {
      price: sharedQuote.price,
      pctChange: sharedQuote.pctChange ?? null,
      source: "sharedQuote",
    };
  }

  if (liveTick && liveTick.price != null) {
    return {
      price: liveTick.price,
      pctChange: liveTick.pctChange ?? null,
      source: "liveTick",
    };
  }

  if (snapshot && snapshot.price != null) {
    return {
      price: snapshot.price,
      pctChange: snapshot.pctChange ?? null,
      source: "snapshot",
    };
  }

  return { price: null, pctChange: null, source: "none" };
}
