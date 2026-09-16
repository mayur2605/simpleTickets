/**
 * Business calendar for response deadlines (R16, R17).
 *
 * Working week: Monday–Saturday, 09:00–18:00 Asia/Kolkata. Sunday is the only
 * non-working day; public holidays follow the ordinary schedule for now, per
 * the first-version exclusions in docs/foundation.md.
 *
 * Instants are UTC in and UTC out. Wall-clock reasoning happens only inside
 * this module, and the zone offset is read from the platform time zone
 * database rather than hardcoded, so a future offset change stays correct.
 *
 * This module is deliberately free of React, storage and transport, and takes
 * every instant as an argument rather than reading a clock, so callers and
 * tests control time.
 */

const TIME_ZONE = "Asia/Kolkata";

export const WORK_START_HOUR = 9;
export const WORK_END_HOUR = 18;
export const RESPONSE_HOURS = 4;

/** R17: a Sunday message starting a new response episode is due Monday 12:00. */
export const SUNDAY_EPISODE_DEADLINE_HOUR = 12;

const MINUTES_PER_HOUR = 60;
const WORK_START_MINUTE = WORK_START_HOUR * MINUTES_PER_HOUR;
const WORK_END_MINUTE = WORK_END_HOUR * MINUTES_PER_HOUR;
const SUNDAY = 0;

/** A wall-clock reading in TIME_ZONE. Month is 1-based. */
interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const zoneFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function requirePart(parts: Map<string, string>, key: string): number {
  const raw = parts.get(key);
  if (raw === undefined) {
    throw new Error(`Time zone data for ${TIME_ZONE} is missing "${key}".`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(
      `Time zone data for ${TIME_ZONE} gave a non-numeric ${key}.`,
    );
  }
  return value;
}

function wallTime(instant: Date): Wall {
  const parts = new Map<string, string>();
  for (const part of zoneFormat.formatToParts(instant)) {
    parts.set(part.type, part.value);
  }
  return {
    year: requirePart(parts, "year"),
    month: requirePart(parts, "month"),
    day: requirePart(parts, "day"),
    hour: requirePart(parts, "hour"),
    minute: requirePart(parts, "minute"),
  };
}

/** Offset of TIME_ZONE from UTC at a given instant, in milliseconds. */
function zoneOffsetMs(instant: Date): number {
  const wall = wallTime(instant);
  const asIfUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
  );
  // formatToParts drops sub-minute precision, so compare on whole minutes.
  const flooredInstant = Math.floor(instant.getTime() / 60_000) * 60_000;
  return asIfUtc - flooredInstant;
}

function toInstant(wall: Wall): Date {
  const asIfUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
  );
  // Resolve with the offset in force at the target instant, not at the
  // caller's instant: one correction settles it for any fixed-offset zone,
  // and for a DST zone it settles everything outside the transition hour.
  const firstGuess = asIfUtc - zoneOffsetMs(new Date(asIfUtc));
  return new Date(asIfUtc - zoneOffsetMs(new Date(firstGuess)));
}

/** 0 = Sunday … 6 = Saturday, for the wall-clock date. */
function weekday(wall: Wall): number {
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

function isWorkingDay(wall: Wall): boolean {
  return weekday(wall) !== SUNDAY;
}

function minuteOfDay(wall: Wall): number {
  return wall.hour * MINUTES_PER_HOUR + wall.minute;
}

function atWorkStart(wall: Wall): Wall {
  return { ...wall, hour: WORK_START_HOUR, minute: 0 };
}

function nextDayAtWorkStart(wall: Wall): Wall {
  const next = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: WORK_START_HOUR,
    minute: 0,
  };
}

/**
 * The first working moment at or after `wall`: unchanged if already inside a
 * working window, otherwise the start of the next working window.
 */
function nextWorkingMoment(wall: Wall): Wall {
  let cursor = wall;
  // Sunday is the only closed day, so this settles within two iterations. The
  // bound guards against a future calendar change turning this into a loop.
  for (let guard = 0; guard < 14; guard += 1) {
    if (!isWorkingDay(cursor)) {
      cursor = nextDayAtWorkStart(cursor);
      continue;
    }
    const minute = minuteOfDay(cursor);
    if (minute < WORK_START_MINUTE) return atWorkStart(cursor);
    if (minute >= WORK_END_MINUTE) {
      cursor = nextDayAtWorkStart(cursor);
      continue;
    }
    return cursor;
  }
  throw new Error("No working day found within two weeks of the start time.");
}

/**
 * Advance `from` by `hours` of working time. A zero interval returns the next
 * working moment, so an after-hours arrival reports the start of the next
 * window. R18 reminder intervals use this too.
 */
export function addWorkingHours(from: Date, hours: number): Date {
  if (!Number.isFinite(hours) || hours < 0) {
    throw new RangeError("hours must be a non-negative finite number.");
  }
  let cursor = nextWorkingMoment(wallTime(from));
  let remaining = Math.round(hours * MINUTES_PER_HOUR);
  // Each pass consumes at most one working day, so the bound covers well over
  // a year of working hours.
  for (let guard = 0; remaining > 0 && guard < 400; guard += 1) {
    const available = WORK_END_MINUTE - minuteOfDay(cursor);
    if (remaining <= available) {
      const target = minuteOfDay(cursor) + remaining;
      cursor = {
        ...cursor,
        hour: Math.floor(target / MINUTES_PER_HOUR),
        minute: target % MINUTES_PER_HOUR,
      };
      remaining = 0;
      break;
    }
    remaining -= available;
    cursor = nextWorkingMoment(nextDayAtWorkStart(cursor));
  }
  if (remaining > 0) {
    throw new RangeError("hours exceeds the supported scheduling horizon.");
  }
  return toInstant(cursor);
}

/**
 * When an IT response is due for a message that starts a new response episode
 * (R16). A Sunday arrival gets the fixed Monday 12:00 deadline of R17 rather
 * than four working hours.
 */
export function responseDeadline(arrival: Date): Date {
  const wall = wallTime(arrival);
  if (weekday(wall) === SUNDAY) {
    return toInstant({
      ...nextDayAtWorkStart(wall),
      hour: SUNDAY_EPISODE_DEADLINE_HOUR,
      minute: 0,
    });
  }
  return addWorkingHours(arrival, RESPONSE_HOURS);
}

/**
 * The deadline in force after a message arrives. A later message never
 * postpones an earlier unanswered deadline (R16, R17), so the earlier of the
 * two always wins.
 */
export function pendingDeadline(existing: Date | null, arrival: Date): Date {
  const fresh = responseDeadline(arrival);
  if (existing === null) return fresh;
  return existing.getTime() <= fresh.getTime() ? existing : fresh;
}
