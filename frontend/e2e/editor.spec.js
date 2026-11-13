import { expect, test } from '@playwright/test';
import {
  blockTexts,
  clickInto,
  doc,
  editor,
  focusEditor,
  mod,
  openNewPage,
  signIn,
  storedContent,
  waitForSaved,
} from './helpers.js';

let session;

test.beforeEach(async ({ page }) => {
  session = await signIn(page);
});

test.describe('Markdown shortcuts', () => {
  const cases = [
    ['# ', 'h1'],
    ['## ', 'h2'],
    ['### ', 'h3'],
    ['- ', 'ul > li'],
    ['1. ', 'ol > li'],
    ['[] ', 'ul[data-type="taskList"] > li > div'],
    ['> ', 'blockquote'],
    ['``` ', '.code-block code'],
  ];
  for (const [input, selector] of cases) {
    test(`"${input.trim()}" + Space → ${selector}`, async ({ page }) => {
      await openNewPage(page, session);
      await focusEditor(page);
      await page.keyboard.type(`${input}Hello`);
      const block = editor(page).locator(selector).first();
      await expect(block).toHaveText('Hello');
      // The Markdown marker itself is gone.
      await expect(editor(page)).not.toContainText(input.trim());
    });
  }

  test('"---" + Space → divider', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('---');
    await expect(editor(page).locator('hr')).toHaveCount(0); // waits for the space
    await page.keyboard.type(' after');
    await expect(editor(page).locator('hr')).toHaveCount(1);
    await expect(editor(page).locator('hr + p')).toHaveText('after');
  });

  test('markers in the middle of a sentence stay plain text', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('Issue # 42 is > 3 and - fine');
    await expect(editor(page).locator('p').first()).toHaveText('Issue # 42 is > 3 and - fine');
    await expect(editor(page).locator('h1, blockquote, ul')).toHaveCount(0);
  });

  test('inline rules: **bold**, *italic*, ~~strike~~, `code`', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('**bold** *italic* ~~strike~~ `code` ');
    const first = editor(page).locator('p').first();
    await expect(first.locator('strong')).toHaveText('bold');
    await expect(first.locator('em')).toHaveText('italic');
    await expect(first.locator('s')).toHaveText('strike');
    await expect(first.locator('code')).toHaveText('code');
    await expect(first).not.toContainText('*');
  });

  test('undo reverts an automatic conversion, redo applies it again', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('# Title');
    await expect(editor(page).locator('h1')).toHaveText('Title');

    // Undo takes the conversion back (typing is grouped by the history).
    await page.keyboard.press(`${mod}+z`);
    await page.keyboard.press(`${mod}+z`);
    await expect(editor(page).locator('h1')).toHaveCount(0);
    await expect(editor(page)).not.toContainText('Title');

    await page.keyboard.press(`${mod}+Shift+z`);
    await page.keyboard.press(`${mod}+Shift+z`);
    await expect(editor(page).locator('h1')).toHaveText('Title');
    await expect(editor(page)).not.toContainText('#');
  });

  test('undo after a pause only reverts the conversion', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('plain text');
    await page.waitForTimeout(700); // a new undo group starts after a pause
    await page.keyboard.press('Home');
    await page.keyboard.type('> ');
    await expect(editor(page).locator('blockquote')).toHaveText('plain text');
    await page.keyboard.press(`${mod}+z`);
    await expect(editor(page).locator('blockquote')).toHaveCount(0);
    await expect(editor(page).locator('p').first()).toContainText('plain text');
  });

  test('Backspace right after a conversion restores the typed characters', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('- ');
    await expect(editor(page).locator('ul')).toHaveCount(1);
    await page.keyboard.press('Backspace');
    await expect(editor(page).locator('ul')).toHaveCount(0);
    await expect(editor(page).locator('p').first()).toHaveText('-');
  });
});

