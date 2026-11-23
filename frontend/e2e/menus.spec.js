// Right-click menus and the Notion-style property menus of databases and tables.
import { expect, test } from '@playwright/test';
import { api, doc, editor, openNewPage, personalWorkspaceId, signIn } from './helpers.js';

let session;

test.beforeEach(async ({ page }) => {
  session = await signIn(page);
});

async function makeDatabase(page, rows) {
  const created = await api(page, session, 'POST', '/api/databases', {
    workspace_id: await personalWorkspaceId(page),
    title: `Menus ${Date.now()}`,
    view: 'table',
  });
  let database = await (await page.request.get(`/api/databases/${created.id}`)).json();
  const status = database.properties.find((prop) => prop.type === 'status');
  for (const [name, state] of rows) {
    const option = status.options.find((item) => item.name === state);
    await api(page, session, 'POST', `/api/databases/${created.id}/rows`, {
      title: name,
      props: option ? { [status.id]: option.id } : {},
    });
  }
  database = await (await page.request.get(`/api/databases/${created.id}`)).json();
  const fresh = async () => (await page.request.get(`/api/databases/${created.id}`)).json();
  return { ...database, status, fresh };
}

const menuRow = (page, text) => page.locator('.db-property-menu .menu-item', { hasText: text });

test('right click on a column header: the property menu, laid out as in Notion', async ({ page }) => {
  const database = await makeDatabase(page, [['Alpha', 'Done'], ['Beta', 'Not started']]);
  await page.goto(`/p/${database.id}`);
  await expect(page.locator('.db-row[data-row]')).toHaveCount(2);
  await page.locator('.db-th', { hasText: 'Status' }).click({ button: 'right' });
  const menu = page.locator('.db-property-menu');
  await expect(menu.locator('.db-property-name input')).toHaveValue('Status');
  await expect(menu.locator('.menu-item .menu-label')).toHaveText([
    'Edit property',
    'Change type',
    'Filter',
    'Sort',
    'Group',
    'Calculate',
    'Hide',
    'Wrap content',
    'Insert left',
    'Insert right',
    'Duplicate property',
    'Delete property',
  ]);

  // Duplicate: a copy with the same values, right next to it.
  await menuRow(page, 'Duplicate property').click();
  await expect(page.locator('.db-th-name')).toHaveText(['Name', 'Status', 'Status 1', 'Assignee', 'Date']);
  await expect(page.locator('.db-row[data-row]').first().locator('.db-cell[data-type="status"] .db-pill')).toHaveText(['Done', 'Done']);

  // Insert left of "Assignee": a new property exactly there, ready to be named.
  await page.locator('.db-th', { hasText: 'Assignee' }).click({ button: 'right' });
  await menuRow(page, 'Insert left').click();
  await page.getByRole('menuitem', { name: 'Text' }).click();
  await page.locator('.db-property-name input').fill('Notes');
  await page.keyboard.press('Enter');
  await expect(page.locator('.db-th-name')).toHaveText(['Name', 'Status', 'Status 1', 'Notes', 'Assignee', 'Date']);

  // Wrap content: long text is shown in full instead of being cut.
  const cell = page.locator('.db-row[data-row]').first().locator('.db-cell[data-type="text"]');
  await cell.click();
  await page.locator('.db-inline-input').fill('a long note that does not fit into one narrow column of the table at all');
  await page.keyboard.press('Enter');
  const before = (await cell.boundingBox()).height;
  await page.locator('.db-th', { hasText: 'Notes' }).click();
  await menuRow(page, 'Wrap content').click();
  await expect(cell).toHaveClass(/is-wrapped/);
  expect((await cell.boundingBox()).height).toBeGreaterThan(before + 10);
  await page.locator('.db-th', { hasText: 'Notes' }).click();
  await expect(menuRow(page, 'Unwrap content')).toBeVisible();
  await page.keyboard.press('Escape');

  // Calculate and Sort from the same menu.
  await page.locator('.db-th', { hasText: 'Name' }).click({ button: 'right' });
  await menuRow(page, 'Calculate').click();
  await page.getByRole('menuitem', { name: 'Count all' }).click();
  await expect(page.locator('.db-calc-cell').first()).toContainText('2');
  await page.locator('.db-th', { hasText: 'Name' }).click();
  await menuRow(page, 'Sort').click();
  await page.getByRole('menuitem', { name: 'Descending' }).click();
  await expect(page.locator('.db-cell-title .db-text')).toHaveText(['Beta', 'Alpha']);

  await expect
    .poll(async () => {
      const stored = await database.fresh();
      return [stored.properties.map((prop) => prop.name), stored.views[0].wrap.length, stored.views[0].sort[0]?.direction];
    })
    .toEqual([['Name', 'Status', 'Status 1', 'Assignee', 'Date', 'Notes'], 1, 'desc']);
});

