// The calendar: Bulgarian conventions, holidays, and events read from databases.
import { expect, test } from '@playwright/test';
import { api, personalWorkspaceId, signIn } from './helpers.js';

let session;

test.beforeEach(async ({ page }) => {
  session = await signIn(page);
  // Monday 23 November 2026, 10:45 in Sofia.
  await page.clock.setFixedTime(new Date('2026-11-23T08:45:00Z'));
});

async function eventsDatabase(page, title) {
  const created = await api(page, session, 'POST', '/api/databases', {
    workspace_id: await personalWorkspaceId(page),
    title,
    view: 'table',
  });
  const database = await (await page.request.get(`/api/databases/${created.id}`)).json();
  const date = database.properties.find((prop) => prop.type === 'date');
  const add = (name, value) =>
    api(page, session, 'POST', `/api/databases/${created.id}/rows`, { title: name, props: { [date.id]: value } });
  const rowDate = async (id) =>
    (await (await page.request.get(`/api/databases/${created.id}`)).json()).rows.find((row) => row.id === id).props[date.id];
  return { id: created.id, date, add, rowDate };
}

const open = async (page, view, date) => {
  await page.goto(`/calendar?view=${view}&date=${date}`);
  await expect(page.locator('.cal-title')).toBeVisible();
};

