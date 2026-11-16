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
  personalWorkspaceId,
  signIn,
  storedContent,
  waitForSaved,
} from './helpers.js';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAACAAAB4iG8MwAAAABJRU5ErkJggg==';

let session;

test.beforeEach(async ({ page }) => {
  session = await signIn(page);
});

function types(content) {
  return content.content.map((node) => node.type);
}

test.describe('Toggles', () => {
  test('toggle list: summary, hidden content, state survives a reload', async ({ page }) => {
    const created = await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('/toggle');
    await expect(page.locator('.slash-item.is-active')).toHaveAttribute('data-command', 'toggle');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Release notes');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Hidden details');

    const toggle = editor(page).locator('div[data-type="details"]');
    await expect(toggle.locator('summary')).toHaveText('Release notes');
    const content = toggle.locator('div[data-type="detailsContent"]');
    await expect(content).toBeVisible();
    await expect(content).toHaveText('Hidden details');

    await toggle.locator(':scope > button').click();
    await expect(content).toBeHidden();
    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    expect(stored.content[0].type).toBe('details');
    expect(stored.content[0].attrs).toEqual({ open: false, level: 0 });

    await page.reload();
    const reloaded = editor(page).locator('div[data-type="details"]');
    await expect(reloaded.locator('summary')).toHaveText('Release notes');
    await expect(reloaded.locator('div[data-type="detailsContent"]')).toBeHidden();
    await reloaded.locator(':scope > button').click();
    await expect(reloaded.locator('div[data-type="detailsContent"]')).toHaveText('Hidden details');
  });

  test('toggle headings, the ">>" shortcut and turning a toggle back into text', async ({ page }) => {
    const created = await openNewPage(page, session, { content: doc('Chapter one') });
    await clickInto(editor(page).locator('p').first());
    await page.keyboard.type(' /toggleh2');
    await page.keyboard.press('Enter');
    const toggle = editor(page).locator('div[data-type="details"]').first();
    await expect(toggle).toHaveAttribute('data-level', '2');
    await expect(toggle.locator('summary')).toHaveText('Chapter one');
    // A toggle heading is as large as a heading.
    const size = await toggle.locator('summary').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThan(20);

    // Change the level from the block menu.
    await toggle.hover({ position: { x: 60, y: 10 } });
    await page.locator('.block-grip').click();
    await page.locator('.menu-item', { hasText: 'Turn into' }).click();
    await page.getByRole('menuitem', { name: 'Toggle heading 1' }).click();
    await expect(toggle).toHaveAttribute('data-level', '1');
    await waitForSaved(page);
    expect((await storedContent(page, created.id)).content[0].attrs.level).toBe(1);

    // ">> " starts a plain toggle.
    await clickInto(editor(page).locator(':scope > p').last());
    await page.keyboard.type('>> Quick toggle');
    await expect(editor(page).locator('div[data-type="details"][data-level="0"] summary')).toHaveText(
      'Quick toggle',
    );
    // Backspace at the start of the summary dissolves it again.
    await page.keyboard.press('Home');
    await page.waitForTimeout(60); // let the editor pick up the new caret position
    await page.keyboard.press('Backspace');
    await expect(editor(page).locator('div[data-type="details"]')).toHaveCount(1);
    await expect(editor(page).locator('p', { hasText: 'Quick toggle' })).toHaveCount(1);
  });

  test('viewers can open and close toggles without changing the page', async ({ page, browser }) => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'details',
          attrs: { open: false, level: 3 },
          content: [
            { type: 'detailsSummary', content: [{ type: 'text', text: 'FAQ' }] },
            { type: 'detailsContent', content: [paragraph('The answer')] },
          ],
        },
      ],
    };
    const created = await openNewPage(page, session, { title: 'Toggle for viewers', content });
    const context = await browser.newContext();
    const bobPage = await context.newPage();
    const bob = await signIn(bobPage, 'bob');
    await api(page, session, 'PUT', `/api/pages/${created.id}/shares/${bob.user.id}`, { role: 'viewer' });
    await bobPage.goto(`/p/${created.id}`);
    const toggle = editor(bobPage).locator('div[data-type="details"]');
    await expect(toggle.locator('div[data-type="detailsContent"]')).toBeHidden();
    await toggle.locator(':scope > button').click();
    await expect(toggle.locator('div[data-type="detailsContent"]')).toHaveText('The answer');
    expect((await storedContent(page, created.id)).content[0].attrs.open).toBe(false);
    await context.close();
  });
});

