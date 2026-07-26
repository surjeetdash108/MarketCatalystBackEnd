export const TICKER_UNIVERSE: string[] = [
  'AAPL', 'ABBV', 'ABT', 'ACM', 'ADBE', 'ADSK', 'AEP', 'AFL', 'AIG', 'ALB',
  'ALL', 'ALNY', 'AMAT', 'AMD', 'AMGN', 'AMT', 'AMZN', 'ANGI', 'APD', 'APP',
  'ARE', 'AVB', 'AVGO', 'AXP', 'BABA', 'BAC', 'BDX', 'BIDU', 'BIIB', 'BKNG',
  'BKR', 'BMY', 'BSX', 'BX', 'C', 'CAT', 'CB', 'CE', 'CFG', 'CHWY',
  'CI', 'CL', 'CMG', 'COP', 'COST', 'CP', 'CPRI', 'CRM', 'CRWD', 'CSCO',
  'CVS', 'CVX', 'CYBR', 'D', 'DD', 'DDOG', 'DELL', 'DG', 'DHR', 'DLR',
  'DOW', 'DUK', 'DVA', 'DVN', 'EBAY', 'ED', 'EMR', 'EOG', 'EQH', 'EQIX',
  'EQR', 'ETN', 'ETSY', 'EW', 'EXC', 'F', 'FCX', 'FITB', 'FTNT', 'GD',
  'GE', 'GEN', 'GILD', 'GIS', 'GL', 'GM', 'GOOG', 'GOOGL', 'GOOS', 'GS',
  'HAL', 'HBAN', 'HD', 'HIG', 'HLT', 'HON', 'HOOD', 'HP', 'HUBS', 'HUM',
  'IBM', 'ILMN', 'INTC', 'INTU', 'IP', 'IQV', 'ISRG', 'ITW', 'JD', 'JNJ',
  'JPM', 'KEY', 'KHC', 'KKR', 'KLAC', 'KMB', 'KO', 'LCID', 'LIN', 'LLY',
  'LMT', 'LOW', 'LRCX', 'LULU', 'LYFT', 'MA', 'MAR', 'MCD', 'MCO', 'MDB',
  'MDT', 'MELI', 'MET', 'META', 'MKC', 'MMM', 'MO', 'MOS', 'MPC', 'MPWR',
  'MRK', 'MRNA', 'MRVL', 'MS', 'MSFT', 'MTB', 'MTCH', 'MU', 'NEE', 'NEM',
  'NET', 'NFLX', 'NIO', 'NKE', 'NOC', 'NOW', 'NUE', 'NVDA', 'O', 'OKTA',
  'ON', 'ORCL', 'OXY', 'PANW', 'PARA', 'PCG', 'PDD', 'PEG', 'PEP', 'PFE',
  'PG', 'PH', 'PINS', 'PLD', 'PLTR', 'PM', 'PNC', 'PRU', 'PSA', 'PSX',
  'PTON', 'QCOM', 'RACE', 'RBLX', 'RDDT', 'REGN', 'RF', 'RIVN', 'RMD', 'RTX',
  'S', 'SAP', 'SBUX', 'SCHW', 'SHOP', 'SHW', 'SLB', 'SMCI', 'SNAP', 'SNOW',
  'SO', 'SOFI', 'SPG', 'SPOT', 'SRE', 'STLA', 'SYK', 'SYY', 'TEAM', 'TFC',
  'TGT', 'TJX', 'TM', 'TMO', 'TRV', 'TSLA', 'TSM', 'TXN', 'UBER', 'UBS',
  'UNH', 'UPS', 'USB', 'V', 'VLO', 'VRTX', 'VTR', 'W', 'WBA', 'WDAY',
  'WDC', 'WELL', 'WFC', 'WMT', 'WY', 'XOM', 'YELP', 'ZBH', 'ZI', 'ZIM',
  'ZS',
];

/**
 * DYNAMIC universe — the on-demand redesign (2026-07-24).
 *
 * The fixed list above is no longer the sync target; it survives only as a
 * reference/seed. Per-ticker jobs now iterate the `companies` collection ids:
 * post-reset that collection contains exactly the tickers users have actually
 * touched (grown by the on-demand endpoints) plus what the premarket warm
 * seeded (tape universe + every user's watchlist/portfolio tickers +
 * `ticker_usage` hot list). An empty list is VALID — no usage yet means
 * nothing to sync and nothing to pay for.
 */
import type { Firestore } from 'firebase-admin/firestore';

export async function activeUniverse(firestore: Firestore): Promise<string[]> {
  const snap = await firestore.collection('companies').select().get();
  return snap.docs.map((d) => d.id).sort();
}
