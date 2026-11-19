// Databases: a table of rows (each one a page) with a board view, the way
// Notion does it.
import { expect, test } from '@playwright/test';
import {
  api,
  doc,
  editor,
  focusEditor,
  openNewPage,
  personalWorkspaceId,
  signIn,
  storedContent,
  waitForSaved,
} from './helpers.js';

let session;

test.beforeEach(async ({ page }) => {
  session = await signIn(page);
});

async function getDatabase(page, id) {
  return (await page.request.get(`/api/databases/${id}`)).json();
}

/** A database of its own (not inside a page), filled through the API. */
async function makeDatabase(page, { title = `Tracker ${Date.now()}`, view = 'table', rows = [] } = {}) {
  const created = await api(page, session, 'POST', '/api/databases', {
    workspace_id: await personalWorkspaceId(page),
    title,
    view,
  });
  const database = await getDatabase(page, created.id);
  const status = database.properties.find((prop) => prop.type === 'status');
  for (const [name, state] of rows) {
    const option = status.options.find((item) => item.name === state);
    await api(page, session, 'POST', `/api/databases/${created.id}/rows`, {
      title: name,
      props: option ? { [status.id]: option.id } : {},
    });
  }
  return { ...(await getDatabase(page, created.id)), status };
}

/** Waits until the table shows exactly these row names, in this order. */
const expectRows = (page, names) =>
  expect(page.locator('.db-row[data-row] .db-cell-title .db-text')).toHaveText(names);
const typeInCell = async (page, text) => {
  await expect(page.locator('.db-inline-input')).toBeFocused();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.locator('.db-inline-input')).toHaveCount(0);
};

test.describe('Inline database', () => {
  test('"/database" puts a table in the page: rows, a status, a new option, a date and a person', async ({ page }) => {
    const host = await openNewPage(page, session, { title: `Work ${Date.now()}`, content: doc('Our projects') });
    await focusEditor(page);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/database');
    await expect(page.locator('.slash-item.is-active')).toHaveAttribute('data-command', 'database');
    await page.keyboard.press('Enter');
    const table = page.locator('.database-block .db-table');
    await expect(table).toBeVisible();
    await expect(page.locator('.db-th-name')).toHaveText(['Name', 'Status', 'Assignee', 'Date']);
    await expect(page.locator('.db-tab')).toHaveText(['Table', 'Board', '']);
    await page.locator('.db-title').fill('Projects');

    // A new row starts with its name being typed, like in Notion.
    await page.locator('.db-add-row').click();
    await typeInCell(page, 'First project');
    await page.locator('.db-new').click();
    await typeInCell(page, 'Second project');
    await expectRows(page, ['First project', 'Second project']);

    const cell = (row, type) => page.locator('.db-row[data-row]').nth(row).locator(`.db-cell[data-type="${type}"]`);
    await cell(0, 'status').click();
    await page.locator('.db-option', { hasText: 'In progress' }).click();
    await expect(cell(0, 'status').locator('.db-pill')).toHaveText('In progress');
    await expect(cell(0, 'status').locator('.db-pill')).toHaveAttribute('data-color', 'blue');

    // Typing a name that does not exist offers to create the option.
    await cell(1, 'status').click();
    await page.locator('.db-option-search').fill('Blocked');
    await expect(page.locator('.db-option-create')).toContainText('Blocked');
    await page.keyboard.press('Enter');
    await expect(cell(1, 'status').locator('.db-pill')).toHaveText('Blocked');

    await cell(0, 'date').click();
    await page.locator('.db-date-editor input[type="date"]').first().fill('2026-11-20');
    await page.keyboard.press('Escape');
    await expect(cell(0, 'date')).toContainText('2026');

    await cell(0, 'person').click();
    await page.locator('.db-option', { hasText: 'alice' }).click();
    await page.keyboard.press('Escape');
    await expect(cell(0, 'person').locator('.db-person-name')).toHaveText('alice');

    // The page stores only where the database is shown.
    await waitForSaved(page);
    const stored = await storedContent(page, host.id);
    const block = stored.content.find((node) => node.type === 'database');
    expect(block.attrs.pageId).toBeGreaterThan(0);
    const database = await getDatabase(page, block.attrs.pageId);
    expect(database.title).toBe('Projects');
    expect(database.rows.map((row) => row.title)).toEqual(['First project', 'Second project']);
    const status = database.properties.find((prop) => prop.type === 'status');
    expect(status.options.map((option) => option.name)).toEqual(['Not started', 'In progress', 'Done', 'Blocked']);
    expect(database.rows[0].props[database.properties[3].id]).toEqual({ start: '2026-11-20' });
    expect(database.rows[0].props[database.properties[2].id]).toEqual([session.user.id]);

    await page.reload();
    await expect(page.locator('.db-title')).toHaveValue('Projects');
    await expectRows(page, ['First project', 'Second project']);
    await expect(cell(1, 'status').locator('.db-pill')).toHaveText('Blocked');
    // The database is a sub-page in the sidebar; its rows are not listed there.
    await page.locator('.tree-row.is-active .tree-toggle, .tree-row[aria-current] .tree-toggle').first().click().catch(() => {});
    await expect(page.locator('.sidebar')).not.toContainText('First project');
  });

  test('"/board" starts with the Kanban view', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('/board');
    await expect(page.locator('.slash-item.is-active')).toHaveAttribute('data-command', 'board');
    await page.keyboard.press('Enter');
    await expect(page.locator('.database-block .db-board')).toBeVisible();
    await expect(page.locator('.db-tab.is-active')).toHaveText('Board');
    await expect(page.locator('.db-column')).toHaveCount(4);
  });
});