test('year view: twelve months, Monday first, ISO weeks, Bulgarian holidays', async ({ page }) => {
  await open(page, 'year', '2026-06-15');
  await expect(page.locator('.cal-title')).toHaveText('2026');
  await expect(page.locator('.cal-mini')).toHaveCount(12);
  const january = page.locator('.cal-mini').first();
  await expect(january.locator('.cal-mini-weekday')).toHaveText(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
  // 1 January 2026 is a Thursday in ISO week 1; the year ends in week 53.
  await expect(january.locator('button.cal-mini-week').first()).toHaveText('1');
  await expect(page.locator('.cal-mini').last().locator('button.cal-mini-week').last()).toHaveText('53');
  const day = (date) => page.locator(`.cal-mini-day[data-date="${date}"]`);
  for (const holiday of ['2026-01-01', '2026-03-03', '2026-04-10', '2026-04-11', '2026-04-12', '2026-04-13', '2026-05-01', '2026-05-06', '2026-05-24', '2026-09-06', '2026-09-22', '2026-12-24', '2026-12-25', '2026-12-26']) {
    await expect(day(holiday), holiday).toHaveClass(/is-holiday/);
  }
  // Holidays on a weekend are made up for on the next working day.
  for (const lieu of ['2026-05-25', '2026-09-07', '2026-12-28']) await expect(day(lieu), lieu).toHaveClass(/is-lieu/);
  await expect(day('2026-11-01')).toHaveClass(/is-school/);
  await expect(day('2026-03-04')).not.toHaveClass(/is-holiday|is-lieu/);
  await expect(day('2026-11-23')).toHaveClass(/is-today/);
  await expect(day('2026-04-12')).toHaveAttribute('title', /Великден/);
  // Every date appears exactly once.
  await expect(page.locator('.cal-mini-day')).toHaveCount(365);

  const table = page.locator('.cal-holiday-table');
  await expect(table.locator('tr', { hasText: 'Великден' }).first()).toContainText('12.04.2026');
  await expect(table.locator('tr', { hasText: '25.05.2026' })).toContainText('Почивен ден');
  await expect(page.locator('.cal-note')).toContainText('29.03.2026');
  await expect(page.locator('.cal-note')).toContainText('25.10.2026');
  await expect(page.locator('.cal-note')).toContainText('53 ISO weeks');

  // A leap year has its 29 February; clicking a day opens it.
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.cal-title')).toHaveText('2028');
  await expect(page.locator('.cal-mini-day')).toHaveCount(366);
  await day('2028-02-29').click();
  await expect(page.locator('.cal-title')).toHaveText('Tuesday, 29.02.2028 · Week 9');
});

test('month, week and day views show database rows with DD.MM dates and a 24-hour clock', async ({ page }) => {
  const stamp = Date.now();
  const events = await eventsDatabase(page, `Events ${stamp}`);
  const meeting = await events.add(`Meeting ${stamp}`, { start: '2026-11-23T14:30', end: '2026-11-23T16:00' });
  await events.add(`Print run ${stamp}`, { start: '2026-11-24', end: '2026-11-26' });

  await open(page, 'month', '2026-11-23');
  await expect(page.locator('.cal-title')).toHaveText('November 2026');
  await expect(page.locator('.cal-weekday')).toHaveText(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  await expect(page.locator('.cal-week-row').first().locator('.cal-week-number')).toHaveText('44');
  const cell = (date) => page.locator(`.cal-day[data-date="${date}"]`);
  await expect(cell('2026-11-23')).toHaveClass(/is-today/);
  const chip = cell('2026-11-23').locator('.cal-chip', { hasText: `Meeting ${stamp}` });
  await expect(chip.locator('.cal-chip-time')).toHaveText('14:30');
  // A range shows on each of its days.
  for (const date of ['2026-11-24', '2026-11-25', '2026-11-26']) {
    await expect(cell(date).locator('.cal-chip', { hasText: `Print run ${stamp}` })).toHaveCount(1);
  }
  await expect(cell('2026-11-27').locator('.cal-chip', { hasText: `Print run ${stamp}` })).toHaveCount(0);
  await expect(cell('2026-11-01').locator('.cal-day-holiday')).toHaveText('Ден на народните будители');

  // Dragging an event to another day moves it and keeps its time.
  await chip.dragTo(cell('2026-11-27'));
  await expect(cell('2026-11-27').locator('.cal-chip', { hasText: `Meeting ${stamp}` })).toHaveCount(1);
  await expect.poll(() => events.rowDate(meeting.id)).toEqual({ start: '2026-11-27T14:30', end: '2026-11-27T16:00' });

  await page.keyboard.press('w');
  await expect(page.locator('.cal-title')).toHaveText('Week 48 · 23.11 – 29.11.2026');
  await expect(page.locator('.cal-col-date')).toHaveText(['23.11', '24.11', '25.11', '26.11', '27.11', '28.11', '29.11']);
  const hours = await page.locator('.cal-hours span').allTextContents();
  expect(hours).toHaveLength(24);
  expect([hours[0], hours[13], hours[23]]).toEqual(['00:00', '13:00', '23:00']);
  expect(hours.join(' ')).not.toMatch(/am|pm/i);
  const block = page.locator('.cal-grid-day[data-date="2026-11-27"] .cal-block', { hasText: `Meeting ${stamp}` });
  await expect(block.locator('.cal-chip-time')).toHaveText('14:30–16:00');
  // 14:30 is 14.5 hours down the day; one and a half hours tall.
  expect(await block.evaluate((el) => [parseFloat(el.style.top), Math.round(parseFloat(el.style.height))])).toEqual([14.5 * 48, 70]);
  // "Now" is drawn on today, at the time in Sofia (10:45), whatever the computer's zone.
  const now = page.locator('.cal-grid-day[data-date="2026-11-23"] .cal-now');
  expect(await now.evaluate((el) => parseFloat(el.style.top))).toBe(10.75 * 48);
  await expect(page.locator('.cal-allday[data-date="2026-11-25"] .cal-chip')).toContainText(`Print run ${stamp}`);

  await page.keyboard.press('d');
  await expect(page.locator('.cal-title')).toHaveText('Monday, 23.11.2026 · Week 48');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.cal-title')).toHaveText('Tuesday, 24.11.2026 · Week 48');
  await page.keyboard.press('t');
  await expect(page.locator('.cal-title')).toHaveText('Monday, 23.11.2026 · Week 48');
  await page.keyboard.press('m');
  await page.keyboard.press('y');
  await expect(page.locator('.cal-title')).toHaveText('2026');
  await expect(page.locator('.cal-mini-day[data-date="2026-11-27"]')).toHaveClass(/has-events/);

  // An event is a page: the chip leads there.
  await page.keyboard.press('m');
  await cell('2026-11-27').locator('.cal-chip', { hasText: `Meeting ${stamp}` }).click();
  await expect(page.locator('.page-title')).toHaveValue(`Meeting ${stamp}`);
  await expect(page.locator('.row-prop-value').last()).toHaveText('27.11.2026 14:30 → 27.11.2026 16:00');
});

test('a new event is a row of a database, with a time on the 24-hour clock', async ({ page }) => {
  const stamp = Date.now();
  const events = await eventsDatabase(page, `Diary ${stamp}`);
  await open(page, 'month', '2026-12-01');
  await page.locator('.cal-day[data-date="2026-12-10"]').click({ position: { x: 40, y: 80 } });
  const form = page.locator('.cal-form');
  await expect(form.locator('input[aria-label="Start date"]')).toHaveValue('10.12.2026');
  await form.locator('input[aria-label="Event name"]').fill(`Review ${stamp}`);
  await form.locator('select').selectOption({ label: `Diary ${stamp}` });
  await form.getByLabel('All day').uncheck();
  // The 12-hour clock is not understood.
  await form.locator('input[aria-label="Start time"]').fill('2 pm');
  await form.locator('input[aria-label="Start time"]').press('Tab');
  await expect(form.locator('input[aria-label="Start time"]')).toHaveClass(/is-invalid/);
  await form.locator('input[aria-label="Start time"]').fill('1430');
  await form.locator('input[aria-label="Start time"]').press('Tab');
  await expect(form.locator('input[aria-label="Start time"]')).toHaveValue('14:30');
  await form.locator('input[aria-label="End time"]').fill('16');
  await form.getByRole('button', { name: 'Create' }).click();
  const chip = page.locator('.cal-day[data-date="2026-12-10"] .cal-chip', { hasText: `Review ${stamp}` });
  await expect(chip.locator('.cal-chip-time')).toHaveText('14:30');
  const database = await (await page.request.get(`/api/databases/${events.id}`)).json();
  expect(database.rows.map((row) => row.props[events.date.id])).toEqual([{ start: '2026-12-10T14:30', end: '2026-12-10T16:00' }]);
});

test('clock changes and the turn of the year', async ({ page }) => {
  // The night the clocks go forward: a 23-hour day with no 03:00.
  await open(page, 'day', '2026-03-29');
  await expect(page.locator('.cal-col-dst')).toHaveText('Clocks +1 h (23-hour day)');
  await expect(page.locator('.cal-dst')).toContainText('03:00 → 04:00');
  expect(await page.locator('.cal-dst').evaluate((el) => parseFloat(el.style.top))).toBe(3 * 48);
  await open(page, 'day', '2026-10-25');
  await expect(page.locator('.cal-col-dst')).toHaveText('Clocks −1 h (25-hour day)');
  await open(page, 'day', '2026-06-01');
  await expect(page.locator('.cal-col-dst, .cal-dst')).toHaveCount(0);

  // 1 January 2027 is a Friday in week 53 of 2026.
  await open(page, 'week', '2027-01-01');
  await expect(page.locator('.cal-title')).toHaveText('Week 53 · 28.12.2026 – 03.01.2027');
  await expect(page.locator('.cal-corner').first()).toHaveText('W53');
  await expect(page.locator('.cal-col-head', { hasText: '01.01' })).toContainText('Нова година');
  await expect(page.locator('.cal-col-head', { hasText: '28.12' })).toContainText('Почивен ден');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.cal-title')).toHaveText('Week 1 · 04.01 – 10.01.2027');
  // Month view of December: the last row runs into January.
  await open(page, 'month', '2026-12-15');
  await expect(page.locator('.cal-week-row').last().locator('.cal-week-number')).toHaveText('53');
  await expect(page.locator('.cal-day[data-date="2027-01-01"]')).toHaveClass(/is-outside/);
  await expect(page.locator('.cal-day[data-date="2027-01-01"]')).toHaveClass(/is-holiday/);
});

test.describe('in another time zone', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });

  test('"today" and "now" are those of Sofia', async ({ page }) => {
    // 22:30 UTC on New Year's Eve: afternoon in Los Angeles, already 2027 in Sofia.
    await page.clock.setFixedTime(new Date('2026-12-31T22:30:00Z'));
    await page.goto('/calendar?view=day');
    await expect(page.locator('.cal-title')).toHaveText('Friday, 01.01.2027 · Week 53');
    await expect(page.locator('.cal-zone')).toHaveText('Europe/Sofia · UTC+2');
    expect(await page.locator('.cal-now').evaluate((el) => parseFloat(el.style.top))).toBe(0.5 * 48);
    await page.keyboard.press('y');
    await expect(page.locator('.cal-title')).toHaveText('2027');
    await expect(page.locator('.cal-mini-day.is-today')).toHaveAttribute('data-date', '2027-01-01');
  });
});

