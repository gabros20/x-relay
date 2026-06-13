// Port of twitter-cli's timeutil: parse Twitter's "created_at" timestamp format.
// Pattern: "EEE MMM dd HH:mm:ss xx yyyy"
// Example: "Wed Jun 10 16:06:30 +0000 2026"
//
// Rules:
//   - On valid input → formatted string.
//   - On unparseable non-empty input → raw input string (passthrough, twitter-cli behaviour).
//   - On empty / undefined input → undefined.

const MONTH_MAP: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

// "Wed Jun 10 16:06:30 +0000 2026"
// Groups: weekday  month  day  HH   MM   SS   tz    year
const TWITTER_DATE_RE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}) (\d{4})$/;

interface ParsedDate {
  year: number;
  month: number; // 0-based
  day: number;
  hour: number;
  minute: number;
  second: number;
  offsetMinutes: number; // total offset from UTC in minutes
}

function parseTwitterDate(createdAt: string): ParsedDate | null {
  const m = TWITTER_DATE_RE.exec(createdAt);
  if (!m) return null;

  const [, monthStr, dayStr, hourStr, minStr, secStr, tzStr, yearStr] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const month = MONTH_MAP[monthStr];
  if (month === undefined) return null;

  const year = Number(yearStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minStr);
  const second = Number(secStr);

  // Parse timezone offset: "+0000" or "-0530" etc.
  const tzSign = tzStr[0] === '-' ? -1 : 1;
  const tzHours = Number(tzStr.slice(1, 3));
  const tzMins = Number(tzStr.slice(3, 5));
  const offsetMinutes = tzSign * (tzHours * 60 + tzMins);

  return { year, month, day, hour, minute, second, offsetMinutes };
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Parse a Twitter created_at string and return epoch milliseconds (UTC).
 * Example: "Wed Jun 10 16:06:30 +0000 2026" → 1749571590000
 *
 * On unparseable non-empty input, returns undefined.
 * On empty / undefined input, returns undefined.
 */
export function parseTwitterDateMs(createdAt: string): number | undefined {
  if (!createdAt) return undefined;

  const parsed = parseTwitterDate(createdAt);
  if (!parsed) return undefined;

  const { year, month, day, hour, minute, second, offsetMinutes } = parsed;

  // Convert to UTC: subtract the local offset so the result is always UTC ms.
  return Date.UTC(year, month, day, hour, minute, second) - offsetMinutes * 60_000;
}

/**
 * Parse a Twitter created_at string and return an ISO 8601 string.
 * Example: "Wed Jun 10 16:06:30 +0000 2026" → "2026-06-10T16:06:30+00:00"
 *
 * On unparseable non-empty input, returns the raw input string.
 * On empty / undefined input, returns undefined.
 */
export function formatIso8601(createdAt: string): string | undefined {
  if (!createdAt) return undefined;

  const parsed = parseTwitterDate(createdAt);
  if (!parsed) return createdAt;

  const { year, month, day, hour, minute, second, offsetMinutes } = parsed;

  const monthNum = month + 1;
  const absOffset = Math.abs(offsetMinutes);
  const offH = Math.floor(absOffset / 60);
  const offM = absOffset % 60;
  const offSign = offsetMinutes < 0 ? '-' : '+';
  const offStr = `${offSign}${pad2(offH)}:${pad2(offM)}`;

  return `${year}-${pad2(monthNum)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}${offStr}`;
}

/**
 * Parse a Twitter created_at string and return "YYYY-MM-DD HH:mm" in local time.
 * Example (UTC): "Wed Jun 10 16:06:30 +0000 2026" → "2026-06-10 16:06"
 *
 * On unparseable non-empty input, returns the raw input string.
 * On empty / undefined input, returns undefined.
 */
export function formatLocal(createdAt: string): string | undefined {
  if (!createdAt) return undefined;

  const parsed = parseTwitterDate(createdAt);
  if (!parsed) return createdAt;

  const { year, month, day, hour, minute, second, offsetMinutes } = parsed;

  // Convert to UTC epoch milliseconds, then adjust for local TZ via Date.
  const utcMs = Date.UTC(year, month, day, hour, minute, second) - offsetMinutes * 60_000;

  const local = new Date(utcMs);

  const y = local.getFullYear();
  const mo = pad2(local.getMonth() + 1);
  const d = pad2(local.getDate());
  const h = pad2(local.getHours());
  const mi = pad2(local.getMinutes());

  return `${y}-${mo}-${d} ${h}:${mi}`;
}
