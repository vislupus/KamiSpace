// Formulas, colours, the emoji picker, fast data entry, full-page and linked
// databases, and the fixes that came with them.
import { expect, test } from '@playwright/test';
import {
  api,
  clickInto,
  doc,
  editor,
  focusEditor,
  openNewPage,
  paragraph,
  personalWorkspaceId,
  signIn,
  storedContent,
  waitForSaved,
} from './helpers.js';

let session;

test.beforeEach(async ({ page }) => {
  session = await signIn(page);
});

const getDatabase = async (page, id) => (await page.request.get(`/api/databases/${id}`)).json();

/** A database with a number or two and dated rows, made through the API. */
async function makeDatabase(page, { title = `Data ${Date.now()}`, numbers = [], rows = [] } = {}) {
  const created = await api(page, session, 'POST', '/api/databases', {
    workspace_id: await personalWorkspaceId(page),
    title,
    view: 'table',
  });
  let database = await getDatabase(page, created.id);
  if (numbers.length) {
    database = await api(page, session, 'PATCH', `/api/databases/${created.id}`, {
      properties: [...database.properties, ...numbers.map((name, index) => ({ id: `pnum${index}`, name, type: 'number' }))],
    });
  }
  const date = database.properties.find((prop) => prop.type === 'date');
  for (const row of rows) {
    const props = {};
    if (row.date) props[date.id] = row.date;
    numbers.forEach((name, index) => {
      if (row[name] !== undefined) props[`pnum${index}`] = row[name];
    });
    await api(page, session, 'POST', `/api/databases/${created.id}/rows`, { title: row.title, props });
  }
  return { ...(await getDatabase(page, created.id)), date };
}

const cell = (page, row, type) => page.locator('.db-row[data-row]').nth(row).locator(`.db-cell[data-type="${type}"]`);
const formulaCells = (page, header) =>
  page.locator('.db-row[data-row]').locator(`.db-cell[data-prop="${header}"]`);

