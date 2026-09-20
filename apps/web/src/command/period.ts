// Turns the interpreter's small period vocabulary into a [start, end) pair of instants in the PERSON's time
// zone (specs/011-global-command-bar/research.md 10). The model never computes a date: it says "yesterday",
// "last_week", "weekday tuesday", or a calendar date, and this file does the arithmetic. Weeks run Monday to
// Sunday. Pure: no database, no clock of its own (the caller passes `now`), no date library.
import { todayIn } from "./prompt";
import type { InterpretedPeriod } from "./validate";

export type PeriodResult = { start: Date; end: Date; label: string } | { future: true };

const MONDAY_FIRST = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** How far ahead of UTC the zone is at an instant, in milliseconds (positive east of Greenwich). */
function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a local calendar day (`YYYY-MM-DD`) begins. The offset is settled twice: the offset at the naive
 * guess can differ from the offset at the real midnight when a daylight-saving change falls in between.
 */
function startOfLocalDay(date: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(guess, timeZone);
  return new Date(guess - offsetMs(first, timeZone));
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const long = (date: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(new Date(`${date}T12:00:00Z`));

/** "Saturday, September 19" */
const dayLabel = (date: string) => `${long(date, { weekday: "long" })}, ${long(date, { month: "long", day: "numeric" })}`;

/** "September 14 to 20", or "December 28 to January 3" across a month. */
function spanLabel(first: string, last: string): string {
  const [a, b] = [long(first, { month: "long", day: "numeric" }), long(last, { month: "long", day: "numeric" })];
  return first.slice(0, 7) === last.slice(0, 7) ? `${a} to ${b.split(" ")[1]}` : `${a} to ${b}`;
}

export function resolvePeriod(period: InterpretedPeriod, now: Date, timeZone: string): PeriodResult {
  const today = todayIn(now, timeZone);
  const day = (date: string, label: string): PeriodResult => ({ start: startOfLocalDay(date, timeZone), end: startOfLocalDay(addDays(date, 1), timeZone), label });
  const span = (first: string, lastInclusive: string, label: string): PeriodResult => ({
    start: startOfLocalDay(first, timeZone),
    end: startOfLocalDay(addDays(lastInclusive, 1), timeZone),
    label: `${label} (${spanLabel(first, lastInclusive)})`,
  });
  const monday = addDays(today.date, -MONDAY_FIRST.indexOf(today.weekday));

  switch (period.kind) {
    case "today":
      return day(today.date, `today (${dayLabel(today.date)})`);
    case "yesterday": {
      const date = addDays(today.date, -1);
      return day(date, `yesterday (${dayLabel(date)})`);
    }
    case "this_week":
      return span(monday, addDays(monday, 6), "this week");
    case "last_week":
      return span(addDays(monday, -7), addDays(monday, -1), "last week");
    case "last_7_days":
      return span(addDays(today.date, -6), today.date, "the last 7 days");
    case "weekday": {
      // The most recent such weekday strictly before today.
      const target = MONDAY_FIRST.indexOf(period.weekday ?? "");
      const delta = ((MONDAY_FIRST.indexOf(today.weekday) - target + 7) % 7) || 7;
      const date = addDays(today.date, -delta);
      return day(date, dayLabel(date));
    }
    case "date": {
      const date = period.date ?? today.date;
      if (date > today.date) return { future: true };
      return day(date, dayLabel(date));
    }
  }
}
