// Calendar arithmetic for Bulgaria. Pure functions, no DOM and no network:
// Monday-first ISO weeks, DD.MM.YYYY dates, 24-hour time, the Europe/Sofia
// time zone with its daylight-saving rules, and the official holidays of the
// Labour Code (art. 154) including the Orthodox Easter days and the days off
// that make up for holidays falling on a weekend.
//
// Dates are plain strings: "YYYY-MM-DD" for a day, "YYYY-MM-DDTHH:MM" for a
// moment on the clock in Sofia. All arithmetic goes through UTC, so the time
// zone of the browser never influences a result.

export const TIME_ZONE = 'Europe/Sofia';
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY = 86_400_000;
const pad = (value, length = 2) => String(value).padStart(length, '0');

// -- days ---------------------------------------------------------------------------

export function isoDate(year, month, day) {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** { year, month (1–12), day } of a date or date-time string. */
export function parts(value) {
  return { year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)), day: Number(value.slice(8, 10)) };
}

function utc(value) {
  const { year, month, day } = parts(value);
  return Date.UTC(year, month - 1, day);
}

function fromUtc(ms) {
  const date = new Date(ms);
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** A real calendar day? ("2026-02-30" is not.) */
export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return fromUtc(utc(value)) === value;
}

export function addDays(value, count) {
  return fromUtc(utc(value) + count * DAY);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from, to) {
  return Math.round((utc(to) - utc(from)) / DAY);
}

/** Day of the week, Monday = 1 … Sunday = 7 (ISO 8601). */
export function weekday(value) {
  return ((new Date(utc(value)).getUTCDay() + 6) % 7) + 1;
}

export function isWeekend(value) {
  return weekday(value) >= 6;
}

export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year, month) {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** Same day of the month `count` months away, clamped to the month's length. */
export function addMonths(value, count) {
  const { year, month, day } = parts(value);
  const index = year * 12 + (month - 1) + count;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12 + 12) % 12 + 1;
  return isoDate(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
}

/** The Monday of the week that contains the day. */
export function startOfWeek(value) {
  return addDays(value, 1 - weekday(value));
}

// -- ISO weeks ------------------------------------------------------------------------

/**
 * ISO 8601 week: weeks start on Monday and week 1 is the one with the year's
 * first Thursday. The first days of January can therefore belong to week 52
 * or 53 of the year before, and the last days of December to week 1 of the
 * year after — `year` is the week-numbering year, not the calendar year.
 */
export function isoWeek(value) {
  const thursday = utc(addDays(value, 4 - weekday(value)));
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY / 7) + 1;
  return { year, week };
}

/** 52 or 53. */
export function weeksInYear(year) {
  return isoWeek(isoDate(year, 12, 28)).week;
}

/** The Monday of an ISO week. */
export function weekStart(year, week) {
  return addDays(startOfWeek(isoDate(year, 1, 4)), (week - 1) * 7);
}

/** The weeks that cover a month: [{ year, week, days: [7 dates] }, …]. */
export function monthWeeks(year, month) {
  const weeks = [];
  const last = isoDate(year, month, daysInMonth(year, month));
  for (let monday = startOfWeek(isoDate(year, month, 1)); monday <= last; monday = addDays(monday, 7)) {
    weeks.push({ ...isoWeek(monday), days: Array.from({ length: 7 }, (_, index) => addDays(monday, index)) });
  }
  return weeks;
}

// -- holidays --------------------------------------------------------------------------

/**
 * Orthodox Easter Sunday as a date of the civil (Gregorian) calendar.
 * The date is found in the Julian calendar (Meeus) and moved by the
 * difference between the two calendars — 13 days from 1900 to 2099.
 */
export function orthodoxEaster(year) {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  const shift = Math.floor(year / 100) - Math.floor(year / 400) - 2;
  return addDays(isoDate(year, month, day), shift);
}

const FIXED_HOLIDAYS = [
  [1, 1, 'Нова година', 'New Year’s Day'],
  [3, 3, 'Ден на Освобождението на България', 'Liberation Day (national holiday)'],
  [5, 1, 'Ден на труда', 'Labour Day'],
  [5, 6, 'Гергьовден, Ден на храбростта', 'St George’s Day, Army Day'],
  [5, 24, 'Ден на светите братя Кирил и Методий', 'Day of the Bulgarian Alphabet, Education and Culture'],
  [9, 6, 'Ден на Съединението', 'Unification Day'],
  [9, 22, 'Ден на Независимостта', 'Independence Day'],
  [12, 24, 'Бъдни вечер', 'Christmas Eve'],
  [12, 25, 'Рождество Христово', 'Christmas Day'],
  [12, 26, 'Рождество Христово', 'Second day of Christmas'],
];

