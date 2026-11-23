// Keyboard and mouse habits from Notion: block selection, turn-into keys,
// shortcuts that work on a Cyrillic layout, and opening pages in a new tab.
import { expect, test } from '@playwright/test';
import {
  api,
  blockTexts,
  clickInto,
  doc,
  editor,
  mod,
  openNewPage,
  paragraph,
  signIn,
  storedContent,
  waitForSaved,
} from './helpers.js';

let session;

test.beforeEach(async ({ page }) => {
  session = await signIn(page);
});

/** A key press as a Bulgarian keyboard layout sends it: a Cyrillic letter on the same physical key. */
async function pressCyrillic(page, letter, code, modifiers = {}) {
  await page.evaluate(
    ({ letter, code, modifiers }) => {
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: letter, code, bubbles: true, cancelable: true, ...modifiers }),
      );
    },
    { letter, code, modifiers },
  );
}

test.describe('Selecting blocks', () => {
  test('Esc selects the block; arrows move, Enter edits, Delete removes it', async ({ page }) => {
    await openNewPage(page, session, { content: doc('first', 'second', 'third', 'fourth') });
    await clickInto(editor(page).locator('p', { hasText: 'second' }));
    await page.keyboard.press('Escape');
    const selected = editor(page).locator('.ProseMirror-selectednode');
    await expect(selected).toHaveText('second');
    // A soft tint, not a hard frame.
    expect(await selected.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');

    await page.keyboard.press('ArrowDown');
    await expect(selected).toHaveText('third');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(selected).toHaveText('first');
    await page.keyboard.press('Delete');
    expect(await blockTexts(page)).toEqual(['second', 'third', 'fourth']);

    await clickInto(editor(page).locator('p', { hasText: 'third' }));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Backspace');
    expect(await blockTexts(page)).toEqual(['second', 'fourth']);

    // Enter goes back to writing, at the end of the block.
    await clickInto(editor(page).locator('p', { hasText: 'second' }));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await expect(selected).toHaveCount(0);
    await page.keyboard.type('!');
    expect(await blockTexts(page)).toEqual(['second!', 'fourth']);
    // Typing with a block selected continues it instead of replacing it.
    await page.keyboard.press('Escape');
    await page.keyboard.type('?');
    expect(await blockTexts(page)).toEqual(['second!?', 'fourth']);
  });

  test('the selection walks through list items and into and out of lists', async ({ page }) => {
    const list = {
      type: 'bulletList',
      content: ['one', 'two'].map((text) => ({ type: 'listItem', content: [paragraph(text)] })),
    };
    await openNewPage(page, session, { content: doc('before', list, 'after') });
    await clickInto(editor(page).locator('p', { hasText: 'before' }));
    await page.keyboard.press('Escape');
    const selected = editor(page).locator('.ProseMirror-selectednode');
    for (const expected of ['one', 'two', 'after']) {
      await page.keyboard.press('ArrowDown');
      await expect(selected).toHaveText(expected);
    }
    await page.keyboard.press('ArrowUp');
    await expect(selected).toHaveText('two');
    await page.keyboard.press('Delete');
    await expect(editor(page).locator('li')).toHaveText(['one']);
  });

  test('the block menu marks its block; Del deletes it, Ctrl+D duplicates it', async ({ page }) => {
    await openNewPage(page, session, { content: doc('keep', 'remove me', 'copy me') });
    const open = async (text) => {
      await editor(page).locator('p', { hasText: text }).hover({ position: { x: 20, y: 8 } });
      await page.locator('.block-grip').click();
      await expect(page.locator('.menu')).toBeVisible();
    };
    await open('remove me');
    await expect(editor(page).locator('.ProseMirror-selectednode')).toHaveText('remove me');
    await expect(page.locator('.menu-item', { hasText: 'Delete' }).locator('.menu-hint')).toHaveText('Del');
    await page.keyboard.press('Delete');
    await expect(page.locator('.menu')).toHaveCount(0);
    expect(await blockTexts(page)).toEqual(['keep', 'copy me']);
    await open('copy me');
    await page.keyboard.press(`${mod}+d`);
    expect(await blockTexts(page)).toEqual(['keep', 'copy me', 'copy me']);
  });
});

test.describe('Shortcuts', () => {
  test('Ctrl+Shift+0 … 8 turn the block into another kind', async ({ page }) => {
    const created = await openNewPage(page, session, { content: doc('a line') });
    const body = editor(page);
    await clickInto(body.locator('p').first());
    const expectations = [
      ['1', 'h1'],
      ['2', 'h2'],
      ['3', 'h3'],
      ['4', 'ul[data-type="taskList"] li p'],
      ['5', 'ul:not([data-type]) > li'],
      ['6', 'ol > li'],
      ['7', 'div[data-type="details"] summary'],
      ['8', '.code-block'],
      ['0', ':scope > p'],
    ];
    for (const [digit, selector] of expectations) {
      await page.keyboard.press(`${mod}+Shift+Digit${digit}`);
      await expect(body.locator(selector).first(), `Ctrl+Shift+${digit}`).toContainText('a line');
    }
    await waitForSaved(page);
    expect((await storedContent(page, created.id)).content[0].type).toBe('paragraph');
  });

  test('Ctrl+Enter ticks a to-do item; Ctrl+Shift+↑/↓ move a block', async ({ page }) => {
    await openNewPage(page, session, {
      content: doc('first', { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [paragraph('task')] }] }),
    });
    await clickInto(editor(page).locator('li p'));
    await page.keyboard.press(`${mod}+Enter`);
    await expect(editor(page).locator('li')).toHaveAttribute('data-checked', 'true');
    await page.keyboard.press(`${mod}+Enter`);
    await expect(editor(page).locator('li')).toHaveAttribute('data-checked', 'false');

    await clickInto(editor(page).locator(':scope > p', { hasText: 'first' }));
    await page.keyboard.press(`${mod}+Shift+ArrowDown`);
    await expect(editor(page).locator(':scope > *').first()).toHaveAttribute('data-type', 'taskList');
    await page.keyboard.press(`${mod}+Shift+ArrowUp`);
    await expect(editor(page).locator(':scope > *').first()).toHaveText('first');
  });

  test('shortcuts work on a Bulgarian keyboard layout', async ({ page }) => {
    await openNewPage(page, session, { content: doc('text') });
    await page.locator('.page-title').focus();
    // Ctrl+K: the K key types "к" there.
    await pressCyrillic(page, 'к', 'KeyK', { ctrlKey: true });
    await expect(page.locator('.palette-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.palette')).toHaveCount(0);
    // Ctrl+P searches too.
    await page.keyboard.press(`${mod}+p`);
    await expect(page.locator('.palette-input')).toBeFocused();
    await page.keyboard.press('Escape');
    // Ctrl+Shift+L: light / dark ("л" on that key).
    const before = await page.evaluate(() => document.documentElement.dataset.theme);
    await pressCyrillic(page, 'Л', 'KeyL', { ctrlKey: true, shiftKey: true });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).not.toBe(before);
    await pressCyrillic(page, 'Л', 'KeyL', { ctrlKey: true, shiftKey: true });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(before);
    // Ctrl+\ hides the sidebar, whatever character that key carries.
    await pressCyrillic(page, 'ю', 'Backslash', { ctrlKey: true });
    await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
    await pressCyrillic(page, 'ю', 'Backslash', { ctrlKey: true });
    await expect(page.getByRole('button', { name: 'Hide sidebar' })).toBeVisible();
    // In the editor: Ctrl+B with the Cyrillic letter of that key.
    await clickInto(editor(page).locator('p').first());
    await page.keyboard.press(`${mod}+a`);
    await page.waitForTimeout(60);
    await page.evaluate(() => {
      document.querySelector('.doc').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'б', code: 'KeyB', keyCode: 66, ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    await expect(editor(page).locator('strong')).toHaveText('text');
  });

  test('Ctrl+Shift+U goes to the parent page', async ({ page }) => {
    const parent = await openNewPage(page, session, { title: `Parent ${Date.now()}` });
    const child = await api(page, session, 'POST', '/api/pages', { title: 'Child', parent_id: parent.id });
    await page.goto(`/p/${child.id}`);
    await expect(page.locator('.page-title')).toHaveValue('Child');
    await page.keyboard.press(`${mod}+Shift+u`);
    await expect(page).toHaveURL(new RegExp(`/p/${parent.id}$`));
  });
});

