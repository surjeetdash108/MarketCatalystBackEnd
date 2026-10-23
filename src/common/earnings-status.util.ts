/**
 * Formats earnings report dates and indicates confirmation status.
 * Unconfirmed future earnings dates (e.g. NVDA Nov 18) are clearly labeled as "Estimated".
 */

export interface FormattedEarningsStatus {
  date: string | null;
  formattedDate: string | null;
  isEstimated: boolean;
  statusLabel: "Confirmed" | "Estimated" | null;
  displayText: string | null;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function formatEarningsDateStatus(params: {
  date?: string | null;
  confirmed?: boolean | null;
}): FormattedEarningsStatus {
  const { date, confirmed } = params;
  if (!date || date === "—") {
    return {
      date: null,
      formattedDate: null,
      isEstimated: false,
      statusLabel: null,
      displayText: null,
    };
  }

  // Parse YYYY-MM-DD
  const parts = date.split("-");
  let formattedDate = date;
  if (parts.length === 3) {
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const d = parseInt(parts[2], 10);
    if (m >= 0 && m < 12) {
      formattedDate = `${MONTHS[m]} ${d}, ${y}`;
    }
  }

  const isConfirmed = confirmed === true;
  const isEstimated = !isConfirmed;
  const statusLabel = isConfirmed ? "Confirmed" : "Estimated";
  const displayText = isEstimated
    ? `${formattedDate} (Estimated)`
    : formattedDate;

  return {
    date,
    formattedDate,
    isEstimated,
    statusLabel,
    displayText,
  };
}