test('a date in a database can carry a time; it is written DD.MM.YYYY HH:MM', async ({ page }) => {
  const events = await eventsDatabase(page, `Times ${Date.now()}`);
  await events.add('Deadline', '2026-11-20');
  await page.goto(`/p/${events.id}`);
  const cell = page.locator('.db-cell[data-type="date"]');
  await expect(cell).toHaveText('20.11.2026');
  await cell.click();
  const editor = page.locator('.db-date-editor');
  // The month grid starts on Monday and shows ISO week numbers.
  await expect(editor.locator('.datepicker-weekday')).toHaveText(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
  await expect(editor.locator('.datepicker-day.is-selected')).toHaveText('20');
  await expect(editor.locator('.datepicker-week').nth(1)).toHaveText('44');
  await editor.getByLabel('Include time').check();
  await expect(editor.locator('input[aria-label="Start time"]')).toHaveValue('09:00');
  await editor.locator('input[aria-label="Start time"]').fill('17.45');
  await editor.locator('input[aria-label="Start time"]').press('Enter');
  await editor.locator('.datepicker-day[data-date="2026-11-24"]').click();
  await page.keyboard.press('Escape');
  await expect(cell).toHaveText('24.11.2026 17:45');
  // A date that does not exist is not accepted.
  await cell.click();
  await editor.locator('input[aria-label="Start date"]').fill('31.11.2026');
  await editor.locator('input[aria-label="Start date"]').press('Enter');
  await expect(editor.locator('input[aria-label="Start date"]')).toHaveClass(/is-invalid/);
  await page.keyboard.press('Escape');
  await expect(cell).toHaveText('24.11.2026 17:45');
});