test.describe('Opening in a new tab', () => {
  test('middle button and Ctrl+click: sidebar, page links, search', async ({ page, context }) => {
    const stamp = Date.now();
    const parent = await openNewPage(page, session, { title: `Hub ${stamp}` });
    const child = await api(page, session, 'POST', '/api/pages', { title: `Leaf ${stamp}`, parent_id: parent.id });
    await page.reload();
    await expect(editor(page).locator('.page-link')).toContainText(`Leaf ${stamp}`);
    const opensTab = async (action) => {
      const [tab] = await Promise.all([context.waitForEvent('page'), action()]);
      await expect(tab).toHaveURL(new RegExp(`/p/${child.id}$`));
      await tab.close();
      // The current tab stays where it was.
      await expect(page).toHaveURL(new RegExp(`/p/${parent.id}$`));
    };
    // A sub-page link inside the document.
    await opensTab(() => editor(page).locator('.page-link').click({ button: 'middle' }));
    await opensTab(() => editor(page).locator('.page-link').click({ modifiers: ['ControlOrMeta'] }));
    // The page tree.
    const row = page.locator('.sidebar .tree-row', { hasText: `Leaf ${stamp}` });
    if (!(await row.count())) await page.locator('.sidebar .tree-row.is-active .tree-toggle').click();
    await opensTab(() => row.click({ button: 'middle' }));
    await opensTab(() => row.click({ modifiers: ['ControlOrMeta'] }));
    // Search results: Ctrl+Enter.
    await page.keyboard.press(`${mod}+k`);
    await page.locator('.palette-input').fill(`Leaf ${stamp}`);
    await expect(page.locator('.palette-item').first()).toContainText(`Leaf ${stamp}`);
    await opensTab(() => page.keyboard.press(`${mod}+Enter`));
    await page.keyboard.press('Escape');
    // A plain click still opens it here.
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/p/${child.id}$`));
  });

  test('database rows and cards open in a new tab with the middle button', async ({ page, context }) => {
    const created = await api(page, session, 'POST', '/api/databases', {
      workspace_id: (await (await page.request.get('/api/bootstrap')).json()).workspaces.find((w) => w.kind === 'personal').id,
      title: `Tabs ${Date.now()}`,
      view: 'table',
    });
    const row = await api(page, session, 'POST', `/api/databases/${created.id}/rows`, { title: 'Open me' });
    await page.goto(`/p/${created.id}`);
    const cell = page.locator('.db-cell-title', { hasText: 'Open me' });
    await expect(cell).toBeVisible();
    const [fromTable] = await Promise.all([context.waitForEvent('page'), cell.click({ button: 'middle' })]);
    await expect(fromTable).toHaveURL(new RegExp(`/p/${row.id}$`));
    await fromTable.close();
    await page.locator('.db-tab', { hasText: 'Board' }).click();
    const card = page.locator('.db-card', { hasText: 'Open me' });
    const [fromBoard] = await Promise.all([context.waitForEvent('page'), card.click({ modifiers: ['ControlOrMeta'] })]);
    await expect(fromBoard).toHaveURL(new RegExp(`/p/${row.id}$`));
    await fromBoard.close();
    await expect(page).toHaveURL(new RegExp(`/p/${created.id}$`));
  });
});