test.describe('Formulas', () => {
  test('ready-made: the number of days and the working days of a date range', async ({ page }) => {
    const database = await makeDatabase(page, {
      rows: [
        { title: 'Trip', date: { start: '2026-11-23', end: '2026-11-27' } },
        { title: 'Holidays', date: { start: '2026-12-22', end: '2027-01-05' } },
        { title: 'One day', date: '2026-11-25' },
        { title: 'No date' },
      ],
    });
    await page.goto(`/p/${database.id}`);
    await expect(page.locator('.db-row[data-row]')).toHaveCount(4);

    await page.locator('.db-th-add').click();
    await page.getByRole('menuitem', { name: /Number of days/ }).click();
    // Nothing to write: the date is chosen, the name is suggested.
    await expect(page.locator('.db-preset input[aria-label="Property name"]')).toHaveValue('Days');
    await page.locator('.db-preset').getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('.db-th-name')).toHaveText(['Name', 'Status', 'Assignee', 'Date', 'Days']);
    await expect(page.locator('.db-cell[data-type="formula"]')).toHaveText(['5', '15', '1', '']);

    await page.locator('.db-th-add').click();
    await page.getByRole('menuitem', { name: /Working days/ }).click();
    await page.locator('.db-preset').getByRole('button', { name: 'Add' }).click();
    const stored = await expect
      .poll(async () => (await getDatabase(page, database.id)).properties.filter((prop) => prop.type === 'formula').length)
      .toBe(2);
    void stored;
    const working = (await getDatabase(page, database.id)).properties.find((prop) => prop.name === 'Working days');
    expect(working.expression).toBe('workdays(prop("Date"))');
    // 22.12–05.01 without weekends, Christmas, the day in lieu and New Year.
    await expect(formulaCells(page, working.id)).toHaveText(['5', '7', '1', '']);

    // Changing a date recalculates its row at once.
    await cell(page, 2, 'date').click();
    await page.locator('.db-date-editor').getByRole('checkbox', { name: 'End date' }).check();
    await page.locator('.db-date-editor input[aria-label="End date"]').last().fill('30.11.2026');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(page.locator('.db-row[data-row]').nth(2).locator('.db-cell[data-type="formula"]').first()).toHaveText('6');
  });

  test('a calculation built from two numbers, and a formula written by hand', async ({ page }) => {
    const database = await makeDatabase(page, {
      numbers: ['Price', 'Quantity'],
      rows: [
        { title: 'Paper', Price: 12.5, Quantity: 4 },
        { title: 'Ink', Price: 30, Quantity: 2 },
        { title: 'Nothing yet' },
      ],
    });
    await page.goto(`/p/${database.id}`);
    await expect(page.locator('.db-row[data-row]')).toHaveCount(3);

    await page.locator('.db-th-add').click();
    await page.getByRole('menuitem', { name: /Calculation/ }).click();
    const builder = page.locator('.db-preset');
    await builder.getByLabel('Property name').fill('Total');
    await expect(builder.getByLabel('Operation')).toHaveValue('*');
    await builder.getByRole('button', { name: 'Add' }).click();
    await expect.poll(async () => (await getDatabase(page, database.id)).properties.find((prop) => prop.name === 'Total')?.expression).toBe(
      'prop("Price") * prop("Quantity")',
    );
    const total = (await getDatabase(page, database.id)).properties.find((prop) => prop.name === 'Total');
    await expect(formulaCells(page, total.id)).toHaveText(['50', '60', '']);

    // A sum at the bottom works on formulas too.
    await page.locator('.db-calc').hover();
    await page.locator(`.db-calc-cell[data-calc="${total.id}"]`).click();
    await page.getByRole('menuitem', { name: 'Sum' }).click();
    await expect(page.locator(`.db-calc-cell[data-calc="${total.id}"]`)).toContainText('110');

    // Written by hand, with help: a mistake is explained while typing.
    await page.locator('.db-th-add').click();
    await page.getByRole('menuitem', { name: /^Formula/ }).click();
    const input = page.locator('.db-formula-input');
    await expect(input).toBeFocused();
    await input.fill('prop("Total") >');
    await expect(page.locator('.db-formula-result')).toHaveClass(/is-error/);
    await input.fill('');
    await page.locator('.db-formula-function', { hasText: 'if(condition' }).click();
    await page.keyboard.type('prop("Total") > 55, "big", "small"');
    await expect(page.locator('.db-formula-result')).toHaveClass(/is-ok/);
    await expect(page.locator('.db-formula-result')).toContainText('Paper = small');
    await page.locator('.db-formula-editor').getByRole('button', { name: 'Done' }).click();
    const label = await expect
      .poll(async () => (await getDatabase(page, database.id)).properties.find((prop) => prop.type === 'formula' && prop.name === 'Formula')?.expression)
      .toBe('if(prop("Total") > 55, "big", "small")');
    void label;
    const size = (await getDatabase(page, database.id)).properties.find((prop) => prop.name === 'Formula');
    await expect(formulaCells(page, size.id)).toHaveText(['small', 'big', 'small']);

    // Entering a number recalculates both formulas of that row.
    await cell(page, 2, 'number').first().click();
    await page.keyboard.type('100');
    await page.keyboard.press('Tab');
    await page.keyboard.type('3');
    await page.keyboard.press('Enter');
    await expect(formulaCells(page, total.id)).toHaveText(['50', '60', '300']);
    await expect(formulaCells(page, size.id).nth(2)).toHaveText('big');

    // Renaming a property keeps the formulas that use it working.
    await page.locator('.db-th', { hasText: 'Price' }).click();
    const name = page.locator('.db-property-name input');
    await name.fill('Unit price');
    await name.press('Enter');
    await expect.poll(async () => (await getDatabase(page, database.id)).properties.find((prop) => prop.name === 'Total')?.expression).toBe(
      'prop("Unit price") * prop("Quantity")',
    );
    await expect(formulaCells(page, total.id)).toHaveText(['50', '60', '300']);

    // Formulas are never stored as values.
    const rows = (await getDatabase(page, database.id)).rows;
    expect(rows.every((row) => !(total.id in row.props) && !(size.id in row.props))).toBe(true);
  });
});