test.describe('Table view', () => {
  test('add a number property, show it as a progress bar, sum it up', async ({ page }) => {
    const database = await makeDatabase(page, { rows: [['Alpha', 'Done'], ['Beta', 'In progress']] });
    await page.goto(`/p/${database.id}`);
    await expect(page.locator('.db-row[data-row]')).toHaveCount(2);

    await page.locator('.db-th-add').click();
    await page.getByRole('menuitem', { name: 'Number' }).click();
    // The new property is ready to be named.
    const name = page.locator('.db-property-name input');
    await expect(name).toBeFocused();
    await name.fill('Completion');
    await name.press('Enter');
    await expect(page.locator('.db-th-name')).toHaveText(['Name', 'Status', 'Assignee', 'Date', 'Completion']);

    const number = (row) => page.locator('.db-row[data-row]').nth(row).locator('.db-cell[data-type="number"]');
    await number(0).click();
    await typeInCell(page, '80');
    await number(1).click();
    await typeInCell(page, '20,5');
    await expect(number(0)).toHaveText('80');

    await page.locator('.db-th', { hasText: 'Completion' }).click();
    await page.locator('.db-property-menu .menu-item', { hasText: 'Show as' }).click();
    await page.getByRole('menuitem', { name: 'Progress bar' }).click();
    await expect(number(0).locator('.db-progress-fill')).toHaveAttribute('style', /width: 80%/);

    await page.locator('.db-calc').hover();
    await page.locator('.db-calc-cell').nth(4).click();
    await page.getByRole('menuitem', { name: 'Sum' }).click();
    await expect(page.locator('.db-calc-cell').nth(4)).toContainText('100.5');

    const stored = await getDatabase(page, database.id);
    const completion = stored.properties.find((prop) => prop.name === 'Completion');
    expect(completion).toMatchObject({ type: 'number', format: 'bar' });
    expect(stored.rows.map((row) => row.props[completion.id])).toEqual([80, 20.5]);
    await expect.poll(async () => (await getDatabase(page, database.id)).views[0].calc).toEqual({ [completion.id]: 'sum' });
  });

  test('sort, filter, search and hiding a property', async ({ page }) => {
    const database = await makeDatabase(page, {
      rows: [['Banana', 'Done'], ['Apple', 'Not started'], ['Cherry', 'Done']],
    });
    await page.goto(`/p/${database.id}`);
    await expect(page.locator('.db-row[data-row]')).toHaveCount(3);
    await expectRows(page, ['Banana', 'Apple', 'Cherry']);

    await page.locator('.db-th', { hasText: 'Name' }).click();
    await page.locator('.db-property-menu .menu-item', { hasText: 'Sort ascending' }).click();
    await expectRows(page, ['Apple', 'Banana', 'Cherry']);
    await expect(page.locator('[data-control="sort"]')).toHaveText('Sort · 1');

    await page.locator('[data-control="filter"]').click();
    await page.locator('.db-rules-add').click();
    await page.getByRole('menuitem', { name: 'Status' }).click();
    await page.locator('.db-rule select[aria-label="Value"]').selectOption({ label: 'Done' });
    await expectRows(page, ['Banana', 'Cherry']);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-control="filter"]')).toHaveText('Filter · 1');
    // A row added while a filter is on gets the value that keeps it visible.
    await page.locator('.db-new').click();
    await typeInCell(page, 'Damson');
    await expectRows(page, ['Banana', 'Cherry', 'Damson']);

    await page.locator('[data-control="search"]').click();
    await page.locator('.db-search').fill('cher');
    await expectRows(page, ['Cherry']);
    await page.locator('.db-search').press('Escape');
    await expectRows(page, ['Banana', 'Cherry', 'Damson']);

    await page.locator('.db-th', { hasText: 'Date' }).click();
    await page.locator('.db-property-menu .menu-item', { hasText: 'Hide in this view' }).click();
    await expect(page.locator('.db-th-name')).toHaveText(['Name', 'Status', 'Assignee']);

    // Filters, sorts and hidden properties belong to the view and are saved.
    await expect
      .poll(async () => {
        const view = (await getDatabase(page, database.id)).views[0];
        return [view.sort.length, view.filter.length, view.hidden.length];
      })
      .toEqual([1, 1, 1]);
    await page.reload();
    await expectRows(page, ['Banana', 'Cherry', 'Damson']);
    await expect(page.locator('.db-th-name')).toHaveText(['Name', 'Status', 'Assignee']);
  });

  test('rows open as pages that show their properties; a row can be deleted and brought back', async ({ page }) => {
    const database = await makeDatabase(page, { rows: [['Write the spec', 'Not started'], ['Ship it', 'Done']] });
    await page.goto(`/p/${database.id}`);
    const first = page.locator('.db-row[data-row]').first();
    await first.hover();
    await first.locator('.db-open-row').click();
    await expect(page).toHaveURL(new RegExp(`/p/${database.rows[0].id}$`));
    await expect(page.locator('.page-title')).toHaveValue('Write the spec');
    await expect(page.locator('.breadcrumbs')).toContainText(database.title);
    const props = page.locator('.row-props');
    await expect(props.locator('.row-prop-name')).toHaveText(['Status', 'Assignee', 'Date']);
    await expect(props.locator('.row-prop-value').first().locator('.db-pill')).toHaveText('Not started');
    // The row is a normal page: it has text of its own.
    await focusEditor(page);
    await page.keyboard.type('Details of the spec');
    await waitForSaved(page);
    // Its properties can be changed right here.
    await props.locator('.row-prop-value').first().click();
    await page.locator('.db-option', { hasText: 'Done' }).click();
    await expect(props.locator('.row-prop-value').first().locator('.db-pill')).toHaveText('Done');
    await expect
      .poll(async () => (await getDatabase(page, database.id)).rows[0].props[database.status.id])
      .toBe(database.status.options.find((option) => option.name === 'Done').id);

    await page.goBack();
    await expect(page.locator('.db-row[data-row]')).toHaveCount(2);
    const row = page.locator('.db-row[data-row]', { hasText: 'Ship it' });
    await row.hover();
    await row.locator('.db-row-handle').click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.locator('.db-row[data-row]')).toHaveCount(1);
    await page.locator('.toast-action', { hasText: 'Undo' }).click();
    await expect(page.locator('.db-row[data-row]')).toHaveCount(2);
  });
});

