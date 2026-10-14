// Thailand has no DST, so its UTC offset is always exactly +7 — no timezone
// database needed to compute "midnight in Bangkok" from a plain UTC Date.
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

export const EXPENSE_RANGES = ['day', 'week', 'month', 'six_months', 'year'] as const;
export type ExpenseRange = (typeof EXPENSE_RANGES)[number];

const RANGE_DAYS_BACK: Record<ExpenseRange, number> = {
  day: 0,
  week: 6,
  month: 29,
  six_months: 182,
  year: 364,
};

export function isExpenseRange(value: unknown): value is ExpenseRange {
  return typeof value === 'string' && (EXPENSE_RANGES as readonly string[]).includes(value);
}

// Returns the UTC instant corresponding to the start of the Bangkok calendar
// day `daysBack` days before today.
export function bangkokRangeStart(range: ExpenseRange): Date {
  const daysBack = RANGE_DAYS_BACK[range];
  const bangkokNow = new Date(Date.now() + BANGKOK_OFFSET_MS);
  bangkokNow.setUTCHours(0, 0, 0, 0);
  bangkokNow.setUTCDate(bangkokNow.getUTCDate() - daysBack);
  return new Date(bangkokNow.getTime() - BANGKOK_OFFSET_MS);
}

export type Granularity = 'hour' | 'day' | 'month';

// Short windows are charted finely, long ones coarsely, so the chart always
// has roughly 7-30 bars instead of 1 bar (day view) or 365 slivers (year view).
export function granularityForRange(range: ExpenseRange): Granularity {
  if (range === 'day') return 'hour';
  if (range === 'week' || range === 'month') return 'day';
  return 'month';
}

// Every bucket key from `start` through now, in Bangkok wall-clock time, so
// the chart shows zero-spend days as empty slots instead of silently skipping
// them. Keys match the to_char() formats used in the SQL.
export function bucketKeys(start: Date, granularity: Granularity): string[] {
  const cursor = new Date(start.getTime() + BANGKOK_OFFSET_MS); // UTC fields now read as Bangkok time
  const end = new Date(Date.now() + BANGKOK_OFFSET_MS);
  const keys: string[] = [];
  if (granularity === 'month') cursor.setUTCDate(1);
  while (cursor <= end) {
    const iso = cursor.toISOString();
    keys.push(granularity === 'hour' ? iso.slice(0, 13) : granularity === 'day' ? iso.slice(0, 10) : iso.slice(0, 7));
    if (granularity === 'hour') cursor.setUTCHours(cursor.getUTCHours() + 1);
    else if (granularity === 'day') cursor.setUTCDate(cursor.getUTCDate() + 1);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}