/** Days off in lieu of holidays on a weekend exist since 2017 (Labour Code, art. 154, para 2). */
const COMPENSATION_SINCE = 2017;

const yearCache = new Map();

/**
 * Official holidays of a year, in date order:
 *   { date, name, nameEn, kind, off }
 * kind: "holiday"      a fixed official holiday
 *       "easter"       Good Friday, Holy Saturday, Easter Sunday, Easter Monday
 *       "compensation" a working day off because a holiday fell on a weekend
 *                      (`for` holds the date of that holiday)
 *       "school"       1 November: no classes, but a working day for everybody else
 * off: whether it is a day off work for everyone.
 *
 * Extra days off that the government declares for a single year are not
 * part of the law and cannot be calculated; they are not included.
 */
export function holidays(year) {
  if (yearCache.has(year)) return yearCache.get(year);
  const list = FIXED_HOLIDAYS.map(([month, day, name, nameEn]) => ({
    date: isoDate(year, month, day),
    name,
    nameEn,
    kind: 'holiday',
    off: true,
  }));
  const easter = orthodoxEaster(year);
  const easterDays = [
    [-2, 'Велики петък', 'Good Friday'],
    [-1, 'Велика събота', 'Holy Saturday'],
    [0, 'Великден', 'Easter Sunday'],
    [1, 'Великден (понеделник)', 'Easter Monday'],
  ].map(([offset, name, nameEn]) => ({ date: addDays(easter, offset), name, nameEn, kind: 'easter', off: true }));

  // A holiday (other than the Easter days) on a Saturday or Sunday gives the
  // next working day off — the next one that is not a holiday itself and has
  // not been given away already.
  const taken = new Set([...list, ...easterDays].map((item) => item.date));
  const compensation = [];
  if (year >= COMPENSATION_SINCE) {
    for (const holiday of list) {
      if (!isWeekend(holiday.date)) continue;
      let day = addDays(holiday.date, 1);
      while (isWeekend(day) || taken.has(day)) day = addDays(day, 1);
      taken.add(day);
      compensation.push({
        date: day,
        name: `Почивен ден (за ${formatDayMonth(holiday.date)})`,
        nameEn: `Day off in lieu of ${holiday.nameEn} (${formatDayMonth(holiday.date)})`,
        kind: 'compensation',
        off: true,
        for: holiday.date,
      });
    }
  }
  const school = {
    date: isoDate(year, 11, 1),
    name: 'Ден на народните будители',
    nameEn: 'National Awakening Day (no classes; a working day otherwise)',
    kind: 'school',
    off: false,
  };
  const all = [...list, ...easterDays, ...compensation, school].sort(
    (first, second) => first.date.localeCompare(second.date) || first.kind.localeCompare(second.kind),
  );
  yearCache.set(year, all);
  return all;
}

/** The holiday entries of one day (usually none, sometimes two: 1 May on Holy Saturday). */
const NONE = Object.freeze([]);
const byDay = new Map();

/** The holidays and days off on one day. Looked up, not searched: calendars ask for every day they draw. */
export function holidaysOn(value) {
  const year = parts(value).year;
  let index = byDay.get(year);
  if (!index) {
    index = new Map();
    for (const item of holidays(year)) {
      if (index.has(item.date)) index.get(item.date).push(item);
      else index.set(item.date, [item]);
    }
    byDay.set(year, index);
  }
  return index.get(value) ?? NONE;
}

/** Saturday, Sunday or an official day off. */
export function isDayOff(value) {
  return isWeekend(value) || holidaysOn(value).some((item) => item.off);
}

// -- Europe/Sofia --------------------------------------------------------------------

function lastSunday(year, month) {
  const last = isoDate(year, month, daysInMonth(year, month));
  return addDays(last, -(weekday(last) % 7));
}

/**
 * The two days of a year on which the clocks change (EU rule, in force in
 * Bulgaria since 1997): the last Sunday of March, 03:00 → 04:00, and the
 * last Sunday of October, 04:00 → 03:00. Both happen at 01:00 UTC.
 */