test.describe('Board view', () => {
  test('cards are grouped by status; dragging a card changes its status', async ({ page }) => {
    const database = await makeDatabase(page, {
      view: 'board',
      rows: [['Design', 'Not started'], ['Build', 'Not started'], ['Test', 'In progress'], ['Idea', null]],
    });
    await page.goto(`/p/${database.id}`);
    const column = (name) => page.locator('.db-column', { has: page.locator('.db-column-head', { hasText: name }) });
    await expect(page.locator('.db-column-head')).toContainText(['No Status', 'Not started', 'In progress', 'Done']);
    await expect(column('Not started').locator('.db-card-title')).toHaveText(['Design', 'Build']);
    await expect(column('Not started').locator('.db-column-count')).toHaveText('2');
    await expect(column('No Status').locator('.db-card-title')).toHaveText(['Idea']);

    await column('Not started').locator('.db-card', { hasText: 'Design' }).dragTo(column('Done').locator('.db-cards'));
    await expect(column('Done').locator('.db-card-title')).toHaveText(['Design']);
    await expect(column('Not started').locator('.db-card-title')).toHaveText(['Build']);
    const done = database.status.options.find((option) => option.name === 'Done').id;
    await expect
      .poll(async () => (await getDatabase(page, database.id)).rows.find((row) => row.title === 'Design').props[database.status.id])
      .toBe(done);

    // A card made in a column belongs to that column.
    await column('In progress').locator('.db-add-card').click();
    await typeInCell(page, 'Review');
    await expect(column('In progress').locator('.db-card-title')).toHaveText(['Test', 'Review']);
    const progress = database.status.options.find((option) => option.name === 'In progress').id;
    await expect
      .poll(async () => (await getDatabase(page, database.id)).rows.find((row) => row.title === 'Review')?.props[database.status.id])
      .toBe(progress);

    // A new group is a new option of the property.
    await page.locator('.db-add-group').click();
    await page.locator('.modal input').fill('Blocked');
    await page.keyboard.press('Enter');
    await expect(page.locator('.db-column-head')).toContainText(['No Status', 'Not started', 'In progress', 'Done', 'Blocked']);

    // Clicking a card opens its page.
    await column('Done').locator('.db-card').click();
    await expect(page.locator('.page-title')).toHaveValue('Design');
  });

  test('group by person: a board of who does what', async ({ page }) => {
    const database = await makeDatabase(page, { view: 'board', rows: [['Mine', 'Done'], ['Nobody’s', 'Done']] });
    const person = database.properties.find((prop) => prop.type === 'person');
    await api(page, session, 'PATCH', `/api/databases/${database.id}/rows/${database.rows[0].id}`, {
      props: { [person.id]: [session.user.id] },
    });
    await page.goto(`/p/${database.id}`);
    await page.locator('.db-tab.is-active').click();
    await page.getByRole('menuitem', { name: 'Group by' }).hover();
    await page.getByRole('menuitem', { name: 'Assignee' }).click();
    const column = (name) => page.locator('.db-column', { has: page.locator('.db-column-head', { hasText: name }) });
    await expect(column('alice').locator('.db-card-title')).toHaveText(['Mine']);
    await expect(column('Unassigned').locator('.db-card-title')).toHaveText(['Nobody’s']);
    // Hand the unassigned card to bob by dragging it into his column.
    await column('Unassigned').locator('.db-card').dragTo(column('bob').locator('.db-cards'));
    await expect(column('bob').locator('.db-card-title')).toHaveText(['Nobody’s']);
    const users = (await (await page.request.get('/api/bootstrap')).json()).users;
    const bob = users.find((user) => user.username === 'bob').id;
    await expect
      .poll(async () => (await getDatabase(page, database.id)).rows[1].props[person.id])
      .toEqual([bob]);
  });
});

test('someone who can only view a database sees it without the editing controls', async ({ page, browser }) => {
  const database = await makeDatabase(page, { rows: [['Read me', 'Done']] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const bobPage = await context.newPage();
  const bob = await signIn(bobPage, 'bob');
  await api(page, session, 'PUT', `/api/pages/${database.id}/shares/${bob.user.id}`, { role: 'viewer' });
  await bobPage.goto(`/p/${database.id}`);
  await expect(bobPage.locator('.db-row[data-row]')).toHaveCount(1);
  await expect(bobPage.locator('.db-new, .db-add-row, .db-th-add, .db-row-handle')).toHaveCount(0);
  await bobPage.locator('.db-cell[data-type="status"]').click();
  await expect(bobPage.locator('.db-option-editor')).toHaveCount(0);
  // The name still leads to the page of the row.
  await bobPage.locator('.db-cell-title').click();
  await expect(bobPage.locator('.page-title')).toHaveValue('Read me');
  await expect(bobPage.locator('.row-prop-value.is-editable')).toHaveCount(0);
  await context.close();
});
