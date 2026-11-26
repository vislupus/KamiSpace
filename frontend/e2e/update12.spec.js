// Pasting from Notion, the pages next to the one in the path, and selecting
// whole blocks.
import { expect, test } from '@playwright/test';
import {
  api,
  clickInto,
  doc,
  editor,
  focusEditor,
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

/** Paste clipboard flavours ({ 'text/html': …, 'text/plain': … }) at the caret. */
const paste = (page, flavours) =>
  page.evaluate((data) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
    document
      .querySelector('.doc')
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, flavours);

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAACAAAB4iG8MwAAAABJRU5ErkJggg==';

// What Notion puts on the clipboard: its blocks as Markdown turned into HTML.
const NOTION_HTML = `<meta charset='utf-8'><h1>Методика</h1>
<ul>
<li>[x] генериране на план на урока</li>
<li>[ ] трябва да се оправи дизайна
<ul>
<li>[ ] вложена задача</li>
</ul>
</li>
<li>обикновена точка</li>
<li>[ ] задача след точката</li>
</ul>
<details>
<summary>Скрити бележки</summary>
<p>Текст вътре</p>
<ul>
<li>[x] задача в toggle</li>
</ul>
</details>
<details>
<summary><h2>Глава</h2></summary>
<p>Под заглавието</p>
</details>
<aside>💡 Важно за запомняне</aside>
<blockquote>Цитат</blockquote>
<pre><code class="language-python">print("hi")</code></pre>
<hr>
<p>Текст с <strong>удебелено</strong> и <a href="https://example.com/x">връзка</a></p>
<p><img src="${PIXEL}" alt="снимка"></p>
<ol>
<li>първо</li>
<li>второ</li>
</ol>
<!-- notionvc: 5b1f2c9e-0000-4000-8000-000000000000 -->`;

const types = (nodes) => nodes.map((node) => node.type);
const text = (node) => (node.text ?? '') + (node.content ?? []).map(text).join('');

test.describe('Pasting from Notion', () => {
  test('to-dos, toggles, callouts, pictures and the rest arrive as working blocks', async ({ page }) => {
    const created = await openNewPage(page, session, { title: 'From Notion', content: doc('') });
    await focusEditor(page);
    await paste(page, { 'text/html': NOTION_HTML, 'text/plain': 'not used' });

    // To-dos are real check boxes, not "[ ] text" in a bulleted list.
    const tasksOnPage = editor(page).locator('ul[data-type="taskList"] > li');
    await expect(tasksOnPage.filter({ hasText: 'генериране на план' })).toHaveAttribute('data-checked', 'true');
    await expect(tasksOnPage).toHaveCount(5);
    await expect(editor(page)).not.toContainText('[ ]');
    await expect(editor(page)).not.toContainText('[x]');
    await expect(editor(page).locator('img')).toHaveAttribute('src', /^\/api\/files\/[0-9a-f]{32}$/);

    await waitForSaved(page);
    const stored = (await storedContent(page, created.id)).content;
    // (The empty line the page started with stays below what was pasted.)
    expect(types(stored).slice(0, 13)).toEqual([
      'heading',
      'taskList',
      'bulletList',
      'taskList',
      'details',
      'details',
      'callout',
      'blockquote',
      'codeBlock',
      'horizontalRule',
      'paragraph',
      'image',
      'orderedList',
    ]);
    const [, tasks, bullets, later, toggle, toggleHeading, callout, , code] = stored;
    expect(tasks.content.map((item) => [item.attrs.checked, text(item.content[0])])).toEqual([
      [true, 'генериране на план на урока'],
      [false, 'трябва да се оправи дизайна'],
    ]);
    // A to-do inside a to-do stays inside it.
    const nested = tasks.content[1].content[1];
    expect(nested.type).toBe('taskList');
    expect(text(nested)).toBe('вложена задача');
    expect(text(bullets)).toBe('обикновена точка');
    expect(text(later)).toBe('задача след точката');

    expect(toggle.attrs).toMatchObject({ open: true, level: 0 });
    expect(text(toggle.content[0])).toBe('Скрити бележки');
    expect(types(toggle.content[1].content)).toEqual(['paragraph', 'taskList']);
    expect(toggle.content[1].content[1].content[0].attrs.checked).toBe(true);
    expect(toggleHeading.attrs).toMatchObject({ open: true, level: 2 });
    expect(text(toggleHeading.content[0])).toBe('Глава');
    expect(text(toggleHeading.content[1])).toBe('Под заглавието');

    expect(callout.attrs.emoji).toBe('💡');
    expect(text(callout)).toBe('Важно за запомняне');
    expect(code.attrs.language).toBe('python');
    expect(text(code)).toBe('print("hi")');

    // They work: a pasted to-do can be ticked, a pasted toggle closed.
    const open = tasksOnPage.filter({ hasText: 'трябва да се оправи дизайна' }).first();
    await open.locator(':scope > label input').check();
    await editor(page).locator('div[data-type="details"]').first().locator(':scope > button').click();
    await expect(editor(page).getByText('Текст вътре')).toBeHidden();
    await waitForSaved(page);
    const after = (await storedContent(page, created.id)).content;
    expect(after[1].content[1].attrs.checked).toBe(true);
    expect(after[4].attrs.open).toBe(false);
  });

  test('check boxes written other ways are understood, and ordinary lists are left alone', async ({ page }) => {
    const created = await openNewPage(page, session, { title: 'Other check boxes', content: doc('') });
    await focusEditor(page);
    await paste(page, {
      'text/html':
        '<ul><li><input type="checkbox" checked disabled> from GitHub</li><li><input type="checkbox" disabled> open</li></ul>' +
        '<ul class="to-do-list"><li><div class="checkbox checkbox-on"></div> exported, done</li><li><div class="checkbox checkbox-off"></div> exported, open</li></ul>' +
        '<ul><li>plain [ ] in the middle</li><li>[link] is not a box</li></ul>',
    });
    await waitForSaved(page);
    const stored = (await storedContent(page, created.id)).content;
    expect(types(stored).slice(0, 3)).toEqual(['taskList', 'taskList', 'bulletList']);
    expect(stored[0].content.map((item) => [item.attrs.checked, text(item)])).toEqual([
      [true, 'from GitHub'],
      [false, 'open'],
    ]);
    expect(stored[1].content.map((item) => [item.attrs.checked, text(item)])).toEqual([
      [true, 'exported, done'],
      [false, 'exported, open'],
    ]);
    expect(stored[2].content.map(text)).toEqual(['plain [ ] in the middle', '[link] is not a box']);
  });
});

test.describe('Pages next to the one in the path', () => {
  test('pointing at a page in the path lists its neighbours; a click goes there', async ({ page }) => {
    const stamp = Date.now();
    const folder = await openNewPage(page, session, { title: `Goals ${stamp}` });
    const years = [];
    for (const name of ['2027', '2026', '2025']) {
      years.push(await api(page, session, 'POST', '/api/pages', { title: name, parent_id: folder.id, link_in_parent: false }));
    }
    const month = await api(page, session, 'POST', '/api/pages', { title: 'January', parent_id: years[1].id, link_in_parent: false });
    await page.goto(`/p/${month.id}`);
    const crumb = (name) => page.locator('.breadcrumbs .crumb', { hasText: name });
    await expect(crumb('January')).toBeVisible();

    // An ancestor: the pages beside it, itself among them.
    await crumb('2026').hover();
    const menu = page.locator('.crumb-menu');
    await expect(menu.locator('.menu-item')).toHaveText(['2027', '2026', '2025']);
    // Nothing but the pages: no stray text under a short list.
    await expect(menu).toHaveText('202720262025');
    // Moving on to the list keeps it open.
    await menu.locator('.menu-item', { hasText: '2025' }).hover();
    await page.waitForTimeout(400);
    await expect(menu).toBeVisible();
    await menu.locator('.menu-item', { hasText: '2025' }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${years[2].id}$`));
    await expect(page.locator('.page-title')).toHaveValue('2025');
    await expect(menu).toHaveCount(0);

    // The page that is open: marked in its list.
    await crumb('2025').hover();
    await expect(menu.locator('.menu-item[aria-current="page"]')).toHaveText('2025');
    // Leaving closes the list.
    await page.locator('.page-title').hover();
    await expect(menu).toHaveCount(0);
    // A click on the open page's crumb opens it at once; an only child has no list.
    await crumb('2025').click();
    await expect(menu.locator('.menu-item')).toHaveCount(3);
    await page.keyboard.press('Escape');
    await page.goto(`/p/${month.id}`);
    await crumb('January').hover();
    await page.waitForTimeout(600);
    await expect(menu).toHaveCount(0);
  });

  test('a long list shows the pages around the current one, and the rest on request', async ({ page }) => {
    const folder = await openNewPage(page, session, { title: `Long ${Date.now()}` });
    const children = [];
    for (let index = 1; index <= 12; index += 1) {
      children.push(await api(page, session, 'POST', '/api/pages', { title: `Chapter ${index}`, parent_id: folder.id, link_in_parent: false }));
    }
    await page.goto(`/p/${children[8].id}`);
    await page.locator('.breadcrumbs .crumb[aria-current="page"]').hover();
    const menu = page.locator('.crumb-menu');
    await expect(menu.locator('.menu-item')).toHaveText(['Chapter 6', 'Chapter 7', 'Chapter 8', 'Chapter 9', 'Chapter 10', 'Chapter 11', 'Chapter 12']);
    await expect(menu.locator('.crumb-more')).toHaveText('5 more');
    await menu.locator('.crumb-more').click();
    await expect(menu.locator('.menu-item')).toHaveCount(12);
    await menu.locator('.menu-item', { hasText: 'Chapter 2' }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${children[1].id}$`));
  });
});

