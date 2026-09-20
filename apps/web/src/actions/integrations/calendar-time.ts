// Turning what a button carries (a title, a start, maybe an end) into exactly one calendar event, and a look-up
// window into a start and an end. Pure functions with no imports from the rest of the actions module, so both the
// click-time check and the binding can use them without an import cycle.
//
// Rules (spec FR-049, FR-050): a title is required; a start is a real day ("2026-10-03", an all-day event) or a
// real day and time ("2026-10-03T09:30", or with a Z or +hh:mm offset); an end is optional, on the same form as the
// start, and never before it. A day with no time is an all-day event (the end, when given, is the LAST day). A timed
// start with no end lasts one hour. A time with no offset means the calendar's own time zone: it is passed through
// untouched and never guessed at. There are no guests, and nothing here can add one.
import { EVENT_DEFAULT_MINUTES, EVENT_LOCATION_CHARS, EVENT_NOTES_CHARS } from "../limits";

/** A refused event. `message` is a fixed sentence naming what is wrong, never the value that was given. */
export class EventInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventInputError";
  }
}

export interface CalendarEventArgs {
  title: string;
  /** ISO start. For an all-day event: midnight of the first day. */
  start: string;
  /** ISO end. For an all-day event: midnight AFTER the last day. */
  end: string;
  allDay: boolean;
  notes: string | null;
  location: string | null;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/;

interface Parsed {
  allDay: boolean;
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** "" (the calendar's own zone), "Z", or "+hh:mm". */
  zone: string;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function isRealDay(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function parse(text: string): Parsed | null {
  const trimmed = text.trim();
  const day = DATE.exec(trimmed);
  if (day) {
    const [y, mo, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    return isRealDay(y, mo, d) ? { allDay: true, y, mo, d, h: 0, mi: 0, s: 0, zone: "" } : null;
  }
  const dt = DATE_TIME.exec(trimmed);
  if (!dt) return null;
  const [y, mo, d, h, mi, s] = [Number(dt[1]), Number(dt[2]), Number(dt[3]), Number(dt[4]), Number(dt[5]), Number(dt[6] ?? 0)];
  if (!isRealDay(y, mo, d) || h > 23 || mi > 59 || s > 59) return null;
  const zone = dt[7] ?? "";
  if (zone !== "" && zone !== "Z") {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 14 || om > 59) return null;
  }
  return { allDay: false, y, mo, d, h, mi, s, zone };
}

/** Minutes east of UTC, or null when the time has no zone of its own. */
function offsetMinutes(zone: string): number | null {
  if (zone === "") return null;
  if (zone === "Z") return 0;
  const sign = zone[0] === "-" ? -1 : 1;
  return sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
}

/** A comparable instant: components as UTC, minus the offset when there is one. */
function instant(p: Parsed): number {
  const base = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return base - (offsetMinutes(p.zone) ?? 0) * 60_000;
}

function format(p: Parsed): string {
  return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${p.zone}`;
}

function addMinutes(p: Parsed, minutes: number): Parsed {
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi + minutes, p.s));
  return { ...p, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
}

const nextDay = (p: Parsed): Parsed => addMinutes({ ...p, h: 0, mi: 0, s: 0 }, 24 * 60);

function text(value: unknown, name: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new EventInputError(`"${name}" has to be text.`);
  if (value.length > max) throw new EventInputError(`"${name}" is too long (at most ${max} characters).`);
  return value.trim() === "" ? null : value;
}

/**
 * The one event a button will create, or an EventInputError saying what is wrong (a missing title, a day or time that
 * is not real, an end before the start, or a start and end on different forms). Nothing is created or guessed.
 */
export function eventFromArgs(args: Record<string, unknown>): CalendarEventArgs {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) throw new EventInputError('"title" is required.');
  if (typeof args.start !== "string") throw new EventInputError('"start" is required.');
  const start = parse(args.start);
  if (!start) throw new EventInputError('"start" is not a real day or time (use 2026-10-03 or 2026-10-03T09:30).');

  let end: Parsed;
  if (args.end === undefined || args.end === null || args.end === "") {
    end = start.allDay ? nextDay(start) : addMinutes(start, EVENT_DEFAULT_MINUTES);
  } else {
    if (typeof args.end !== "string") throw new EventInputError('"end" has to be text.');
    const given = parse(args.end);
    if (!given) throw new EventInputError('"end" is not a real day or time (use 2026-10-03 or 2026-10-03T10:30).');
    if (given.allDay !== start.allDay) throw new EventInputError('"start" and "end" have to both be a day, or both be a day and time.');
    if (!start.allDay && (offsetMinutes(given.zone) === null) !== (offsetMinutes(start.zone) === null)) {
      throw new EventInputError('"start" and "end" have to use the same time format (both with an offset like Z, or both without).');
    }
    end = start.allDay ? nextDay(given) : given; // an all-day end is the LAST day; the calendar wants midnight after it
  }
  if (instant(end) <= instant(start)) throw new EventInputError('"end" has to be after "start".');

  return {
    title,
    start: format(start),
    end: format(end),
    allDay: start.allDay,
    notes: text(args.notes, "notes", EVENT_NOTES_CHARS),
    location: text(args.location, "location", EVENT_LOCATION_CHARS),
  };
}

/** The window a calendar look-up covers: from the start of `day` (today when absent) for `days` days. */
export function listWindow(day: unknown, days: number, today: Date = new Date()): { start: string; end: string } {
  let p: Parsed;
  if (day === undefined || day === null || day === "") {
    p = { allDay: true, y: today.getUTCFullYear(), mo: today.getUTCMonth() + 1, d: today.getUTCDate(), h: 0, mi: 0, s: 0, zone: "Z" };
  } else {
    const parsed = typeof day === "string" ? DATE.exec(day.trim()) : null;
    if (!parsed || !isRealDay(Number(parsed[1]), Number(parsed[2]), Number(parsed[3]))) {
      throw new EventInputError('"day" is not a real day (use 2026-10-03).');
    }
    p = { allDay: true, y: Number(parsed[1]), mo: Number(parsed[2]), d: Number(parsed[3]), h: 0, mi: 0, s: 0, zone: "Z" };
  }
  return { start: format({ ...p, zone: "Z" }), end: format({ ...addMinutes(p, days * 24 * 60), zone: "Z" }) };
}