test.describe('Columns', () => {
  test('insert columns, write in each, add one and remove the layout', async ({ page }) => {
    const created = await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('/columns2');
    await page.keyboard.press('Enter');
    const columns = editor(page).locator('.columns');
    await expect(columns.locator('.column')).toHaveCount(2);
    await page.keyboard.type('Left side');
    await clickInto(columns.locator('.column').nth(1).locator('p'));
    await page.keyboard.type('# Right');
    await expect(columns.locator('.column').nth(0)).toHaveText('Left side');
    await expect(columns.locator('.column').nth(1).locator('h1')).toHaveText('Right');
    // They really sit side by side.
    const left = await columns.locator('.column').nth(0).boundingBox();
    const right = await columns.locator('.column').nth(1).boundingBox();
    expect(right.x).toBeGreaterThan(left.x + left.width - 1);
    expect(Math.abs(right.y - left.y)).toBeLessThan(2);

    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    expect(stored.content[0].type).toBe('columns');
    expect(stored.content[0].content.map((column) => column.type)).toEqual(['column', 'column']);

    await columns.hover({ position: { x: 30, y: 8 } });
    await page.locator('.block-grip').click();
    await page.locator('.menu-item', { hasText: 'Add a column' }).click();
    await expect(columns.locator('.column')).toHaveCount(3);

    await columns.hover({ position: { x: 30, y: 8 } });
    await page.locator('.block-grip').click();
    await page.locator('.menu-item', { hasText: 'Remove columns' }).click();
    await expect(editor(page).locator('.columns')).toHaveCount(0);
    await expect(editor(page).locator(':scope > p').first()).toHaveText('Left side');
    await expect(editor(page).locator(':scope > h1')).toHaveText('Right');
  });
});

test.describe('Equations', () => {
  test('block equation is typeset with KaTeX and can be edited', async ({ page }) => {
    const created = await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('/equation');
    await page.keyboard.press('Enter');
    const input = page.getByLabel('TeX source');
    await expect(input).toBeFocused();
    await input.fill('E = mc^2');
    await expect(page.locator('.equation-preview .katex')).toBeVisible();
    await page.keyboard.press('Enter');

    const block = editor(page).locator('.equation-block');
    await expect(block.locator('.katex')).toBeVisible();
    await expect(block).toContainText('E');
    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    expect(stored.content[0]).toEqual({ type: 'blockEquation', attrs: { latex: 'E = mc^2' } });

    await block.click();
    await page.getByLabel('TeX source').fill('\\frac{a}{b}');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(block.locator('.katex .mfrac')).toBeVisible();
    // The fonts come from this server.
    const fonts = await page.evaluate(() =>
      [...document.fonts].filter((font) => font.family.includes('KaTeX')).length,
    );
    expect(fonts).toBeGreaterThan(0);
  });

  test('inline equations: typed with $$…$$ and from the toolbar', async ({ page }) => {
    const created = await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('Pythagoras: $$a^2 + b^2 = c^2$$ and more');
    const first = editor(page).locator('p').first();
    await expect(first.locator('.equation-inline .katex')).toBeVisible();
    await expect(first).not.toContainText('$$');
    await expect(first).toContainText('and more');

    await page.keyboard.press('Enter');
    await page.keyboard.type('x_1');
    await page.keyboard.press('Shift+Home');
    await page.locator('.bubble-toolbar').getByRole('button', { name: 'Inline equation' }).click();
    await expect(editor(page).locator('.equation-inline')).toHaveCount(2);

    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    expect(stored.content[0].content[1]).toEqual({
      type: 'inlineEquation',
      attrs: { latex: 'a^2 + b^2 = c^2' },
    });
    expect(stored.content[1].content[0]).toEqual({ type: 'inlineEquation', attrs: { latex: 'x_1' } });
  });

  test('a wrong formula shows an error instead of breaking the page', async ({ page }) => {
    await openNewPage(page, session, {
      content: { type: 'doc', content: [{ type: 'blockEquation', attrs: { latex: '\\frac{1}{' } }] },
    });
    await expect(editor(page).locator('.equation-block')).toBeVisible();
    await expect(editor(page).locator('.equation-block .katex-error, .equation-block .katex')).toHaveCount(1);
  });
});

test('text colour and background highlight', async ({ page }) => {
  const created = await openNewPage(page, session, { content: doc('colourful words') });
  const first = editor(page).locator('p').first();
  await first.dblclick({ position: { x: 20, y: 10 } });
  const toolbar = page.locator('.bubble-toolbar');
  await toolbar.getByRole('button', { name: 'Colour' }).click();
  await page.getByRole('button', { name: 'Text: red' }).click();
  await expect(first.locator('span[data-text-color="red"]')).toHaveText('colourful');
  const red = await first
    .locator('span[data-text-color="red"]')
    .evaluate((el) => getComputedStyle(el).color);
  expect(red).not.toBe(await first.evaluate((el) => getComputedStyle(el).color));

  await first.dblclick({ position: { x: 110, y: 10 } });
  await toolbar.getByRole('button', { name: 'Colour' }).click();
  await page.getByRole('button', { name: 'Background: yellow' }).click();
  await expect(first.locator('mark[data-highlight="yellow"]')).toHaveText('words');

  await waitForSaved(page);
  const stored = await storedContent(page, created.id);
  expect(stored.content[0].content.map((node) => node.marks?.[0])).toEqual([
    { type: 'textColor', attrs: { color: 'red' } },
    undefined,
    { type: 'highlight', attrs: { color: 'yellow' } },
  ]);

  // Back to default.
  await first.dblclick({ position: { x: 20, y: 10 } });
  await toolbar.getByRole('button', { name: 'Colour' }).click();
  await page.getByRole('button', { name: 'Text: default' }).click();
  await expect(first.locator('span[data-text-color]')).toHaveCount(0);
});

