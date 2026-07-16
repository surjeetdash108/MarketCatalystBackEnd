function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

export function* candidateTradingDays(
  from: Date,
  maxLookback = 7,
): Generator<string> {
  const cursor = new Date(from);
  let yielded = 0;
  while (yielded < maxLookback) {
    if (!isWeekend(cursor)) {
      yield toIsoDate(cursor);
      yielded++;
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
}
