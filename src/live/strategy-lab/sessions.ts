/** ET calendar helpers shared by the Strategy Lab daily job and the live /bars path. */

const DAY = 86_400_000;

export const etDay = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(
    new Date(ms),
  );
export const etHm = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
export const isWeekday = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5;
};

/** Latest session whose daily bar is final: today after 16:15 ET on a weekday, else the previous weekday. */
export function lastCompletedSession(now = Date.now()): string {
  let day = etDay(now);
  if (!(isWeekday(day) && etHm(now) >= "16:15")) {
    do
      day = new Date(Date.parse(`${day}T12:00:00Z`) - DAY)
        .toISOString()
        .slice(0, 10);
    while (!isWeekday(day));
  }
  return day;
}