test.describe('Links between pages', () => {
  test('a sub-page created from the sidebar is linked in its parent', async ({ page }) => {
    const parent = await openNewPage(page, session, { title: 'Parent page', content: doc('intro') });
    const row = page.locator('.sidebar .tree-row', { hasText: 'Parent page' }).first();
    await row.hover();
    await row.getByRole('button', { name: 'Add a page inside' }).click();
    await expect(page.locator('.page-title')).toBeFocused();
    await page.keyboard.type('Child page');
    await expect(page.locator('.sidebar .tree-row', { hasText: 'Child page' })).toBeVisible();

    await page.locator('.breadcrumbs .crumb', { hasText: 'Parent page' }).click();
    const link = editor(page).locator('.page-link');
    await expect(link).toHaveText('Child page'); // follows the title
    expect(types(await storedContent(page, parent.id))).toEqual(['paragraph', 'pageLink', 'paragraph']);
    await link.click();
    await expect(page.locator('.page-title')).toHaveValue('Child page');
  });

  test('"/page" creates a sub-page at the caret and opens it', async ({ page }) => {
    const parent = await openNewPage(page, session, { title: 'Wiki', content: doc('before', 'after') });
    await clickInto(editor(page).locator('p', { hasText: 'before' }));
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/page');
    await expect(page.locator('.slash-item.is-active')).toHaveAttribute('data-command', 'page');
    await page.keyboard.press('Enter');
    await expect(page.locator('.breadcrumbs .crumb')).toHaveText(['Private', 'Wiki', 'Untitled']);
    await page.keyboard.type('Glossary');

    const stored = await storedContent(page, parent.id);
    expect(types(stored)).toEqual(['paragraph', 'pageLink', 'paragraph']); // exactly one link, in place
    await page.locator('.breadcrumbs .crumb', { hasText: 'Wiki' }).click();
    await expect(editor(page).locator('.page-link')).toHaveText('Glossary');
  });

  test('"@" mentions another page; the mention follows renames', async ({ page }) => {
    const stamp = Date.now();
    const target = await api(page, session, 'POST', '/api/pages', {
      title: `Roadmap${stamp} plan`,
      icon: '🧭',
      workspace_id: await personalWorkspaceId(page),
    });
    const source = await openNewPage(page, session, { title: 'Notes' });
    await focusEditor(page);
    await page.keyboard.type(`See @Roadmap${stamp}`);
    const menu = page.locator('.mention-menu');
    await expect(menu.locator('.slash-item')).toHaveCount(1); // found, and no "create" offer
    await expect(menu.locator('.slash-item').first()).toContainText(`Roadmap${stamp} plan`);
    await page.keyboard.press('Enter');
    await page.keyboard.type('for the plan');

    const mention = editor(page).locator('.page-mention');
    await expect(mention).toHaveText(`🧭Roadmap${stamp} plan`);
    await expect(editor(page).locator('p').first()).toContainText('for the plan');
    await waitForSaved(page);
    const stored = await storedContent(page, source.id);
    expect(stored.content[0].content[1]).toEqual({ type: 'pageMention', attrs: { pageId: target.id } });

    await api(page, session, 'PATCH', `/api/pages/${target.id}`, { title: 'Renamed roadmap' });
    await page.reload();
    await expect(editor(page).locator('.page-mention')).toContainText('Renamed roadmap');
    await editor(page).locator('.page-mention').click();
    await expect(page).toHaveURL(new RegExp(`/p/${target.id}$`));
  });

  test('an "@" in ordinary text does not get in the way', async ({ page }) => {
    await openNewPage(page, session, { title: 'Plain text' });
    await focusEditor(page);
    await page.keyboard.type('Meet @ 5pm, mail me at someone@example.com');
    await expect(page.locator('.mention-menu')).toBeHidden();
    await page.keyboard.press('Enter');
    await page.keyboard.type('@nosuchpagehere');
    await expect(page.locator('.mention-menu')).toContainText('No pages found');
    await page.keyboard.press('Enter'); // just a new line; nothing is created
    await page.keyboard.type('next line');
    await expect(editor(page).locator('p')).toHaveText([
      'Meet @ 5pm, mail me at someone@example.com',
      '@nosuchpagehere',
      'next line',
    ]);
    await expect(editor(page).locator('.page-mention')).toHaveCount(0);
  });

  test('"[[" works too, and can create the page it names', async ({ page }) => {
    await openNewPage(page, session, { title: 'Index' });
    await focusEditor(page);
    const name = `Brand new ${Date.now()}`;
    await page.keyboard.type(`[[${name}`);
    await expect(page.locator('.mention-menu .slash-item')).toContainText([`New sub-page “${name}”`]);
    await page.keyboard.press('Enter');
    await expect(editor(page).locator('.page-mention')).toContainText(name);
    await expect(page.locator('.sidebar .tree-row', { hasText: name })).toBeVisible();
  });

  test('a link to a page that was deleted says so', async ({ page }) => {
    const target = await api(page, session, 'POST', '/api/pages', {
      title: 'Short lived',
      workspace_id: await personalWorkspaceId(page),
    });
    await openNewPage(page, session, {
      title: 'Holder',
      content: { type: 'doc', content: [{ type: 'pageLink', attrs: { pageId: target.id } }] },
    });
    await expect(editor(page).locator('.page-link')).toHaveText('Short lived');
    await api(page, session, 'DELETE', `/api/pages/${target.id}`);
    await page.reload();
    await expect(editor(page).locator('.page-link')).toHaveText('Page not available');
    await expect(editor(page).locator('.page-link')).toHaveClass(/is-missing/);
  });
});

