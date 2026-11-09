/**
 * SIMULATED sales tax for the FAKE billing provider only — not tax advice and
 * never used with a real provider (Stripe computes tax with Stripe Tax).
 * Rates are illustrative combined state+local rates in basis points.
 */
export const SIMULATED_TAX_RATES_BPS: Record<string, Record<string, number>> = {
  US: {
    TX: 825, // SIMULATED: 6.25% state + 2% local
    CA: 725, // SIMULATED
    NY: 800, // SIMULATED
    WA: 650, // SIMULATED
  },
};

export function simulatedTax(
  country: string,
  state: string | null,
  taxableMinor: number,
): { tax: number; label: string | null } {
  const bps =
    SIMULATED_TAX_RATES_BPS[country?.toUpperCase()]?.[
      String(state ?? "").toUpperCase()
    ];
  if (!bps || taxableMinor <= 0) return { tax: 0, label: null };
  return {
    tax: Math.round((taxableMinor * bps) / 10_000),
    label: `Sales tax (${String(state).toUpperCase()}, simulated)`,
  };
}
