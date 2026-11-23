// Simple tables: the controls and keys Notion users expect.
import { expect, test } from '@playwright/test';
import { clickInto, doc, editor, openNewPage, signIn, storedContent, waitForSaved } from './helpers.js';

let session;

test.beforeEach(async ({ page }) => {
  session = await signIn(page);
});

const cell = (text, type = 'tableCell') => ({
  type,
  content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
});
const table = (rows, { header = true } = {}) => ({
  type: 'table',
  content: rows.map((row, index) => ({
    type: 'tableRow',
    content: row.map((text) => cell(text, header && index === 0 ? 'tableHeader' : 'tableCell')),
  })),
});
const texts = (page) =>
  editor(page).locator('table tr').evaluateAll((rows) => rows.map((row) => [...row.cells].map((item) => item.textContent)));

async function dragFrom(page, locator, dx, dy) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

test('cells are clean, the cell with the caret is framed, controls appear on hover only', async ({ page }) => {
  await openNewPage(page, session, { content: doc(table([['A', 'B'], ['', '']])) });
  const cells = editor(page).locator('td');
  // No "Type / for blocks" in an empty cell.
  await clickInto(cells.first());
  const hint = await cells.first().locator('p').evaluate((el) => getComputedStyle(el, '::before').content);
  expect(hint).toBe('none');
  await expect(cells.first()).toHaveClass(/is-current-cell/);
  await expect(cells.nth(1)).not.toHaveClass(/is-current-cell/);

  await page.mouse.move(5, 5);
  for (const control of ['.table-add-row', '.table-add-column', '.table-handle-row', '.table-handle-column']) {
    await expect(page.locator(control)).toBeHidden();
  }
  await cells.nth(1).hover();
  for (const control of ['.table-add-row', '.table-add-column', '.table-handle-row', '.table-handle-column']) {
    await expect(page.locator(control)).toBeVisible();
  }
  // The column handle sits on the top edge of the hovered column.
  const handle = await page.locator('.table-handle-column').boundingBox();
  const hovered = await cells.nth(1).boundingBox();
  const tableBox = await editor(page).locator('table').boundingBox();
  expect(Math.abs(handle.x + handle.width / 2 - (hovered.x + hovered.width / 2))).toBeLessThan(3);
  expect(Math.abs(handle.y + handle.height / 2 - tableBox.y)).toBeLessThan(4);
});

test('the bars add a row or a column on click and several by dragging; dragging back removes empty ones', async ({
  page,
}) => {
  const created = await openNewPage(page, session, { content: doc(table([['A', 'B'], ['1', '2']])) });
  const rows = editor(page).locator('table tr');
  await editor(page).locator('td').first().hover();
  await page.locator('.table-add-row').click();
  await expect(rows).toHaveCount(3);
  // The caret is in the new row: typing fills it.
  await page.keyboard.type('new');
  expect(await texts(page)).toEqual([['A', 'B'], ['1', '2'], ['new', '']]);

  await editor(page).locator('td').first().hover();
  await dragFrom(page, page.locator('.table-add-row'), 0, 34 * 3);
  await expect(rows).toHaveCount(6);
  // Back up past the start: the three empty rows go, the row with text stays.
  await editor(page).locator('td').first().hover();
  await dragFrom(page, page.locator('.table-add-row'), 0, -34 * 5);
  await expect(rows).toHaveCount(3);

  await editor(page).locator('td').first().hover();
  await page.locator('.table-add-column').click();
  await expect(rows.first().locator('th')).toHaveCount(3);
  await editor(page).locator('td').first().hover();
  await dragFrom(page, page.locator('.table-add-column'), 110 * 2, 0);
  await expect(rows.first().locator('th')).toHaveCount(5);
  await editor(page).locator('td').first().hover();
  await dragFrom(page, page.locator('.table-add-column'), -110 * 6, 0);
  await expect(rows.first().locator('th')).toHaveCount(2);

  await waitForSaved(page);
  const stored = await storedContent(page, created.id);
  expect(stored.content[0].content).toHaveLength(3);
});