test.describe('Copying', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('"Copy link" puts the page address on the clipboard; pasting it makes a mention', async ({ page }) => {
    const target = await openNewPage(page, session, { title: 'Link target' });
    await page.getByRole('button', { name: 'Page menu' }).last().click();
    await page.locator('.menu-item', { hasText: 'Copy link' }).click();
    await expect(page.locator('.toast')).toContainText('Link copied');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(`${new URL(page.url()).origin}/p/${target.id}`);

    await openNewPage(page, session, { title: 'Pasting here' });
    await focusEditor(page);
    await page.keyboard.press(`${mod}+v`);
    await expect(editor(page).locator('.page-mention')).toHaveText('Link target');
  });

  test('copying also works where the clipboard API is missing (plain http)', async ({ page }) => {
    // Browsers hide navigator.clipboard on http:// sites other than localhost.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'isSecureContext', { value: false });
    });
    const target = await openNewPage(page, session, { title: 'Insecure origin' });
    const row = page.locator('.sidebar .tree-row', { hasText: 'Insecure origin' }).first();
    await row.click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Copy link' }).click();
    await expect(page.locator('.toast')).toContainText('Link copied');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(`${new URL(page.url()).origin}/p/${target.id}`);
  });

  test('"Copy page contents" copies the page as Markdown', async ({ page }) => {
    await openNewPage(page, session, {
      title: 'Meeting',
      content: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Agenda' }] },
          {
            type: 'bulletList',
            content: [{ type: 'listItem', content: [paragraph('Budget')] }],
          },
        ],
      },
    });
    await page.getByRole('button', { name: 'Page menu' }).last().click();
    await page.locator('.menu-item', { hasText: 'Copy page contents' }).click();
    await expect(page.locator('.toast')).toContainText('copied');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('# Meeting');
    expect(copied).toContain('## Agenda');
    expect(copied).toMatch(/[-*] Budget/);
  });
});

test.describe('Markdown files', () => {
  const rich = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Some ' },
          { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' text and ' },
          { type: 'inlineEquation', attrs: { latex: 'x^2' } },
        ],
      },
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: true }, content: [paragraph('done')] },
          { type: 'taskItem', attrs: { checked: false }, content: [paragraph('open')] },
        ],
      },
      { type: 'codeBlock', attrs: { language: 'python' }, content: [{ type: 'text', text: 'print(1)' }] },
      { type: 'callout', attrs: { variant: 'warning', emoji: null }, content: [paragraph('Careful')] },
      {
        type: 'details',
        attrs: { open: true, level: 0 },
        content: [
          { type: 'detailsSummary', content: [{ type: 'text', text: 'More' }] },
          { type: 'detailsContent', content: [paragraph('inside')] },
        ],
      },
      { type: 'blockEquation', attrs: { latex: 'E = mc^2' } },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: ['A', 'B'].map((text) => ({
              type: 'tableHeader',
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [paragraph(text)],
            })),
          },
          {
            type: 'tableRow',
            content: ['1', '2'].map((text) => ({
              type: 'tableCell',
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [paragraph(text)],
            })),
          },
        ],
      },
    ],
  };

  test('export a page as .md and import it again without losing structure', async ({ page }) => {
    await openNewPage(page, session, { title: 'Round trip', content: rich });
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Page menu' }).last().click();
    await page.locator('.menu-item', { hasText: 'Export as Markdown' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('Round trip.md');
    const stream = await download.createReadStream();
    let markdown = '';
    for await (const chunk of stream) markdown += chunk.toString('utf8');

    expect(markdown).toContain('# Round trip');
    expect(markdown).toContain('## Plan');
    expect(markdown).toContain('**bold**');
    expect(markdown).toContain('$x^2$');
    expect(markdown).toContain('- [x] done');
    expect(markdown).toContain('- [ ] open');
    expect(markdown).toContain('```python');
    expect(markdown).toContain('$$\nE = mc^2\n$$');
    expect(markdown).toMatch(/\| A\s+\| B\s+\|/);

    // Import the same file from the library.
    await page.goto('/library');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import Markdown' }).click();
    await (await chooser).setFiles({
      name: 'Round trip.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(markdown, 'utf8'),
    });
    await expect(page.locator('.page-title')).toHaveValue('Round trip');
    const doc_ = editor(page);
    await expect(doc_.locator('h2')).toHaveText('Plan');
    await expect(doc_.locator('p strong').first()).toHaveText('bold');
    await expect(doc_.locator('.equation-inline')).toHaveCount(1);
    await expect(doc_.locator('ul[data-type="taskList"] li[data-checked="true"]')).toHaveCount(1);
    await expect(doc_.locator('ul[data-type="taskList"] li')).toHaveCount(2);
    await expect(doc_.locator('.code-block select')).toHaveValue('python');
    await expect(doc_.locator('.code-block code')).toHaveText('print(1)');
    await expect(doc_.locator('.callout')).toHaveAttribute('data-variant', 'warning');
    await expect(doc_.locator('.callout')).toContainText('Careful');
    await expect(doc_.locator('div[data-type="details"] summary')).toHaveText('More');
    await expect(doc_.locator('.equation-block')).toHaveCount(1);
    await expect(doc_.locator('table th')).toHaveText(['A', 'B']);
    await expect(doc_.locator('table td')).toHaveText(['1', '2']);
  });

  test('a Markdown file written elsewhere imports as a normal page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.sidebar')).toBeVisible();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import Markdown' }).click();
    const markdown = [
      '# Travel notes',
      '',
      'First *day* in [Sofia](https://example.com/sofia).',
      '',
      '1. Museum',
      '2. Park',
      '',
      '> Remember the tickets',
      '',
      '![remote picture](https://example.com/photo.jpg)',
      '',
      '---',
      '',
      '<script>window.__xss = 1</script>',
    ].join('\n');
    await (await chooser).setFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from(markdown) });
    await expect(page.locator('.page-title')).toHaveValue('Travel notes');
    const doc_ = editor(page);
    await expect(doc_.locator('p em')).toHaveText('day');
    await expect(doc_.locator('p a').first()).toHaveAttribute('href', 'https://example.com/sofia');
    await expect(doc_.locator('ol > li')).toHaveText(['Museum', 'Park']);
    await expect(doc_.locator('blockquote')).toHaveText('Remember the tickets');
    await expect(doc_.locator('hr')).toHaveCount(1);
    // Pictures on other sites are not embedded; they become links.
    await expect(doc_.locator('img')).toHaveCount(0);
    await expect(doc_.locator('a', { hasText: 'remote picture' })).toHaveAttribute(
      'href',
      'https://example.com/photo.jpg',
    );
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(doc_.locator('script')).toHaveCount(0);
  });
});