test.describe('Entering data', () => {
  test('Tab goes from cell to cell, and only the edited row is drawn again', async ({ page }) => {
    const database = await makeDatabase(page, {
      numbers: ['Hours', 'Rate'],
      rows: [{ title: 'First' }, { title: 'Second' }, { title: 'Third' }],
    });
    await page.goto(`/p/${database.id}`);
    await expect(page.locator('.db-row[data-row]')).toHaveCount(3);
    // Marks on the DOM nodes show which rows are replaced.
    await page.evaluate(() => document.querySelectorAll('.db-row[data-row]').forEach((row) => (row.dataset.mark = 'kept')));

    await cell(page, 1, 'number').first().click();
    await expect(page.locator('.db-inline-input')).toBeFocused();
    await page.keyboard.type('8');
    await page.keyboard.press('Tab');
    await expect(page.locator('.db-inline-input')).toBeFocused();
    await page.keyboard.type('25,5');
    // The end of the row: Tab goes on to the name of the next one.
    await page.keyboard.press('Tab');
    await expect(page.locator('.db-inline-input')).toHaveValue('Third');
    await page.keyboard.type('Third, renamed');
    // Shift+Tab goes back, past the calculated and empty cells it cannot type in.
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('.db-inline-input')).toHaveValue('25.5');
    await page.keyboard.press('Escape');

    await expect(page.locator('.db-row[data-row]').nth(1).locator('.db-cell[data-type="number"]')).toHaveText(['8', '25.5']);
    await expect(page.locator('.db-row[data-row]').nth(2).locator('.db-cell-title .db-text')).toHaveText('Third, renamed');
    const marks = await page.locator('.db-row[data-row]').evaluateAll((rows) => rows.map((row) => row.dataset.mark ?? 'new'));
    expect(marks).toEqual(['kept', 'new', 'new']);

    await expect
      .poll(async () => (await getDatabase(page, database.id)).rows.map((row) => [row.title, row.props.pnum0 ?? null, row.props.pnum1 ?? null]))
      .toEqual([
        ['First', null, null],
        ['Second', 8, 25.5],
        ['Third, renamed', null, null],
      ]);
  });

  test('a new row is ready to type in without the page tree being fetched again', async ({ page }) => {
    const database = await makeDatabase(page, { rows: [{ title: 'Existing' }] });
    await page.goto(`/p/${database.id}`);
    await expect(page.locator('.db-row[data-row]')).toHaveCount(1);
    let treeRequests = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/tree')) treeRequests += 1;
    });
    await page.locator('.db-add-row').click();
    await expect(page.locator('.db-inline-input')).toBeFocused();
    await page.keyboard.type('Added');
    await page.keyboard.press('Enter');
    await expect(page.locator('.db-row[data-row] .db-cell-title .db-text')).toHaveText(['Existing', 'Added']);
    // The new row opens beside the table like any other.
    await page.locator('.db-row[data-row]').nth(1).locator('.db-cell-title').hover();
    await page.locator('.db-row[data-row]').nth(1).locator('.db-open-row').click();
    await expect(page.locator('.peek .page-title')).toHaveValue('Added');
    expect(treeRequests).toBe(0);
  });
});

