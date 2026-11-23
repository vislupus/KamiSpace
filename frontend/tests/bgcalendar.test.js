// Unit tests for the Bulgarian calendar arithmetic. Run: npm run test:unit
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDays,
  addMonths,
  clockChanges,
  daysBetween,
  daysInMonth,
  formatDate,
  formatDateTime,
  formatInstant,
  formatRange,
  fromSofia,
  holidays,
  holidaysOn,
  hoursInDay,
  isDayOff,
  isLeapYear,
  isValidDate,
  isoWeek,
  monthWeeks,
  now,
  offsetAt,
  orthodoxEaster,
  startOfWeek,
  toSofia,
  weekStart,
  weekday,
  weeksInYear,
} from '../src/lib/bgcalendar.js';

const daysOff = (year) => holidays(year).filter((item) => item.off).map((item) => item.date);

test('weeks start on Monday', () => {
  assert.equal(weekday('2026-11-23'), 1); // a Monday
  assert.equal(weekday('2026-11-29'), 7); // Sunday is the last day
  assert.equal(weekday('2000-01-01'), 6);
  assert.equal(startOfWeek('2026-11-29'), '2026-11-23');
  assert.equal(startOfWeek('2026-11-23'), '2026-11-23');
  assert.equal(startOfWeek('2027-01-01'), '2026-12-28'); // across New Year
});

test('leap years and month lengths', () => {
  assert.deepEqual([1900, 2000, 2024, 2025, 2100].map(isLeapYear), [false, true, true, false, false]);
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2100, 2), 28);
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-02-29', 1), '2024-03-01');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(daysBetween('2024-02-01', '2024-03-01'), 29);
  assert.equal(daysBetween('2026-12-25', '2027-01-05'), 11);
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29'); // clamped to the month
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-11-23', 2), '2027-01-23');
  assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
  assert.equal(isValidDate('2024-02-29'), true);
  assert.equal(isValidDate('2026-02-29'), false);
  assert.equal(isValidDate('2026-13-01'), false);
  assert.equal(isValidDate('23.11.2026'), false);
});

test('ISO week numbers, also around New Year', () => {
  const week = (date) => {
    const { year, week: number } = isoWeek(date);
    return `${year}-W${String(number).padStart(2, '0')}`;
  };
  assert.equal(week('2026-11-23'), '2026-W48');
  assert.equal(week('2026-01-01'), '2026-W01'); // a Thursday: week 1
  assert.equal(week('2025-12-29'), '2026-W01'); // Monday of that week, still December
  assert.equal(week('2026-12-31'), '2026-W53');
  assert.equal(week('2027-01-01'), '2026-W53'); // Friday: still last year's week
  assert.equal(week('2027-01-03'), '2026-W53');
  assert.equal(week('2027-01-04'), '2027-W01');
  assert.equal(week('2021-01-03'), '2020-W53');
  assert.equal(week('2024-12-30'), '2025-W01');
  assert.equal(week('2023-01-01'), '2022-W52');
  assert.equal(week('2024-02-29'), '2024-W09');
  // Years with 53 weeks: those starting on a Thursday, and leap years starting on a Wednesday.
  const long = [];
  for (let year = 2015; year <= 2040; year += 1) if (weeksInYear(year) === 53) long.push(year);
  assert.deepEqual(long, [2015, 2020, 2026, 2032, 2037]);
  assert.equal(weekStart(2026, 1), '2025-12-29');
  assert.equal(weekStart(2026, 53), '2026-12-28');
  assert.equal(weekStart(2027, 1), '2027-01-04');
  // Every day of a long span lands in the week its Monday starts.
  for (let day = '2019-12-25'; day < '2031-01-10'; day = addDays(day, 1)) {
    const { year, week: number } = isoWeek(day);
    assert.equal(weekStart(year, number), startOfWeek(day), day);
  }
});