test('row and column handles: insert, clear, delete, header', async ({ page }) => {
  await openNewPage(page, session, { content: doc(table([['A', 'B', 'C'], ['1', '2', '3'], ['4', '5', '6']])) });
  const body = editor(page);
  const menu = async (handle, cellLocator, item) => {
    await cellLocator.hover();
    await page.locator(handle).click();
    await page.getByRole('menuitem', { name: item, exact: true }).click();
  };
  await menu('.table-handle-column', body.locator('td', { hasText: '2' }), 'Insert left');
  expect(await texts(page)).toEqual([['A', '', 'B', 'C'], ['1', '', '2', '3'], ['4', '', '5', '6']]);
  await menu('.table-handle-column', body.locator('td', { hasText: '2' }), 'Clear contents');
  expect(await texts(page)).toEqual([['A', '', '', 'C'], ['1', '', '', '3'], ['4', '', '', '6']]);
  await menu('.table-handle-column', body.locator('td', { hasText: '3' }), 'Delete column');
  expect(await texts(page)).toEqual([['A', '', ''], ['1', '', ''], ['4', '', '']]);

  await menu('.table-handle-row', body.locator('td', { hasText: '1' }), 'Insert below');
  await expect(body.locator('tr')).toHaveCount(4);
  await menu('.table-handle-row', body.locator('td', { hasText: '4' }), 'Delete row');
  expect(await texts(page)).toEqual([['A', '', ''], ['1', '', ''], ['', '', '']]);

  // The first row and the first column can be headers.
  await expect(body.locator('tr').first().locator('th')).toHaveCount(3);
  await menu('.table-handle-row', body.locator('th').first(), 'Header row');
  await expect(body.locator('th')).toHaveCount(0);
  await menu('.table-handle-column', body.locator('td').first(), 'Header column');
  await expect(body.locator('tr').nth(1).locator('th')).toHaveCount(1);
  await expect(body.locator('th')).toHaveCount(3);
});

test('dragging a handle moves the column or the row', async ({ page }) => {
  await openNewPage(page, session, { content: doc(table([['A', 'B', 'C'], ['1', '2', '3'], ['4', '5', '6']], { header: false })) });
  const body = editor(page);
  await body.locator('td', { hasText: 'A' }).hover();
  const target = await body.locator('td', { hasText: 'C' }).boundingBox();
  const handle = await page.locator('.table-handle-column').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 20, handle.y + 4, { steps: 5 });
  await expect(page.locator('.table-move-line')).toBeVisible();
  await page.mouse.move(target.x + target.width - 10, handle.y + 4, { steps: 5 });
  await page.mouse.up();
  expect(await texts(page)).toEqual([['B', 'C', 'A'], ['2', '3', '1'], ['5', '6', '4']]);

  await body.locator('td', { hasText: '5' }).hover();
  const row = await page.locator('.table-handle-row').boundingBox();
  const first = await body.locator('td', { hasText: 'B' }).boundingBox();
  await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(row.x + 4, first.y + 12, { steps: 5 });
  await page.mouse.move(row.x + 4, first.y + 4, { steps: 3 });
  await page.mouse.up();
  expect(await texts(page)).toEqual([['5', '6', '4'], ['B', 'C', 'A'], ['2', '3', '1']]);
});

test('Enter goes to the cell below and adds a row at the end; Shift+Enter breaks the line', async ({ page }) => {
  const created = await openNewPage(page, session, { content: doc(table([['A', 'B'], ['', '']])) });
  await clickInto(editor(page).locator('th').first());
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('below A');
  await page.keyboard.press('Enter'); // last row: a new one appears
  await page.keyboard.type('third');
  await page.keyboard.press('Tab');
  await page.keyboard.type('line one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('line two');
  await expect(editor(page).locator('tr')).toHaveCount(3);
  await waitForSaved(page);
  const stored = await storedContent(page, created.id);
  const rowTexts = stored.content[0].content.map((row) =>
    row.content.map((item) => item.content.map((block) => (block.content ?? []).map((node) => node.text ?? '\n').join('')).join('|')),
  );
  expect(rowTexts).toEqual([['A', 'B'], ['below A', ''], ['third', 'line one\nline two']]);
});