test.describe('Colours', () => {
  test('a row gets a colour in the table; the calendar shows it, and a colour per database', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-11-23T08:45:00Z'));
    const database = await makeDatabase(page, {
      title: `Colours ${Date.now()}`,
      rows: [
        { title: 'Painted', date: '2026-11-24' },
        { title: 'Plain', date: '2026-11-25' },
      ],
    });
    await page.goto(`/p/${database.id}`);
    await expect(page.locator('.db-row[data-row]')).toHaveCount(2);
    await page.locator('.db-row[data-row]').first().locator('.db-cell[data-type="status"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Color' }).hover();
    await page.getByRole('menuitem', { name: 'Red' }).click();
    await expect(page.locator('.db-row[data-row]').first()).toHaveAttribute('data-color', 'red');
    await expect(page.locator('.db-row[data-row]').first().locator('.db-row-color')).toBeVisible();
    await expect.poll(async () => (await getDatabase(page, database.id)).rows.map((row) => row.color)).toEqual(['red', null]);

    // Only this database in the calendar (other tests leave theirs behind).
    const all = (await (await page.request.get('/api/calendar?start=2026-01-01&end=2027-12-31')).json()).databases;
    const hidden = all.filter((item) => item.id !== database.id).map((item) => `db:${item.id}`);
    await page.evaluate((value) => localStorage.setItem('kamispace-calendar-hidden', JSON.stringify(value)), hidden);
    await page.goto('/calendar?view=month&date=2026-11-23');
    await expect(page.locator('.cal')).not.toHaveAttribute('data-busy', '1');
    const painted = page.locator('.cal-event', { hasText: 'Painted' });
    const plain = page.locator('.cal-event', { hasText: 'Plain' });
    await expect(painted).toHaveAttribute('data-color', 'red');
    const automatic = await plain.getAttribute('data-color');

    // The colour of the whole database, from the list of calendars.
    const source = page.locator('.cal-source', { hasText: database.title });
    await source.hover();
    await source.locator('.cal-source-color').click();
    await page.getByRole('menuitem', { name: 'Green' }).click();
    await expect(plain).toHaveAttribute('data-color', 'green');
    await expect(painted).toHaveAttribute('data-color', 'red');
    await expect(source).toHaveAttribute('data-color', 'green');
    await expect.poll(async () => (await getDatabase(page, database.id)).color).toBe('green');

    // An event can be coloured from the calendar too, and set back.
    await plain.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Color' }).hover();
    await page.getByRole('menuitem', { name: 'Purple' }).click();
    await expect(plain).toHaveAttribute('data-color', 'purple');
    await expect.poll(async () => (await getDatabase(page, database.id)).rows.map((row) => row.color)).toEqual(['red', 'purple']);
    await plain.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Color' }).hover();
    await page.getByRole('menuitem', { name: 'Same as the calendar' }).click();
    await expect(plain).toHaveAttribute('data-color', 'green');
    expect(automatic).not.toBe('task');

    await page.reload();
    await expect(page.locator('.cal')).not.toHaveAttribute('data-busy', '1');
    await expect(page.locator('.cal-event', { hasText: 'Painted' })).toHaveAttribute('data-color', 'red');
    await expect(page.locator('.cal-event', { hasText: 'Plain' })).toHaveAttribute('data-color', 'green');
  });

  test('the month shows plain day numbers and a faint grey on the neighbouring months', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-11-23T08:45:00Z'));
    await page.goto('/calendar?view=month&date=2027-04-15');
    await expect(page.locator('.cal-title')).toBeVisible();
    await expect(page.locator('.cal-day[data-date="2027-04-01"] .cal-day-number')).toHaveText('1');
    await expect(page.locator('.cal-day[data-date="2027-05-01"] .cal-day-number')).toHaveText('1');
    await expect(page.locator('.cal-day[data-date="2027-03-31"] .cal-day-number')).toHaveText('31');
    const background = (date) =>
      page.locator(`.cal-day[data-date="${date}"]`).evaluate((el) => getComputedStyle(el).backgroundColor);
    const outside = await background('2027-03-31');
    const inside = await background('2027-04-14');
    expect(outside).not.toBe(inside);
    // Barely there: a few percent of the text colour.
    const alpha = Number(/[\d.]+\)$/.exec(outside.replace(/\s/g, ''))?.[0].slice(0, -1) ?? 1);
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(0.06);
  });
});