test('the weeks that cover a month', () => {
  const november = monthWeeks(2026, 11);
  assert.equal(november.length, 6); // 1 Nov 2026 is a Sunday
  assert.deepEqual(november[0].days, ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.deepEqual(november.map((item) => item.week), [44, 45, 46, 47, 48, 49]);
  assert.equal(monthWeeks(2026, 2).length, 5); // 1 Feb 2026 is a Sunday, the last day of its week
  assert.equal(monthWeeks(2027, 2).length, 4); // starts on a Monday, 28 days
  const january = monthWeeks(2027, 1);
  assert.deepEqual([january[0].year, january[0].week], [2026, 53]);
  assert.deepEqual([january[1].year, january[1].week], [2027, 1]);
});

test('Orthodox Easter', () => {
  const known = {
    2010: '2010-04-04', 2011: '2011-04-24', 2013: '2013-05-05', 2016: '2016-05-01',
    2017: '2017-04-16', 2018: '2018-04-08', 2019: '2019-04-28', 2020: '2020-04-19',
    2021: '2021-05-02', 2022: '2022-04-24', 2023: '2023-04-16', 2024: '2024-05-05',
    2025: '2025-04-20', 2026: '2026-04-12', 2027: '2027-05-02', 2028: '2028-04-16',
    2029: '2029-04-08', 2030: '2030-04-28', 2035: '2035-04-29', 2040: '2040-05-06',
  };
  for (const [year, date] of Object.entries(known)) assert.equal(orthodoxEaster(Number(year)), date, year);
  // Always a Sunday, between 4 April and 8 May in this century.
  for (let year = 2000; year <= 2099; year += 1) {
    const easter = orthodoxEaster(year);
    assert.equal(weekday(easter), 7, String(year));
    assert.ok(easter >= `${year}-04-04` && easter <= `${year}-05-08`, easter);
  }
});

test('official days off, with the days in lieu of weekend holidays', () => {
  // 2022: New Year on a Saturday; Christmas Eve and Christmas on a weekend.
  assert.deepEqual(daysOff(2022), [
    '2022-01-01', '2022-01-03', '2022-03-03',
    '2022-04-22', '2022-04-23', '2022-04-24', '2022-04-25',
    '2022-05-01', '2022-05-02', '2022-05-06', '2022-05-24', '2022-09-06', '2022-09-22',
    '2022-12-24', '2022-12-25', '2022-12-26', '2022-12-27', '2022-12-28',
  ]);
  // 2023: New Year on a Sunday, St George's Day on a Saturday, Christmas Eve on a Sunday.
  assert.deepEqual(daysOff(2023), [
    '2023-01-01', '2023-01-02', '2023-03-03',
    '2023-04-14', '2023-04-15', '2023-04-16', '2023-04-17',
    '2023-05-01', '2023-05-06', '2023-05-08', '2023-05-24', '2023-09-06', '2023-09-22',
    '2023-12-24', '2023-12-25', '2023-12-26', '2023-12-27',
  ]);
  // 2024: St George's Day is Easter Monday — a weekday, so nothing is added.
  assert.deepEqual(daysOff(2024), [
    '2024-01-01', '2024-03-03', '2024-03-04', '2024-05-01',
    '2024-05-03', '2024-05-04', '2024-05-05', '2024-05-06', '2024-05-06',
    '2024-05-24', '2024-09-06', '2024-09-22', '2024-09-23',
    '2024-12-24', '2024-12-25', '2024-12-26',
  ]);
  assert.deepEqual(daysOff(2026), [
    '2026-01-01', '2026-03-03',
    '2026-04-10', '2026-04-11', '2026-04-12', '2026-04-13',
    '2026-05-01', '2026-05-06', '2026-05-24', '2026-05-25',
    '2026-09-06', '2026-09-07', '2026-09-22',
    '2026-12-24', '2026-12-25', '2026-12-26', '2026-12-28',
  ]);
});

test('a holiday on Holy Saturday is made up for after Easter Monday', () => {
  // 2021: 1 May fell on Holy Saturday; Easter Monday was 3 May, so 4 May was the day off.
  assert.deepEqual(holidaysOn('2021-05-01').map((item) => item.kind), ['easter', 'holiday']);
  const lieu = holidays(2021).find((item) => item.kind === 'compensation' && item.for === '2021-05-01');
  assert.equal(lieu.date, '2021-05-04');
  // The same in 2027 (Easter on 2 May).
  assert.equal(orthodoxEaster(2027), '2027-05-02');
  assert.equal(holidays(2027).find((item) => item.for === '2027-05-01').date, '2027-05-04');
  // Christmas 2021: 25th on a Saturday, 26th on a Sunday → Monday and Tuesday.
  assert.deepEqual(
    holidays(2021).filter((item) => item.kind === 'compensation' && item.date > '2021-12-01').map((item) => item.date),
    ['2021-12-27', '2021-12-28'],
  );
});

test('rules that depend on the year, and days that are not days off', () => {
  // The automatic day in lieu exists since 2017.
  assert.equal(holidays(2016).some((item) => item.kind === 'compensation'), false);
  assert.equal(holidays(2017).filter((item) => item.kind === 'compensation').length > 0, true);
  // 1 November: no classes, but a working day.
  const awakening = holidaysOn('2026-11-01')[0];
  assert.deepEqual([awakening.kind, awakening.off], ['school', false]);
  assert.equal(isDayOff('2027-11-01'), false); // a Monday
  assert.equal(isDayOff('2026-11-01'), true); // a Sunday anyway
  assert.equal(isDayOff('2026-03-03'), true);
  assert.equal(isDayOff('2026-03-04'), false);
  assert.equal(isDayOff('2026-12-28'), true); // in lieu of 26 December (Saturday)
  // Each year has ten fixed holidays, four Easter days and the school day.
  for (let year = 2017; year <= 2060; year += 1) {
    const list = holidays(year);
    assert.equal(list.filter((item) => item.kind === 'holiday').length, 10);
    assert.equal(list.filter((item) => item.kind === 'easter').length, 4);
    // A day in lieu is a working day of the same year, never another holiday.
    for (const item of list.filter((entry) => entry.kind === 'compensation')) {
      assert.ok(weekday(item.date) <= 5, item.date);
      assert.equal(item.date.slice(0, 4), String(year));
      assert.equal(list.filter((entry) => entry.date === item.date && entry.off).length, 1, item.date);
    }
  }
});

test('Europe/Sofia: the clocks change on the last Sundays of March and October', () => {
  assert.deepEqual(clockChanges(2026), { forward: '2026-03-29', back: '2026-10-25' });
  assert.deepEqual(clockChanges(2024), { forward: '2024-03-31', back: '2024-10-27' });
  assert.deepEqual(clockChanges(2027), { forward: '2027-03-28', back: '2027-10-31' });
  assert.deepEqual([hoursInDay('2026-03-29'), hoursInDay('2026-10-25'), hoursInDay('2026-06-01')], [23, 25, 24]);
  // 03:00 becomes 04:00: 00:59 UTC is 02:59, one minute later it is 04:00.
  assert.equal(toSofia(Date.UTC(2026, 2, 29, 0, 59)), '2026-03-29T02:59');
  assert.equal(toSofia(Date.UTC(2026, 2, 29, 1, 0)), '2026-03-29T04:00');
  // 04:00 becomes 03:00: the hour from 03:00 happens twice.
  assert.equal(toSofia(Date.UTC(2026, 9, 25, 0, 30)), '2026-10-25T03:30');
  assert.equal(toSofia(Date.UTC(2026, 9, 25, 1, 30)), '2026-10-25T03:30');
  assert.equal(toSofia(Date.UTC(2026, 9, 25, 2, 0)), '2026-10-25T04:00');
  // New Year arrives two hours before it does in UTC.
  assert.equal(toSofia(Date.UTC(2026, 11, 31, 22, 0)), '2027-01-01T00:00');
  assert.equal(toSofia(Date.UTC(2026, 11, 31, 21, 59)), '2026-12-31T23:59');
  assert.deepEqual(now(Date.UTC(2026, 11, 31, 22, 30)), { date: '2027-01-01', time: '00:30', minutes: 30 });
  assert.deepEqual(now(Date.UTC(2026, 6, 15, 21, 5)), { date: '2026-07-16', time: '00:05', minutes: 5 });
});

test('Europe/Sofia: the same answers as the time zone database', () => {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Sofia', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const reference = (ms) => {
    const part = Object.fromEntries(format.formatToParts(new Date(ms)).map((item) => [item.type, item.value]));
    return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}`;
  };
  // Every 7 hours and 13 minutes from 1997 to 2037 — crosses every change many times.
  for (let ms = Date.UTC(1997, 0, 1); ms < Date.UTC(2038, 0, 1); ms += 7 * 3_600_000 + 13 * 60_000) {
    assert.equal(toSofia(ms), reference(ms), new Date(ms).toISOString());
  }
  // Minute by minute around the changes of a few years.
  for (const year of [2024, 2026, 2027, 2032]) {
    const { forward, back } = clockChanges(year);
    for (const day of [forward, back]) {
      const start = Date.parse(`${day}T00:00:00Z`) - 3 * 3_600_000;
      for (let ms = start; ms < start + 8 * 3_600_000; ms += 60_000) assert.equal(toSofia(ms), reference(ms));
    }
  }
});

test('Europe/Sofia: clock time back to a moment', () => {
  assert.equal(fromSofia('2026-07-01T12:00'), Date.UTC(2026, 6, 1, 9, 0)); // summer: UTC+3
  assert.equal(fromSofia('2026-01-15T12:00'), Date.UTC(2026, 0, 15, 10, 0)); // winter: UTC+2
  assert.equal(fromSofia('2027-01-01T00:00'), Date.UTC(2026, 11, 31, 22, 0));
  assert.equal(offsetAt(fromSofia('2026-03-29T02:59')), 120);
  assert.equal(offsetAt(fromSofia('2026-03-29T04:00')), 180);
  // 03:30 does not exist on that night: it is read as 04:30.
  assert.equal(toSofia(fromSofia('2026-03-29T03:30')), '2026-03-29T04:30');
  // 03:30 happens twice in October: the first one.
  assert.equal(fromSofia('2026-10-25T03:30'), Date.UTC(2026, 9, 25, 0, 30));
  // Every existing minute survives the round trip.
  for (let ms = Date.UTC(2026, 2, 28, 20); ms < Date.UTC(2026, 2, 29, 6); ms += 60_000) {
    assert.equal(fromSofia(toSofia(ms)), ms);
  }
  // A whole day is 23 or 25 hours long on those dates.
  const length = (day) => (fromSofia(`${addDays(day, 1)}T00:00`) - fromSofia(`${day}T00:00`)) / 3_600_000;
  assert.deepEqual([length('2026-03-29'), length('2026-10-25'), length('2026-11-23')], [23, 25, 24]);
});

test('dates are written DD.MM.YYYY and times on the 24-hour clock', () => {
  assert.equal(formatDate('2026-11-23'), '23.11.2026');
  assert.equal(formatDate('2026-01-05'), '05.01.2026');
  assert.equal(formatDateTime('2026-11-23T14:05'), '23.11.2026 14:05');
  assert.equal(formatDateTime('2026-11-23T00:00'), '23.11.2026 00:00');
  assert.equal(formatDateTime('2026-11-23'), '23.11.2026');
  assert.equal(formatRange('2026-11-23', '2026-11-29'), '23.11 – 29.11.2026');
  assert.equal(formatRange('2026-12-28', '2027-01-03'), '28.12.2026 – 03.01.2027');
  assert.equal(formatRange('2026-11-23', '2026-11-23'), '23.11.2026');
  // A UTC timestamp from the server is shown as the time in Sofia.
  assert.equal(formatInstant('2026-11-23T21:30:00+00:00'), '23.11.2026 23:30');
  assert.equal(formatInstant('2026-06-30T21:30:00Z'), '01.07.2026 00:30');
  assert.equal(formatInstant('2026-12-31T22:15:00Z', { time: false }), '01.01.2027');
});

test('typed dates and times', async () => {
  const { parseDate, parseTime } = await import('../src/lib/bgcalendar.js');
  assert.equal(parseDate('23.11.2026'), '2026-11-23');
  assert.equal(parseDate('3.3.2026'), '2026-03-03');
  assert.equal(parseDate('23/11/2026'), '2026-11-23');
  assert.equal(parseDate('23.11.26'), '2026-11-23');
  assert.equal(parseDate('23.11', '2027-01-05'), '2027-11-23');
  assert.equal(parseDate('23.11.2026 г.'.replace(' г.', '')), '2026-11-23');
  assert.equal(parseDate('2026-11-23'), '2026-11-23');
  assert.equal(parseDate('29.02.2024'), '2024-02-29');
  assert.equal(parseDate('29.02.2026'), null); // day first: never read as 2 November
  assert.equal(parseDate('11.23.2026'), null); // there is no month 23
  assert.equal(parseDate('tomorrow'), null);
  assert.equal(parseTime('9'), '09:00');
  assert.equal(parseTime('9:05'), '09:05');
  assert.equal(parseTime('0930'), '09:30');
  assert.equal(parseTime('14.30'), '14:30');
  assert.equal(parseTime('23:59'), '23:59');
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('2 pm'), null); // 24-hour clock only
});