test.describe('To-do items and My tasks', () => {
  test('assign a task with a due date; it shows up for that person, who ticks it off', async ({
    page,
    browser,
  }) => {
    const title = `Sprint ${Date.now()}`;
    const created = await openNewPage(page, session, { title });
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const bobPage = await context.newPage();
    const bob = await signIn(bobPage, 'bob');
    await api(page, session, 'PUT', `/api/pages/${created.id}/shares/${bob.user.id}`, { role: 'editor' });

    await focusEditor(page);
    await page.keyboard.type('[] Prepare the release notes');
    const item = editor(page).locator('ul[data-type="taskList"] > li').first();
    await item.hover();
    await item.getByRole('button', { name: 'Assign to someone' }).click();
    await page.getByRole('menuitem', { name: 'bob' }).click();
    await expect(item.locator('.task-assignee')).toHaveText('bob');

    await item.getByRole('button', { name: 'Set a due date' }).click();
    await page.locator('.due-editor input[type="date"]').fill('2020-01-15');
    await expect(item.locator('.task-due')).toHaveClass(/is-overdue/);
    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    const attrs = stored.content[0].content[0].attrs;
    expect(attrs.assignee).toBe(bob.user.id);
    expect(attrs.due).toBe('2020-01-15');
    expect(attrs.taskId).toMatch(/^[A-Za-z0-9_-]{6,32}$/);

    // Bob: a badge in the sidebar, the task in "My tasks".
    await bobPage.goto('/');
    await expect(bobPage.locator('.side-badge')).toHaveText('1');
    await bobPage.getByRole('link', { name: /My tasks/ }).click();
    const row = bobPage.locator('.task-row', { hasText: 'Prepare the release notes' });
    await expect(row).toContainText(title);
    await expect(row.locator('.task-due')).toHaveClass(/is-overdue/);
    await row.getByRole('checkbox').check();
    await expect(bobPage.locator('.task-row')).toHaveCount(0);
    await expect(bobPage.getByText('Nothing assigned to you')).toBeVisible();
    await expect(bobPage.locator('.side-badge')).toBeHidden();

    // The page itself now shows the item as done.
    await page.reload();
    await expect(editor(page).locator('li[data-checked="true"]')).toHaveCount(1);
    await bobPage.getByLabel('Show completed').check();
    await expect(bobPage.locator('.task-row.is-done')).toHaveCount(1);
    await context.close();
  });

  test('every to-do item gets its own id, also after Enter and duplicating', async ({ page }) => {
    const created = await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('[] one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    await page.keyboard.press(`${mod}+d`);
    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    const ids = stored.content
      .filter((node) => node.type === 'taskList')
      .flatMap((list) => list.content.map((item) => item.attrs.taskId));
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    // Saving again does not shuffle the ids.
    await focusEditor(page);
    await page.keyboard.type('x');
    await waitForSaved(page);
    const again = (await storedContent(page, created.id)).content
      .filter((node) => node.type === 'taskList')
      .flatMap((list) => list.content.map((item) => item.attrs.taskId));
    expect(again).toEqual(ids);
  });

  test('"My tasks" explains how to hand out a task', async ({ page }) => {
    await page.goto('/tasks');
    await expect(page.locator('.listing')).toContainText('To give someone a task');
    await expect(page.locator('.listing')).toContainText('person button');
  });
});

test.describe('Page menu', () => {
  test('lock page: read-only for everyone until unlocked', async ({ page }) => {
    const created = await openNewPage(page, session, { title: 'Policy', content: doc('final wording') });
    await page.getByRole('button', { name: 'Page menu' }).last().click();
    await page.locator('.menu-item', { hasText: 'Lock page' }).click();
    await expect(page.locator('.lock-badge')).toBeVisible();
    await expect(editor(page)).toHaveAttribute('contenteditable', 'false');
    await expect(page.locator('.page-title')).toHaveAttribute('readonly', '');
    await editor(page).locator('p').first().hover();
    await expect(page.locator('.block-handle')).toHaveCount(0);

    // The server refuses changes too.
    const refused = await page.request.put(`/api/pages/${created.id}/content`, {
      data: { content: doc('hacked'), base_revision: 1 },
      headers: { 'X-CSRF-Token': session.csrf },
    });
    expect(refused.status()).toBe(423);

    await page.reload();
    await expect(page.locator('.lock-badge')).toBeVisible();
    await page.locator('.lock-badge').click();
    await expect(page.locator('.lock-badge')).toHaveCount(0);
    await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
    await focusEditor(page);
    await page.keyboard.type(' — edited again');
    await waitForSaved(page);
  });

  test('appearance & layout: font, small text and full width are kept', async ({ page }) => {
    const created = await openNewPage(page, session, { title: 'Styled', content: doc('some text') });
    const article = page.locator('article.page');
    const choose = async (label) => {
      await page.getByRole('button', { name: 'Page menu' }).last().click();
      await page.locator('.menu-item', { hasText: 'Appearance & layout' }).click();
      await page.getByRole('menuitem', { name: label }).click();
    };
    const widthBefore = (await editor(page).boundingBox()).width;
    const sizeBefore = await editor(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

    await choose('Serif');
    await expect(article).toHaveClass(/font-serif/);
    expect(await editor(page).evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Charter|Georgia|serif/);
    await choose('Small text');
    await expect(article).toHaveClass(/is-small/);
    expect(await editor(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeLessThan(sizeBefore);
    await choose('Full width');
    await expect(article).toHaveClass(/is-wide/);
    expect((await editor(page).boundingBox()).width).toBeGreaterThan(widthBefore + 100);

    await page.reload();
    await expect(page.locator('article.page')).toHaveClass(/font-serif/);
    await expect(page.locator('article.page')).toHaveClass(/is-small/);
    await expect(page.locator('article.page')).toHaveClass(/is-wide/);
    const stored = await (await page.request.get(`/api/pages/${created.id}`)).json();
    expect([stored.font, stored.small_text, stored.full_width]).toEqual(['serif', true, true]);
  });

  test('the cover image can be moved up and down', async ({ page }) => {
    const created = await openNewPage(page, session, { title: 'With cover' });
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.page-head').hover();
    await page.getByRole('button', { name: 'Add cover' }).click();
    await (await chooser).setFiles({
      name: 'cover.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    });
    const image = page.locator('.page-cover img');
    await expect(image).toHaveAttribute('style', /center 50%/);

    await page.locator('.page-cover').hover();
    await page.getByRole('button', { name: 'Reposition' }).click();
    await expect(page.locator('.cover-hint')).toBeVisible();
    // Drag the picture down → shows a part nearer its top.
    const box = await page.locator('.page-cover').boundingBox();
    await page.mouse.move(box.x + 200, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 90, { steps: 5 });
    await page.mouse.up();
    const dragged = await image.evaluate((el) => parseFloat(el.style.objectPosition.split(' ').pop()));
    expect(dragged).toBeLessThan(50);
    // Fine-tune with the keyboard and save.
    await page.keyboard.press('ArrowDown');
    await page.getByRole('button', { name: 'Save position' }).click();
    await expect(page.locator('.cover-hint')).toHaveCount(0);
    const stored = await (await page.request.get(`/api/pages/${created.id}`)).json();
    expect(stored.cover_position).not.toBe(50);
    expect(stored.cover_position).toBe(Math.round(dragged + 4));

    await page.reload();
    await expect(page.locator('.page-cover img')).toHaveAttribute(
      'style',
      new RegExp(`center ${stored.cover_position}%`),
    );
  });
});

test.describe('Media, embeds and bookmarks', () => {
  async function dropFile(page, { name, mime, bytes }) {
    await page.evaluate(
      ({ name, mime, bytes }) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(bytes)], name, { type: mime }));
        const target = document.querySelector('.doc');
        const rect = target.lastElementChild.getBoundingClientRect();
        target.dispatchEvent(
          new DragEvent('drop', {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
            clientX: rect.left + 20,
            clientY: rect.top + 5,
          }),
        );
      },
      { name, mime, bytes },
    );
  }
  const MP4 = [0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, ...new Array(64).fill(0)];
  const MP3 = [0x49, 0x44, 0x33, 3, 0, ...new Array(64).fill(0)];

  test('video and audio files become players', async ({ page }) => {
    const created = await openNewPage(page, session, { content: doc('media below') });
    await dropFile(page, { name: 'clip.mp4', mime: 'video/mp4', bytes: MP4 });
    const video = editor(page).locator('.video-block video');
    await expect(video).toHaveAttribute('src', /^\/api\/files\/[0-9a-f]{32}$/);
    await expect(video).toHaveAttribute('controls', '');

    await dropFile(page, { name: 'voice memo.mp3', mime: 'audio/mpeg', bytes: MP3 });
    const audio = editor(page).locator('.audio-block');
    await expect(audio.locator('audio')).toHaveAttribute('src', /^\/api\/files\/[0-9a-f]{32}$/);
    await expect(audio.locator('.media-name')).toHaveText('voice memo.mp3');
    await waitForSaved(page);
    expect(types(await storedContent(page, created.id))).toEqual(
      expect.arrayContaining(['video', 'audio']),
    );
  });

  test('embed a web page and a YouTube video', async ({ page }) => {
    // Nothing outside the test server is contacted.
    await page.route(/^https:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
    const created = await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('/embed');
    await page.keyboard.press('Enter');
    const input = page.getByPlaceholder('Paste a web address to embed…');
    await expect(input).toBeFocused();
    await input.fill('not a url');
    await page.keyboard.press('Enter');
    await expect(page.locator('.link-error')).toHaveText(/valid/);
    await input.fill('example.com/dashboard');
    await page.keyboard.press('Enter');
    const frame = editor(page).locator('.embed iframe').first();
    await expect(frame).toHaveAttribute('src', 'https://example.com/dashboard');
    await expect(frame).toHaveAttribute('sandbox', /allow-scripts/);
    await expect(editor(page).locator('.embed-url').first()).toHaveText('https://example.com/dashboard');

    await focusEditor(page);
    await page.keyboard.type('/embed');
    await page.keyboard.press('Enter');
    await page.getByPlaceholder('Paste a web address to embed…').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await page.keyboard.press('Enter');
    await expect(editor(page).locator('.embed iframe.is-video')).toHaveAttribute(
      'src',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
    await waitForSaved(page);
    const embeds = (await storedContent(page, created.id)).content.filter((node) => node.type === 'embed');
    expect(embeds.map((node) => node.attrs.url)).toEqual([
      'https://example.com/dashboard',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ]);
  });

  test('web bookmark card', async ({ page }) => {
    const created = await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('/bookmark');
    await page.keyboard.press('Enter');
    await page.getByPlaceholder('Paste a web address to bookmark…').fill('https://example.com/article');
    await page.keyboard.press('Enter');
    const card = editor(page).locator('.bookmark');
    await expect(card.locator('.bookmark-title')).toHaveAttribute('href', 'https://example.com/article');
    await expect(card.locator('.bookmark-title')).toHaveAttribute('rel', /noopener/);
    await expect(card.locator('.bookmark-url')).toHaveText('https://example.com/article');
    await waitForSaved(page);
    expect((await storedContent(page, created.id)).content[0]).toMatchObject({
      type: 'bookmark',
      attrs: { url: 'https://example.com/article' },
    });
  });
});

test.describe('Pasting from Word and the web', () => {
  // Two small pictures as Word stores them in RTF: hex data after a \pict header.
  const pngHex = Buffer.from(PNG_BASE64, 'base64').toString('hex');
  const rtfPicture = (hex) =>
    `{\\*\\shppict{\\pict{\\*\\picprop}\\picscalex100\\picscaley100\\piccropl0\\picw26\\pich26\\picwgoal15\\pichgoal15\\pngblip\\bliptag-1234{\\*\\blipuid 0123456789abcdef0123456789abcdef}${hex}}}`;
  const wordRtf = `{\\rtf1\\ansi Report ${rtfPicture(pngHex)} more text ${rtfPicture(pngHex)}}`;
  const wordHtml = `
    <html xmlns:v="urn:schemas-microsoft-com:vml"><body>
    <p class=MsoNormal><b>Quarterly report</b> with <i>formatting</i></p>
    <p class=MsoNormal><!--[if gte vml 1]><v:shape><v:imagedata src="file:///C:/Temp/msohtmlclip1/01/clip_image001.png"/></v:shape><![endif]--><![if !vml]><img width=20 height=20 src="file:///C:/Temp/msohtmlclip1/01/clip_image001.png"><![endif]></p>
    <p class=MsoNormal>Second paragraph</p>
    <p class=MsoNormal><img width=20 height=20 src="file:///C:/Temp/msohtmlclip1/01/clip_image002.png"></p>
    <ul><li>List item</li></ul>
    </body></html>`;

  async function paste(page, data) {
    await page.evaluate((data) => {
      const transfer = new DataTransfer();
      for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
      document
        .querySelector('.doc')
        .dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, data);
  }

  test('text keeps its formatting and every picture is uploaded', async ({ page }) => {
    const created = await openNewPage(page, session);
    await focusEditor(page);
    await paste(page, { 'text/html': wordHtml, 'text/rtf': wordRtf, 'text/plain': 'Quarterly report' });

    const images = editor(page).locator('figure.image-block img');
    await expect(images).toHaveCount(2);
    for (const index of [0, 1]) {
      await expect(images.nth(index)).toHaveAttribute('src', /^\/api\/files\/[0-9a-f]{32}$/);
      await expect.poll(() => images.nth(index).evaluate((img) => img.complete && img.naturalWidth)).toBe(1);
    }
    await expect(editor(page).locator('p strong')).toHaveText('Quarterly report');
    await expect(editor(page).locator('p em')).toHaveText('formatting');
    await expect(editor(page).locator('ul > li')).toHaveText('List item');
    await expect(page.locator('.toast-error')).toHaveCount(0);

    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    expect(types(stored).filter((type) => type === 'image')).toHaveLength(2);
    // In document order: text, picture, text, picture, list.
    expect(types(stored).slice(0, 5)).toEqual(['paragraph', 'image', 'paragraph', 'image', 'bulletList']);
    const ids = stored.content.filter((node) => node.type === 'image').map((node) => node.attrs.attachmentId);
    expect(new Set(ids).size).toBe(2);
  });

  test('pictures embedded as data: URIs are uploaded too', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    await paste(page, {
      'text/html': `<p>Inline picture:</p><img src="data:image/png;base64,${PNG_BASE64}"><p>after</p>`,
    });
    await expect(editor(page).locator('figure.image-block img')).toHaveAttribute(
      'src',
      /^\/api\/files\/[0-9a-f]{32}$/,
    );
    await expect(editor(page).locator('p').first()).toHaveText('Inline picture:');
  });

  test('pictures that cannot be recovered are left out with a notice, the text still arrives', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    // Word HTML without the RTF flavour: the picture bytes are not available.
    await paste(page, { 'text/html': wordHtml });
    await expect(page.locator('.toast-error')).toContainText('could not be imported');
    await expect(editor(page).locator('p strong')).toHaveText('Quarterly report');
    await expect(editor(page).locator('img')).toHaveCount(0);
  });
});

test.describe('Account and navigation', () => {
  test('change your own username in settings', async ({ page, browser }) => {
    const admin = await signIn(page, 'admin');
    const name = `user${Date.now()}`;
    await api(page, admin, 'POST', '/api/admin/users', { username: name, password: 'correct horse battery' });
    const context = await browser.newContext();
    const userPage = await context.newPage();
    await signIn(userPage, name);
    await userPage.goto('/');
    await userPage.getByRole('button', { name: 'Settings' }).click();
    const settings = userPage.getByRole('dialog', { name: 'Settings' });
    await expect(settings.getByLabel('Email')).toHaveCount(0);
    await expect(settings.getByLabel('Name', { exact: true })).toHaveCount(0);
    const field = settings.getByLabel('Username');
    await expect(field).toBeEnabled();
    await expect(field).toHaveValue(name);
    await field.fill(`${name}-renamed`);
    await settings.getByRole('button', { name: 'Save' }).click();
    await expect(userPage.locator('.toast')).toContainText('Username changed');

    const again = await browser.newContext();
    const loginPage = await again.newPage();
    await signIn(loginPage, `${name}-renamed`);
    await loginPage.goto('/');
    await expect(loginPage.locator('.home-title')).toContainText(`${name}-renamed`);
    await context.close();
    await again.close();
  });

  test('library lists every page with filters and sorting', async ({ page }) => {
    const stamp = `lib${Date.now()}`;
    const first = await openNewPage(page, session, { title: `${stamp} Alpha` });
    await openNewPage(page, session, { title: `${stamp} Beta`, parentId: first.id });
    await api(page, session, 'PUT', `/api/pages/${first.id}/favorite`);
    await page.getByRole('link', { name: 'Library' }).click();
    await expect(page).toHaveURL(/\/library$/);
    await page.getByLabel('Filter pages').fill(stamp);
    const rows = page.locator('.library-row');
    await expect(rows).toHaveCount(2);
    // Each row shows where the page lives.
    await expect(rows.filter({ hasText: `${stamp} Beta` })).toContainText(`Private / ${stamp} Alpha`);
    await page.getByLabel('Sort by').selectOption('title');
    await expect(rows).toContainText([`${stamp} Alpha`, `${stamp} Beta`]);
    await page.locator('.library-filters').getByRole('button', { name: 'Favorites' }).click();
    await expect(rows).toHaveCount(1);
    await rows.first().click();
    await expect(page.locator('.page-title')).toHaveValue(`${stamp} Alpha`);
  });

  test('the logo is the KamiSpace mark, in the sidebar and as favicon', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.workspace-button svg.logo-mark')).toBeVisible();
    await expect(page.locator('.workspace-button')).toContainText('KamiSpace');
    await expect(page.locator('.workspace-button')).not.toHaveText(/^M/);
    const favicon = await page.request.get('/static/favicon.svg');
    expect(await favicon.text()).not.toContain('M8.5 22V10.5'); // the old "M" shape
    await expect(page).toHaveTitle(/KamiSpace/);
  });
});
