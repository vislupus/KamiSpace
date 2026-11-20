// Page rhythm and size, column outlines, and handing out tasks.
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

const task = (text, attrs = {}) => ({
  type: 'taskItem',
  attrs: { checked: false, ...attrs },
  content: [paragraph(text)],
});
const px = (locator, property) => locator.evaluate((el, name) => parseFloat(getComputedStyle(el)[name]), property);

test.describe('Page rhythm', () => {
  test('paragraphs stand apart, list items sit close, the same inside a toggle', async ({ page }) => {
    await openNewPage(page, session, {
      content: doc(
        'first paragraph',
        'second paragraph',
        { type: 'taskList', content: [task('one'), task('two')] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Section' }] },
        'after the heading',
        {
          type: 'details',
          attrs: { open: true, level: 0 },
          content: [
            { type: 'detailsSummary', content: [{ type: 'text', text: 'Toggle' }] },
            { type: 'detailsContent', content: [paragraph('inside one'), paragraph('inside two')] },
          ],
        },
      ),
    });
    const body = editor(page);
    expect(await px(body, 'fontSize')).toBe(16);
    expect(await px(body, 'lineHeight')).toBe(24);
    // Measured on a Notion page: 16px between paragraphs, 6px between items.
    expect(await px(body.locator(':scope > p').nth(1), 'marginTop')).toBe(16);
    expect(await px(body.locator('ul[data-type="taskList"] > li').nth(1), 'marginTop')).toBe(6);
    expect(await px(body.locator('h2'), 'marginTop')).toBeCloseTo(52.8, 1);
    expect(await px(body.locator('h2 + p'), 'marginTop')).toBe(16);
    const inside = body.locator('div[data-type="detailsContent"] > p');
    expect(await px(inside.nth(1), 'marginTop')).toBe(16);
    // The first block never pushes the page down.
    expect(await px(body.locator(':scope > p').first(), 'marginTop')).toBe(0);
  });

  test('text size of a page: slider and presets, saved for everyone', async ({ page }) => {
    const created = await openNewPage(page, session, {
      title: 'Bigger text',
      content: doc({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Heading' }] }, 'body text'),
    });
    const body = editor(page);
    const titleBefore = await px(page.locator('.page-title'), 'fontSize');
    await page.getByRole('button', { name: 'Page menu' }).last().click();
    await page.locator('.menu-item', { hasText: 'Appearance & layout' }).click();
    await page.getByRole('menuitem', { name: /Text size/ }).click();
    const slider = page.locator('.text-size-slider');
    await expect(slider).toHaveValue('16');
    await slider.fill('22');
    await expect(page.locator('.text-size-value')).toHaveText('22 px');
    // Applied while the slider moves; headings and the title scale with it.
    expect(await px(body, 'fontSize')).toBe(22);
    expect(await px(body.locator('h1'), 'fontSize')).toBeCloseTo(22 * 1.875, 1);
    expect(await px(page.locator('.page-title'), 'fontSize')).toBeGreaterThan(titleBefore * 1.3);
    await page.keyboard.press('Escape');
    await expect
      .poll(async () => (await (await page.request.get(`/api/pages/${created.id}`)).json()).text_size)
      .toBe(22);

    await page.reload();
    expect(await px(editor(page), 'fontSize')).toBe(22);
    await page.getByRole('button', { name: 'Page menu' }).last().click();
    await page.locator('.menu-item', { hasText: 'Appearance & layout' }).click();
    await expect(page.getByRole('menuitem', { name: /Text size/ })).toContainText('22 px');
    await page.getByRole('menuitem', { name: /Text size/ }).click();
    await page.locator('.text-size-presets').getByRole('button', { name: 'Default' }).click();
    expect(await px(editor(page), 'fontSize')).toBe(16);
  });

  test('pointing at a column layout shows where the columns are', async ({ page }) => {
    await openNewPage(page, session, {
      content: doc({
        type: 'columns',
        content: ['left', 'right'].map((text) => ({ type: 'column', content: [paragraph(text)] })),
      }),
    });
    const columns = editor(page).locator('.column');
    const outline = (index) => columns.nth(index).evaluate((el) => getComputedStyle(el).outlineColor);
    await page.mouse.move(5, 5);
    await expect.poll(() => outline(0)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    await columns.nth(1).hover();
    // Both columns get an outline; the one under the pointer a stronger one.
    await expect.poll(() => outline(0)).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    await expect.poll(() => columns.nth(1).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    expect(await columns.nth(0).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('dashed');
  });
});

test.describe('Handing out tasks', () => {
  test('"@name" assigns a task, Enter keeps the person, a selection or a whole list is assigned at once', async ({
    page,
  }) => {
    const created = await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('[] First task @ali');
    const person = page.locator('.mention-menu .slash-item').first();
    await expect(person).toContainText('alice');
    await expect(person).toContainText('Assign');
    await page.keyboard.press('Enter');
    const items = editor(page).locator('ul[data-type="taskList"] > li');
    await expect(items.first().locator('.task-assignee')).toHaveText('alice');
    await expect(items.first().locator('p')).toHaveText(/^First task\s*$/);

    // The next items go to the same person without assigning them again.
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second task');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Third task');
    await expect(items.locator('.task-assignee')).toHaveText(['alice', 'alice', 'alice']);

    // Several items selected: one click assigns them all.
    await page.keyboard.press(`${mod}+a`);
    await page.waitForTimeout(60);
    await items.first().locator('.task-assignee').click();
    await expect(page.locator('.menu-heading').first()).toHaveText('Assign 3 selected tasks to');
    await page.getByRole('menuitem', { name: 'admin' }).click();
    await expect(items.locator('.task-assignee')).toHaveText(['admin', 'admin', 'admin']);

    // Or the whole list from any one item.
    await clickInto(items.nth(1).locator('p'));
    await items.nth(1).locator('.task-assignee').click();
    await page.getByRole('menuitem', { name: 'Assign all 3 in this list' }).hover();
    await page.getByRole('menuitem', { name: 'alice' }).last().click();
    await expect(items.locator('.task-assignee')).toHaveText(['alice', 'alice', 'alice']);

    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    const attrs = stored.content[0].content.map((node) => node.attrs);
    expect(attrs.map((item) => item.assignee)).toEqual([session.user.id, session.user.id, session.user.id]);
    expect(new Set(attrs.map((item) => item.taskId)).size).toBe(3);
    // Tidy up so the tasks do not stay open in "My tasks".
    for (const item of attrs) {
      await api(page, session, 'PUT', `/api/pages/${created.id}/tasks/${item.taskId}`, { checked: true });
    }
  });

  test('the person a task is given to can tick it, even without access to the page', async ({ page, browser }) => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const bobPage = await context.newPage();
    const bob = await signIn(bobPage, 'bob');
    const text = `Call the printer ${Date.now()}`;
    const created = await openNewPage(page, session, {
      title: 'Private plan',
      content: doc({ type: 'taskList', content: [task(text, { taskId: 'task-private-1', assignee: bob.user.id })] }),
    });

    await bobPage.goto('/tasks');
    const row = bobPage.locator('.task-row', { hasText: text });
    await expect(row).toContainText('not shared with you');
    await expect(row).not.toContainText('Private plan');
    await expect(row.locator('a')).toHaveCount(0);
    await row.getByRole('checkbox').check();
    await expect(row).toHaveCount(0);
    const stored = await storedContent(page, created.id);
    expect(stored.content[0].content[0].attrs.checked).toBe(true);
    // The task is all that was shared: the page stays closed to bob.
    await bobPage.goto(`/p/${created.id}`);
    await expect(bobPage.getByText('Page not found')).toBeVisible();
    await context.close();
  });

  test('on a page they can only read, people tick their own tasks right in the page', async ({ page, browser }) => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const bobPage = await context.newPage();
    const bob = await signIn(bobPage, 'bob');
    const created = await openNewPage(page, session, {
      title: 'Shared plan',
      content: doc({
        type: 'taskList',
        content: [
          task('for bob', { taskId: 'task-viewer-1', assignee: bob.user.id }),
          task('for alice', { taskId: 'task-viewer-2', assignee: session.user.id }),
          task('for nobody', { taskId: 'task-viewer-3' }),
        ],
      }),
    });
    await api(page, session, 'PUT', `/api/pages/${created.id}/shares/${bob.user.id}`, { role: 'viewer' });

    await bobPage.goto(`/p/${created.id}`);
    await expect(editor(bobPage)).toHaveAttribute('contenteditable', 'false');
    const boxes = editor(bobPage).locator('ul[data-type="taskList"] > li input[type="checkbox"]');
    await expect(boxes.nth(0)).toBeEnabled();
    await expect(boxes.nth(1)).toBeDisabled();
    await expect(boxes.nth(2)).toBeDisabled();
    await boxes.nth(0).check();
    await expect(editor(bobPage).locator('li').first()).toHaveAttribute('data-checked', 'true');
    await expect
      .poll(async () => (await storedContent(page, created.id)).content[0].content.map((node) => node.attrs.checked))
      .toEqual([true, false, false]);
    await bobPage.reload();
    await expect(editor(bobPage).locator('li[data-checked="true"]')).toHaveCount(1);
    await api(page, session, 'PUT', `/api/pages/${created.id}/tasks/task-viewer-2`, { checked: true });
    await context.close();
  });
});