test.describe('Selecting blocks', () => {
  const content = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading' }] },
      paragraph('First paragraph of text'),
      paragraph('Second paragraph of text'),
      {
        type: 'bulletList',
        content: ['one', 'two', 'three'].map((item) => ({ type: 'listItem', content: [paragraph(item)] })),
      },
      paragraph('Last paragraph'),
    ],
  };
  const marked = (page) => editor(page).locator('.is-block-selected');
  const selectedText = (page) => page.evaluate(() => window.getSelection().toString().replace(/\s+/g, ' ').trim());

  test('a drag across blocks selects whole blocks, each with its own rectangle', async ({ page }) => {
    const created = await openNewPage(page, session, { title: 'Blocks', content });
    const first = await editor(page).locator('p', { hasText: 'First paragraph' }).boundingBox();
    const item = await editor(page).locator('li', { hasText: 'two' }).boundingBox();

    // Inside one block: an ordinary text selection.
    await page.mouse.move(first.x + 20, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(first.x + 90, first.y + first.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(80);
    await expect(marked(page)).toHaveCount(0);
    await expect(editor(page)).not.toHaveClass(/has-block-selection/);

    // From the middle of a paragraph to the middle of a list item below.
    // (Starting outside the text selected a moment ago, which would be dragged.)
    await page.mouse.move(first.x + 130, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(item.x + 12, item.y + item.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(marked(page)).toHaveText(['First paragraph of text', 'Second paragraph of text', 'one', 'two']);
    await expect(editor(page)).toHaveClass(/has-block-selection/);
    // What is selected is what is marked: the blocks from their first to their last letter.
    await expect.poll(() => selectedText(page)).toBe('First paragraph of text Second paragraph of text one two');
    // The highlight of the browser is hidden; the blocks carry the colour.
    const colours = await page.evaluate(() => {
      const block = document.querySelector('.doc p.is-block-selected');
      return { block: getComputedStyle(block).backgroundColor, text: getComputedStyle(block, '::selection').backgroundColor };
    });
    expect(colours.block).not.toBe('rgba(0, 0, 0, 0)');
    expect(colours.text).toBe('rgba(0, 0, 0, 0)');

    await page.keyboard.press('Delete');
    await waitForSaved(page);
    const stored = (await storedContent(page, created.id)).content;
    expect(stored.map((node) => [node.type, text(node)])).toEqual([
      ['heading', 'Heading'],
      ['bulletList', 'three'],
      ['paragraph', 'Last paragraph'],
    ]);
    await expect(marked(page)).toHaveCount(0);
  });

  test('Ctrl+A marks every block; Shift+arrows add and remove a block at a time', async ({ page }) => {
    await openNewPage(page, session, { title: 'Blocks by keyboard', content });
    await clickInto(editor(page).locator('p', { hasText: 'Second paragraph' }));
    await page.keyboard.press(`${mod}+a`);
    await expect(marked(page)).toHaveText(['Heading', 'First paragraph of text', 'Second paragraph of text', 'one', 'two', 'three', 'Last paragraph']);

    // Esc selects the block; Shift+↓ takes the next ones in, Shift+↑ lets them go.
    await clickInto(editor(page).locator('p', { hasText: 'First paragraph' }));
    await page.keyboard.press('Escape');
    await expect(marked(page)).toHaveCount(0);
    await page.keyboard.press('Shift+ArrowDown');
    await expect(marked(page)).toHaveText(['First paragraph of text', 'Second paragraph of text']);
    // A list is taken in item by item, and past its end the block after it.
    for (const expected of [['one'], ['one', 'two'], ['one', 'two', 'three'], ['one', 'two', 'three', 'Last paragraph']]) {
      await page.keyboard.press('Shift+ArrowDown');
      await expect(marked(page)).toHaveText(['First paragraph of text', 'Second paragraph of text', ...expected]);
    }
    for (const expected of [['one', 'two', 'three'], ['one', 'two'], ['one'], []]) {
      await page.keyboard.press('Shift+ArrowUp');
      await expect(marked(page)).toHaveText(['First paragraph of text', 'Second paragraph of text', ...expected]);
    }
    await page.keyboard.press('Shift+ArrowUp');
    await expect(marked(page)).toHaveCount(0);
    await expect(editor(page).locator('p.ProseMirror-selectednode')).toHaveText('First paragraph of text');
    // Upwards from the same block.
    await page.keyboard.press('Shift+ArrowUp');
    await expect(marked(page)).toHaveText(['Heading', 'First paragraph of text']);
    // Typing replaces the marked blocks, as it replaces any selection.
    await page.keyboard.type('Rewritten');
    await expect(marked(page)).toHaveCount(0);
    await expect(editor(page).locator(':scope > *').first()).toHaveText('Rewritten');
    await expect(editor(page).locator('p', { hasText: 'Second paragraph' })).toBeVisible();
  });
});