test('options: name, colour swatches and stage, edited the way Notion does it', async ({ page }) => {
  const database = await makeDatabase(page, [['Alpha', 'Not started']]);
  await page.goto(`/p/${database.id}`);
  const cell = page.locator('.db-cell[data-type="status"]');
  await cell.click();
  // A status lists its options by stage, with "Edit property" below.
  const picker = page.locator('.db-option-editor');
  await expect(picker.locator('.db-option-group')).toHaveText(['To-do', 'In progress', 'Complete']);
  await expect(picker).not.toContainText('null');
  await picker.locator('.db-option-settings').click();
  const panel = page.locator('.db-property-edit');
  await expect(panel.locator('.db-options-head span')).toHaveText(['To-do', 'In progress', 'Complete']);

  // One option: a name field, Delete, the stage and the colours with a swatch each.
  await panel.locator('.db-option-row', { hasText: 'Not started' }).click();
  const edit = page.locator('.db-option-edit');
  await expect(edit.locator('input')).toHaveValue('Not started');
  await expect(edit.locator('input')).toBeFocused();
  await expect(edit.locator('.db-swatch')).toHaveCount(10);
  await edit.locator('input').fill('Backlog');
  await edit.locator('.menu-item', { hasText: 'Purple' }).click();
  await edit.locator('.menu-item', { hasText: 'In progress' }).click();
  await page.keyboard.press('Escape');
  // The value in the table follows at once.
  await expect(cell.locator('.db-pill')).toHaveText('Backlog');
  await expect(cell.locator('.db-pill')).toHaveAttribute('data-color', 'purple');

  // "+" next to a stage adds an option to that stage.
  await panel.getByRole('button', { name: 'Add an option to Complete' }).click();
  await page.locator('.db-property-edit input[aria-label="New option"]').fill('Archived');
  await page.keyboard.press('Enter');
  await expect(panel.locator('.db-option-row')).toHaveText(['Backlog', 'In progress', 'Done', 'Archived']);
  await expect
    .poll(async () => (await database.fresh()).properties[1].options.map((option) => [option.name, option.color, option.group]))
    .toEqual([
      ['Backlog', 'purple', 'in_progress'],
      ['In progress', 'blue', 'in_progress'],
      ['Done', 'green', 'complete'],
      ['Archived', expect.any(String), 'complete'],
    ]);

  // Deleting an option clears it from the rows that had it.
  await panel.locator('.db-option-row', { hasText: 'Backlog' }).click();
  await page.locator('.db-option-edit .menu-item', { hasText: 'Delete' }).click();
  await expect(panel.locator('.db-option-row')).toHaveText(['In progress', 'Done', 'Archived']);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(cell.locator('.db-pill')).toHaveCount(0);
});

test('right click on a row: open beside, as a page or in a new tab; duplicate; delete', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const database = await makeDatabase(page, [['Alpha', 'Done'], ['Beta', 'Not started']]);
  await page.goto(`/p/${database.id}`);
  const row = (name) => page.locator('.db-row[data-row]', { hasText: name });
  await row('Alpha').locator('.db-cell[data-type="person"]').click({ button: 'right' });
  await expect(page.getByRole('menuitem')).toContainText([
    'Open in side peek',
    'Open as a full page',
    'Open in a new tab',
    'Copy link',
    'Duplicate',
    'Add a row below',
    'Delete',
  ]);
  await page.getByRole('menuitem', { name: 'Open in side peek' }).click();
  await expect(page.locator('.peek .page-title')).toHaveValue('Alpha');
  await page.getByRole('button', { name: 'Close side peek' }).click();

  await row('Alpha').locator('.db-cell-title').click({ button: 'right' });
  const [tab] = await Promise.all([context.waitForEvent('page'), page.getByRole('menuitem', { name: 'Open in a new tab' }).click()]);
  await expect(tab).toHaveURL(new RegExp(`/p/${database.rows[0].id}$`));
  await tab.close();

  await row('Alpha').locator('.db-cell-title').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy link' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`/p/${database.rows[0].id}$`));

  // Duplicate keeps the values.
  await row('Alpha').first().locator('.db-cell-title').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(page.locator('.db-row[data-row]')).toHaveCount(3);
  await expect(page.locator('.db-row[data-row]', { hasText: 'Alpha (copy)' }).locator('.db-pill')).toHaveText('Done');

  await row('Beta').locator('.db-cell-title').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Delete/ }).click();
  await expect(page.locator('.db-row[data-row]')).toHaveCount(2);
  await expect(row('Beta')).toHaveCount(0);

  // The same menu on a card of the board.
  await page.locator('.db-tab', { hasText: 'Board' }).click();
  await page.locator('.db-card', { hasText: 'Alpha (copy)' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open as a full page' }).click();
  await expect(page.locator('.page-title')).toHaveValue('Alpha (copy)');
});

test('right click in a simple table: rows, columns and headers in one menu', async ({ page }) => {
  const cell = (text, type = 'tableCell') => ({
    type,
    content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
  });
  await openNewPage(page, session, {
    content: doc({
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell('A', 'tableHeader'), cell('B', 'tableHeader')] },
        { type: 'tableRow', content: [cell('1'), cell('2')] },
      ],
    }),
  });
  const texts = () =>
    editor(page).locator('table tr').evaluateAll((rows) => rows.map((row) => [...row.cells].map((item) => item.textContent)));
  const choose = async (text, item) => {
    await editor(page).locator('td, th', { hasText: text }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: item, exact: true }).click();
  };
  await choose('2', 'Insert row below');
  await choose('2', 'Insert column left');
  expect(await texts()).toEqual([['A', '', 'B'], ['1', '', '2'], ['', '', '']]);
  await choose('1', 'Clear row');
  expect(await texts()).toEqual([['A', '', 'B'], ['', '', ''], ['', '', '']]);
  await choose('B', 'Delete column');
  await choose('A', 'Header row');
  await expect(editor(page).locator('th')).toHaveCount(0);
  expect(await texts()).toEqual([['A', ''], ['', ''], ['', '']]);
  await choose('A', 'Delete row');
  await expect(editor(page).locator('tr')).toHaveCount(2);
  await editor(page).locator('td').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete table' }).click();
  await expect(editor(page).locator('table')).toHaveCount(0);
});