test.describe('Keyboard editing', () => {
  test('Enter and Backspace behave naturally in lists', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('- one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    await expect(editor(page).locator('ul > li')).toHaveCount(2);
    // Enter on an empty item leaves the list.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('after');
    await expect(editor(page).locator('ul > li')).toHaveCount(2);
    await expect(editor(page).locator('ul + p')).toHaveText('after');
    // Tab nests an item.
    await clickInto(editor(page).locator('li p', { hasText: 'two' }));
    await page.keyboard.press('Tab');
    await expect(editor(page).locator('ul > li > ul > li')).toHaveText('two');
    await page.keyboard.press('Shift+Tab');
    await expect(editor(page).locator('ul > li > ul')).toHaveCount(0);
  });

  test('formatting shortcuts', async ({ page }) => {
    await openNewPage(page, session, { content: doc('format me') });
    await clickInto(editor(page).locator('p').first());
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.press(`${mod}+b`);
    await page.keyboard.press(`${mod}+i`);
    const first = editor(page).locator('p').first();
    await expect(first.locator('strong')).toHaveText('format me');
    await expect(first.locator('em')).toHaveText('format me');
    await page.keyboard.press(`${mod}+b`);
    await expect(first.locator('strong')).toHaveCount(0);
  });

  test('checklist items can be ticked', async ({ page }) => {
    const created = await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('[] buy milk');
    await editor(page).locator('li input[type="checkbox"]').check();
    await expect(editor(page).locator('li[data-checked="true"]')).toHaveCount(1);
    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    expect(stored.content[0].content[0].attrs.checked).toBe(true);
  });

  test('moving and duplicating blocks from the keyboard', async ({ page }) => {
    await openNewPage(page, session, { content: doc('one', 'two', 'three') });
    await clickInto(editor(page).locator('p', { hasText: 'three' }));
    await page.keyboard.press('Alt+Shift+ArrowUp');
    expect(await blockTexts(page)).toEqual(['one', 'three', 'two']);
    await page.keyboard.press('Alt+Shift+ArrowUp');
    expect(await blockTexts(page)).toEqual(['three', 'one', 'two']);
    await page.keyboard.press('Alt+Shift+ArrowDown');
    expect(await blockTexts(page)).toEqual(['one', 'three', 'two']);
    // The caret travelled with the block.
    await page.keyboard.type('!');
    expect(await blockTexts(page)).toEqual(['one', 'three!', 'two']);
    await page.keyboard.press(`${mod}+d`);
    expect(await blockTexts(page)).toEqual(['one', 'three!', 'three!', 'two']);
  });

  test('Enter in the title moves to the editor, ArrowUp goes back', async ({ page }) => {
    await openNewPage(page, session, { title: '' });
    await expect(page.locator('.page-title')).toBeFocused();
    await page.keyboard.type('My title');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Body text');
    await expect(editor(page).locator('p').first()).toHaveText('Body text');
    await expect(page.locator('.page-title')).toHaveValue('My title');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.page-title')).toBeFocused();
  });
});

test.describe('Slash commands', () => {
  test('menu opens, filters and inserts with the keyboard', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('/');
    const menu = page.locator('.slash-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.slash-item').first()).toHaveClass(/is-active/);
    expect(await menu.locator('.slash-item').count()).toBeGreaterThan(10);

    await page.keyboard.type('head');
    await expect(menu.locator('.slash-item')).toHaveCount(3);
    await page.keyboard.press('ArrowDown');
    await expect(menu.locator('.slash-item').nth(1)).toHaveClass(/is-active/);
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await page.keyboard.type('Section');
    await expect(editor(page).locator('h2')).toHaveText('Section');
    await expect(editor(page)).not.toContainText('/head');
  });

  test('Escape dismisses the menu and keeps the text', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('/quo');
    await expect(page.locator('.slash-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.slash-menu')).toBeHidden();
    await expect(editor(page).locator('p').first()).toHaveText('/quo');
    await expect(editor(page).locator('blockquote')).toHaveCount(0);
  });

  test('"/" inside a word or a code block does not open the menu', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('and/or');
    await expect(page.locator('.slash-menu')).toBeHidden();
    await page.keyboard.press('Enter');
    await page.keyboard.type('``` ');
    await page.keyboard.type('a = b /');
    await expect(page.locator('.slash-menu')).toBeHidden();
  });

  const commands = [
    ['text', 'p'],
    ['h1', 'h1'],
    ['h2', 'h2'],
    ['h3', 'h3'],
    ['bullet', 'ul:not([data-type]) > li'],
    ['numbered', 'ol > li'],
    ['todo', 'ul[data-type="taskList"] > li'],
    ['quote', 'blockquote'],
    ['code', '.code-block'],
    ['divider', 'hr'],
    ['callout', '.callout'],
    ['table', 'table'],
  ];
  for (const [command, selector] of commands) {
    test(`/${command}`, async ({ page }) => {
      await openNewPage(page, session);
      await focusEditor(page);
      await page.keyboard.type(`/${command}`);
      await expect(page.locator('.slash-item.is-active')).toHaveAttribute('data-command', command);
      await page.keyboard.press('Enter');
      await expect(editor(page).locator(selector).first()).toBeVisible();
      await expect(editor(page)).not.toContainText(`/${command}`);
    });
  }

  test('the menu needs no network request', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.keyboard.type('/cal');
    await expect(page.locator('.slash-menu')).toBeVisible();
    expect(requests).toEqual([]);
  });
});