export function clockChanges(year) {
  return { forward: lastSunday(year, 3), back: lastSunday(year, 10) };
}

/** Minutes ahead of UTC in Sofia at a moment given in UTC milliseconds: 120 (EET) or 180 (EEST). */
export function offsetAt(utcMs) {
  const year = new Date(utcMs).getUTCFullYear();
  const { forward, back } = clockChanges(year);
  const summer = utcMs >= utc(forward) + 3_600_000 && utcMs < utc(back) + 3_600_000;
  return summer ? 180 : 120;
}

/** What the clocks in Sofia show at a UTC moment: "YYYY-MM-DDTHH:MM". */
export function toSofia(utcMs) {
  const local = new Date(utcMs + offsetAt(utcMs) * 60_000);
  return `${isoDate(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

/**
 * The UTC moment of a clock time in Sofia. A time in the hour that is
 * skipped in spring is read as the moment after the change (03:30 → 04:30);
 * a time in the hour that repeats in autumn as its first occurrence.
 */
export function fromSofia(value) {
  const base = utc(value) + Number(value.slice(11, 13) || 0) * 3_600_000 + Number(value.slice(14, 16) || 0) * 60_000;
  const summer = base - 180 * 60_000;
  if (offsetAt(summer) === 180) return summer;
  const winter = base - 120 * 60_000;
  // In the skipped hour neither reading round-trips; winter time moves it forward.
  return winter;
}

/** Hours in a day in Sofia: 23 when the clocks go forward, 25 when they go back, else 24. */
export function hoursInDay(value) {
  const { forward, back } = clockChanges(parts(value).year);
  if (value === forward) return 23;
  return value === back ? 25 : 24;
}

/** Today and the time of day in Sofia. */
export function now(utcMs = Date.now()) {
  const local = toSofia(utcMs);
  return { date: local.slice(0, 10), time: local.slice(11), minutes: Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16)) };
}

// -- formatting -----------------------------------------------------------------------

/** "23.11.2026" */
export function formatDate(value) {
  const { year, month, day } = parts(value);
  return `${pad(day)}.${pad(month)}.${pad(year, 4)}`;
}

/** "23.11" */
export function formatDayMonth(value) {
  const { month, day } = parts(value);
  return `${pad(day)}.${pad(month)}`;
}

/** "23.11.2026" or, with a time, "23.11.2026 14:30" (24-hour clock). */
export function formatDateTime(value) {
  return value.length > 10 ? `${formatDate(value)} ${value.slice(11, 16)}` : formatDate(value);
}

/** A UTC timestamp (ISO string or milliseconds) as date and time in Sofia. */
export function formatInstant(value, { time = true } = {}) {
  const local = toSofia(typeof value === 'number' ? value : new Date(value).getTime());
  return time ? formatDateTime(local) : formatDate(local);
}

/** "23.11 – 29.11.2026", with both years when the range crosses New Year. */
export function formatRange(from, to) {
  if (from === to) return formatDate(from);
  return parts(from).year === parts(to).year
    ? `${formatDayMonth(from)} – ${formatDate(to)}`
    : `${formatDate(from)} – ${formatDate(to)}`;
}

// -- reading what a person typed ---------------------------------------------------

/** "23.11.2026", "23.11.26", "23/11/2026", "23.11" (this year) or "2026-11-23" → "2026-11-23"; null when it is no date. */
export function parseDate(text, today = now().date) {
  const value = String(text ?? '').trim();
  if (isValidDate(value)) return value;
  const match = /^(\d{1,2})[.\/\- ](\d{1,2})(?:[.\/\- ](\d{2}|\d{4}))?\.?$/.exec(value);
  if (!match) return null;
  let year = match[3] ? Number(match[3]) : parts(today).year;
  if (match[3]?.length === 2) year += 2000;
  const result = isoDate(year, Number(match[2]), Number(match[1]));
  return isValidDate(result) ? result : null;
}

/** "9", "9:5", "09:30", "0930", "14.30" → "HH:MM" on the 24-hour clock; null when it is no time. */
export function parseTime(text) {
  const value = String(text ?? '').trim();
  const match = /^(\d{1,2})(?:[:.\s]?(\d{2}))?$/.exec(value) ?? /^(\d{1,2})[:.](\d)$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  return hours <= 23 && minutes <= 59 ? `${pad(hours)}:${pad(minutes)}` : null;
}