test.describe('Emoji', () => {
  test('the picker has the whole set, and search works in English and Bulgarian', async ({ page }) => {
    const created = await openNewPage(page, session, { title: 'Emoji page' });
    await page.locator('.page-head').hover();
    await page.getByRole('button', { name: 'Add icon' }).click();
    const picker = page.locator('.emoji-picker');
    await expect(picker.locator('.emoji-tab')).toHaveCount(9);
    expect(await picker.locator('.emoji-button').count()).toBeGreaterThan(1800);

    const search = picker.locator('.emoji-search');
    await expect(search).toBeFocused();
    await search.fill('rocket');
    await expect(picker.locator('.emoji-button').first()).toHaveText('🚀');
    await search.fill('сърце');
    await expect(picker.locator('.emoji-button', { hasText: '❤️' }).first()).toBeVisible();
    await search.fill('zzzzqq');
    await expect(picker.locator('.emoji-note')).toContainText('Nothing found');
    await search.fill('палец нагоре');
    await expect(picker.locator('.emoji-button').first()).toHaveText('👍');
    await search.press('Enter');
    await expect(picker).toHaveCount(0);
    await expect(page.locator('.page-icon')).toHaveText('👍');
    await expect.poll(async () => (await (await page.request.get(`/api/pages/${created.id}`)).json()).icon).toBe('👍');

    // What was used is offered first the next time.
    await page.locator('.page-icon').click();
    await expect(page.locator('.emoji-section').first().locator('.emoji-heading')).toHaveText('Recent');
    await expect(page.locator('.emoji-section').first().locator('.emoji-button').first()).toHaveText('👍');
    await page.locator('.emoji-picker').getByRole('button', { name: 'Remove' }).click();
    await expect.poll(async () => (await (await page.request.get(`/api/pages/${created.id}`)).json()).icon).toBe(null);
  });

  test('in the text: ":name" offers emoji, ":code:" turns into one, /emoji opens the picker', async ({ page }) => {
    const created = await openNewPage(page, session, { title: 'Emoji text', content: doc('Launch') });
    await focusEditor(page);
    await page.keyboard.press('End');
    await page.keyboard.type(' :rock');
    const menu = page.locator('.emoji-menu');
    await expect(menu.locator('.slash-item').first()).toBeVisible();
    await page.keyboard.type('et');
    await expect(menu.locator('.slash-item.is-active .slash-icon')).toHaveText('🚀');
    await page.keyboard.press('Enter');
    await expect(editor(page).locator('p').first()).toHaveText('Launch 🚀');

    await page.keyboard.type(' :fire:');
    await expect(editor(page).locator('p').first()).toHaveText('Launch 🚀 🔥');
    // Bulgarian names work at the caret as well.
    await page.keyboard.type(' :куче');
    await expect(menu.locator('.slash-item').first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(editor(page).locator('p').first()).toHaveText(/^Launch 🚀 🔥 🐕/u);
    // Times and smileys made of punctuation stay as they are typed.
    await page.keyboard.type(' at 10:30 :)');
    await expect(menu).toHaveCount(0);

    await page.keyboard.press('Enter');
    await page.keyboard.type('/emoji');
    await page.keyboard.press('Enter');
    await page.locator('.emoji-search').fill('party popper');
    await page.locator('.emoji-search').press('Enter');
    await expect(editor(page).locator('p').nth(1)).toHaveText('🎉');
    await waitForSaved(page);
    const stored = JSON.stringify(await storedContent(page, created.id));
    expect(stored).toContain('Launch 🚀 🔥 🐕');
    expect(stored).toContain('🎉');
  });
});

test.describe('Fixes', () => {
  test('a toggle heading stays a heading when it is closed and opened', async ({ page }) => {
    const created = await openNewPage(page, session, { title: 'Toggle heading', content: doc('') });
    await focusEditor(page);
    await page.keyboard.type('/toggleh2');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Chapter');
    const toggle = editor(page).locator('div[data-type="details"]');
    await expect(toggle).toHaveAttribute('data-level', '2');
    const size = () => toggle.locator('summary').evaluate((el) => getComputedStyle(el).fontSize);
    const heading = await size();

    for (const open of ['false', 'true', 'false']) {
      await toggle.locator(':scope > button').click();
      await waitForSaved(page);
      const stored = (await storedContent(page, created.id)).content.find((node) => node.type === 'details');
      expect(String(stored.attrs.open)).toBe(open === 'true' ? 'true' : 'false');
      expect(stored.attrs.level).toBe(2);
      await expect(toggle).toHaveAttribute('data-level', '2');
      expect(await size()).toBe(heading);
    }
    await page.reload();
    await expect(editor(page).locator('div[data-type="details"]')).toHaveAttribute('data-level', '2');
  });

  test('what follows a column layout does not stick to it', async ({ page }) => {
    await openNewPage(page, session, {
      title: 'Columns',
      content: {
        type: 'doc',
        content: [
          paragraph('Above'),
          {
            type: 'columns',
            content: [
              { type: 'column', content: [paragraph('Left')] },
              { type: 'column', content: [paragraph('Right')] },
            ],
          },
          paragraph('Below'),
        ],
      },
    });
    const gap = await page.evaluate(() => {
      const columns = document.querySelector('.doc .columns');
      const next = columns.nextElementSibling;
      const previous = columns.previousElementSibling;
      return {
        below: next.getBoundingClientRect().top - columns.getBoundingClientRect().bottom,
        above: columns.getBoundingClientRect().top - previous.getBoundingClientRect().bottom,
        size: parseFloat(getComputedStyle(next).fontSize),
      };
    });
    expect(gap.below).toBeGreaterThanOrEqual(gap.size * 1.5);
    expect(gap.above).toBeGreaterThanOrEqual(gap.size);
  });
});

test.describe('Databases as pages', () => {
  test('"/database-page" makes a page of its own that is only linked here', async ({ page }) => {
    const host = await openNewPage(page, session, { title: `Host ${Date.now()}`, content: doc('Plans') });
    await focusEditor(page);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/database');
    // Both ways of adding one are offered side by side.
    await expect(page.locator('.slash-item[data-command="database"]')).toContainText('inline');
    await expect(page.locator('.slash-item[data-command="database-page"]')).toContainText('full page');
    await page.locator('.slash-item[data-command="database-page"]').click();

    // It opens as a page, as in Notion.
    await expect(page).toHaveURL(/\/p\/\d+$/);
    await expect(page.locator('.page.is-database')).toBeVisible();
    const databaseId = Number(page.url().split('/').pop());
    expect(databaseId).not.toBe(host.id);
    await page.locator('.page-title').fill('Roadmap');
    await expect.poll(async () => (await getDatabase(page, databaseId)).title).toBe('Roadmap');

    // The host has a link to it (not the table itself), with a database icon.
    await page.goto(`/p/${host.id}`);
    const link = editor(page).locator('.page-link');
    await expect(link).toHaveText('Roadmap');
    await expect(link.locator('svg')).toBeVisible();
    await expect(editor(page).locator('.database-block')).toHaveCount(0);
    const stored = await storedContent(page, host.id);
    expect(stored.content.filter((node) => node.type === 'pageLink').map((node) => node.attrs.pageId)).toEqual([databaseId]);
    expect((await getDatabase(page, databaseId)).parent_id).toBe(host.id);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/p/${databaseId}$`));
  });

  test('a database can be mentioned like a page, and shown in another page as a linked view', async ({ page }) => {
    const name = `Inventory${Date.now()}`;
    const database = await makeDatabase(page, { title: name, rows: [{ title: 'Chairs' }, { title: 'Desks' }] });
    const host = await openNewPage(page, session, { title: 'Elsewhere', content: doc('See') });
    await focusEditor(page);
    await page.keyboard.press('End');
    await page.keyboard.type(` @${name.slice(0, 16)}`);
    const option = page.locator('.mention-menu .slash-item', { hasText: name });
    await expect(option).toContainText('Database');
    await option.click();
    const mention = editor(page).locator('.page-mention');
    await expect(mention).toHaveText(name);
    await expect(mention.locator('svg')).toBeVisible();

    await page.keyboard.press('Enter');
    await page.keyboard.type('/linked');
    await expect(page.locator('.slash-item.is-active')).toHaveAttribute('data-command', 'linked-database');
    await page.keyboard.press('Enter');
    const picker = page.locator('.db-link-picker');
    await picker.locator('input').fill(name);
    await expect(picker.locator('.menu-item')).toHaveCount(1);
    await page.keyboard.press('Enter');
    const block = editor(page).locator('.database-block');
    await expect(block.locator('.db-title')).toHaveValue(name);
    await expect(block.locator('.db-row[data-row] .db-cell-title .db-text')).toHaveText(['Chairs', 'Desks']);
    await waitForSaved(page);
    const stored = await storedContent(page, host.id);
    expect(stored.content.find((node) => node.type === 'database').attrs.pageId).toBe(database.id);
    // Still one database, living where it was: the view only points to it.
    expect((await getDatabase(page, database.id)).parent_id).toBe(null);

    await mention.click();
    await expect(page).toHaveURL(new RegExp(`/p/${database.id}$`));
  });
});
