// Behaviour modelled on Notion: every line is a block wherever it lives
// (also inside toggles), pictures have resize handles and a hover toolbar,
// links show a card on hover and pasted addresses offer other shapes.
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

let session;

test.beforeEach(async ({ page }) => {
  session = await signIn(page);
});

const toggle = (summary, ...blocks) => ({
  type: 'details',
  attrs: { open: true, level: 0 },
  content: [
    { type: 'detailsSummary', content: summary ? [{ type: 'text', text: summary }] : [] },
    { type: 'detailsContent', content: blocks },
  ],
});

function texts(node) {
  return (node.content ?? []).map((child) => (child.content ?? []).map((t) => t.text).join(''));
}

async function hoverLine(page, text) {
  const line = editor(page).getByText(text, { exact: true });
  await line.hover({ position: { x: 20, y: 8 } });
  await expect(page.locator('.block-handle')).toBeVisible();
  return line;
}

async function dragGripTo(page, x, y) {
  const grip = await page.locator('.block-grip').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y - 30, { steps: 6 });
  await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.up();
}

async function paste(page, data) {
  await page.evaluate((data) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
    document
      .querySelector('.doc')
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, data);
}

test.describe('Blocks inside a toggle', () => {
  test('each line has its own handle and can be turned into another block without leaving the toggle', async ({
    page,
  }) => {
    const created = await openNewPage(page, session, {
      content: doc('before', toggle('Details', paragraph('line one'), paragraph('line two')), 'after'),
    });
    const line = await hoverLine(page, 'line two');
    // The handle sits next to that line, not next to the toggle as a whole.
    const handle = await page.locator('.block-handle').boundingBox();
    const box = await line.boundingBox();
    expect(Math.abs(handle.y + handle.height / 2 - (box.y + box.height / 2))).toBeLessThan(8);
    expect(handle.x + handle.width).toBeLessThanOrEqual(box.x + 2);

    await page.locator('.block-grip').click();
    await page.locator('.menu-item', { hasText: 'Turn into' }).click();
    await page.getByRole('menuitem', { name: 'Heading 2', exact: true }).click();
    const body = editor(page).locator('div[data-type="detailsContent"]');
    await expect(body.locator('h2')).toHaveText('line two');
    await expect(body.locator('p')).toHaveText('line one');

    // The slash menu converts the line it is typed in as well.
    await clickInto(body.locator('p'));
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/todo');
    await page.keyboard.press('Enter');
    await page.keyboard.type('a task');
    await expect(body.locator('ul[data-type="taskList"] li p')).toHaveText('a task');

    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    expect(stored.content.map((node) => node.type)).toEqual(['paragraph', 'details', 'paragraph']);
    expect(stored.content[1].content[1].content.map((node) => node.type)).toEqual([
      'paragraph',
      'taskList',
      'heading',
    ]);
  });

  test('a block can be dragged into a toggle and out again', async ({ page }) => {
    const created = await openNewPage(page, session, {
      content: doc('outside', toggle('Box', paragraph('inside one'), paragraph('inside two')), 'last'),
    });
    await hoverLine(page, 'outside');
    const target = await editor(page).getByText('inside two', { exact: true }).boundingBox();
    await dragGripTo(page, target.x + 60, target.y + target.height - 3);
    const body = editor(page).locator('div[data-type="detailsContent"]');
    await expect(body.locator('p')).toHaveText(['inside one', 'inside two', 'outside']);

    await hoverLine(page, 'inside one');
    const last = await editor(page).locator(':scope > p', { hasText: 'last' }).boundingBox();
    await dragGripTo(page, last.x + 60, last.y + last.height - 3);
    await expect(body.locator('p')).toHaveText(['inside two', 'outside']);
    await expect(editor(page).locator(':scope > p')).toHaveText(['last', 'inside one']);

    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    expect(texts(stored.content[0].content[1])).toEqual(['inside two', 'outside']);
  });

  test('dropping onto the summary of a closed toggle puts the block inside', async ({ page }) => {
    const closed = toggle('Closed box', paragraph('hidden'));
    closed.attrs.open = false;
    const created = await openNewPage(page, session, { content: doc(closed, 'move me') });
    await hoverLine(page, 'move me');
    const summary = await editor(page).locator('summary').boundingBox();
    // Indented under the summary text → into the toggle.
    await dragGripTo(page, summary.x + 80, summary.y + summary.height - 2);
    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    expect(stored.content[0].type).toBe('details');
    expect(texts(stored.content[0].content[1])).toContain('move me');
  });

  test('Tab moves a block into the toggle above it, Shift+Tab takes it out', async ({ page }) => {
    await openNewPage(page, session, { content: doc(toggle('Box', paragraph('inside')), 'follower') });
    await clickInto(editor(page).locator(':scope > p', { hasText: 'follower' }));
    await page.keyboard.press('Tab');
    const body = editor(page).locator('div[data-type="detailsContent"]');
    await expect(body.locator('p')).toHaveText(['inside', 'follower']);
    await page.keyboard.type('!');
    await expect(body.locator('p').last()).toHaveText(/!/);
    await page.keyboard.press('Shift+Tab');
    await expect(body.locator('p')).toHaveText(['inside']);
    await expect(editor(page).locator(':scope > p').first()).toHaveText(/follower/);
  });

  test('an empty toggle says so, a click starts writing in it, Enter on an empty line leaves it', async ({
    page,
  }) => {
    await openNewPage(page, session, { content: doc(toggle('Empty')) });
    const body = editor(page).locator('div[data-type="detailsContent"]');
    const hint = await body.evaluate((el) => getComputedStyle(el, '::before').content);
    expect(hint).toContain('Empty toggle');
    await body.click();
    await page.waitForTimeout(60);
    await page.keyboard.type('first');
    await expect(body.locator('p')).toHaveText('first');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('outside');
    await expect(body.locator('p')).toHaveText(['first']);
    await expect(editor(page).locator(':scope > p').first()).toHaveText('outside');
  });

  test('list items are blocks too: one item can be dragged out of its list', async ({ page }) => {
    const list = {
      type: 'bulletList',
      content: ['one', 'two', 'three'].map((text) => ({ type: 'listItem', content: [paragraph(text)] })),
    };
    const created = await openNewPage(page, session, { content: doc('top', list) });
    await editor(page).locator('li', { hasText: 'two' }).hover({ position: { x: 20, y: 8 } });
    await expect(page.locator('.block-handle')).toBeVisible();
    const top = await editor(page).locator(':scope > p', { hasText: 'top' }).boundingBox();
    await dragGripTo(page, top.x + 60, top.y + 2);
    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    expect(stored.content.map((node) => node.type).slice(0, 3)).toEqual(['bulletList', 'paragraph', 'bulletList']);
    expect(stored.content[0].content).toHaveLength(1);
    expect(stored.content[2].content).toHaveLength(2);
  });
});

test.describe('Pictures', () => {
  async function pastePicture(page) {
    const uri = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 200;
      const context = canvas.getContext('2d');
      context.fillStyle = '#e8a04a';
      context.fillRect(0, 0, 400, 200);
      return canvas.toDataURL('image/png');
    });
    await paste(page, { 'text/html': `<p>From Word</p><p><img src="${uri}"></p>` });
    const figure = editor(page).locator('figure.image-block');
    await expect(figure.locator('img')).toHaveAttribute('src', /^\/api\/files\/[0-9a-f]{32}$/);
    await expect.poll(() => figure.locator('img').evaluate((img) => img.naturalWidth)).toBe(400);
    return figure;
  }

  test('a pasted picture is not left selected or framed; writing carries on below it', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    const figure = await pastePicture(page);
    await expect(editor(page).locator('.ProseMirror-selectednode')).toHaveCount(0);
    const outlines = await figure.evaluate((el) => [
      getComputedStyle(el).outlineStyle,
      getComputedStyle(el.querySelector('img')).outlineStyle,
    ]);
    expect(outlines).toEqual(['none', 'none']);
    // Centred in the text column.
    const column = await figure.boundingBox();
    const picture = await figure.locator('img').boundingBox();
    expect(Math.abs(picture.x + picture.width / 2 - (column.x + column.width / 2))).toBeLessThan(2);

    await page.keyboard.type('next line');
    await expect(editor(page).locator('figure.image-block + p')).toHaveText('next line');
  });

  test('toolbar on hover: resize with the side handles, align, caption, full size', async ({ page }) => {
    const created = await openNewPage(page, session);
    await focusEditor(page);
    const figure = await pastePicture(page);
    const tools = figure.locator('.image-tools');
    await expect(tools).toHaveCSS('opacity', '0');
    await figure.locator('img').hover();
    await expect(tools).toHaveCSS('opacity', '1');

    // Drag the right handle inwards: the picture gets narrower, around its centre.
    const before = await figure.locator('img').boundingBox();
    const handle = await figure.locator('.image-handle-right').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x - 60, handle.y + handle.height / 2, { steps: 5 });
    await page.mouse.up();
    const after = await figure.locator('img').boundingBox();
    expect(after.width).toBeLessThan(before.width - 80);
    expect(Math.abs(after.x + after.width / 2 - (before.x + before.width / 2))).toBeLessThan(6);

    await figure.locator('img').hover();
    await tools.getByRole('button', { name: 'Align' }).click();
    await page.getByRole('menuitem', { name: 'Left', exact: true }).click();
    await expect(figure).toHaveAttribute('data-align', 'left');

    await figure.locator('img').hover();
    await tools.getByRole('button', { name: 'Caption' }).click();
    await page.keyboard.type('Figure 1: an orange box');
    await page.keyboard.press('Enter');

    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    const image = stored.content.find((node) => node.type === 'image');
    expect(image.attrs.align).toBe('left');
    expect(image.attrs.caption).toBe('Figure 1: an orange box');
    expect(image.attrs.width).toBeGreaterThanOrEqual(10);
    expect(image.attrs.width).toBeLessThan(55);

    await page.reload();
    const reloaded = editor(page).locator('figure.image-block');
    await expect(reloaded).toHaveAttribute('data-align', 'left');
    await expect(reloaded.locator('.image-caption-input')).toHaveValue('Figure 1: an orange box');

    await reloaded.locator('img').hover();
    await reloaded.getByRole('button', { name: 'View original' }).click();
    await expect(page.locator('.lightbox img')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.lightbox')).toHaveCount(0);
  });

  test('a selected picture gets a soft tint instead of a hard frame', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    const figure = await pastePicture(page);
    await figure.locator('img').click();
    await expect(figure).toHaveClass(/ProseMirror-selectednode/);
    const style = await figure.evaluate((el) => ({
      outline: getComputedStyle(el).outlineStyle,
      imageOutline: getComputedStyle(el.querySelector('img')).outlineStyle,
      shadow: getComputedStyle(el).boxShadow,
      tint: getComputedStyle(el.querySelector('.image-frame'), '::after').opacity,
    }));
    expect(style).toEqual({ outline: 'none', imageOutline: 'none', shadow: 'none', tint: '1' });
    await page.keyboard.press('Backspace');
    await expect(editor(page).locator('figure.image-block')).toHaveCount(0);
  });
});

test.describe('Links', () => {
  const linked = (href) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href } }] }],
  });

  test('hovering shows the address with copy; clicking opens the link in a new tab', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openNewPage(page, session, { content: doc(linked('/static/favicon.svg')) });
    await expect(page.locator('.link-hover')).toHaveCount(0);
    await editor(page).locator('a').hover();
    const card = page.locator('.link-hover');
    await expect(card).toContainText('/static/favicon.svg');
    await card.getByRole('button', { name: 'Copy link' }).click();
    await expect(card).toHaveCount(0);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `${new URL(page.url()).origin}/static/favicon.svg`,
    );
    // Moving away hides the card.
    await editor(page).locator('a').hover();
    await expect(card).toBeVisible();
    await page.mouse.move(600, 500);
    await expect(card).toHaveCount(0);

    const popup = page.waitForEvent('popup');
    await editor(page).locator('a').click();
    await expect.poll(async () => (await popup).url()).toContain('/static/favicon.svg');
  });

  test('pasting an address makes a link and offers a bookmark or an embed', async ({ page }) => {
    const created = await openNewPage(page, session);
    await focusEditor(page);
    await paste(page, { 'text/plain': 'https://example.com/article' });
    await expect(editor(page).locator('a')).toHaveAttribute('href', 'https://example.com/article');
    const menu = page.locator('.paste-menu');
    await expect(menu.locator('.menu-heading')).toHaveText('Paste as');
    await expect(menu.getByRole('menuitem')).toHaveText([/URL/, /Bookmark/, /Embed/]);
    await menu.getByRole('menuitem', { name: /Bookmark/ }).click();
    await expect(editor(page).locator('a[href="https://example.com/article"]:not(.bookmark *)')).toHaveCount(0);
    await expect(editor(page).locator('.bookmark')).toContainText('example.com');
    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    expect(stored.content[0]).toMatchObject({ type: 'bookmark', attrs: { url: 'https://example.com/article' } });
  });

  test('typing on dismisses the paste menu and keeps the link; Embed replaces it', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    await paste(page, { 'text/plain': 'https://example.com/a' });
    await expect(page.locator('.paste-menu')).toBeVisible();
    await page.keyboard.type(' ok');
    await expect(page.locator('.paste-menu')).toHaveCount(0);
    await expect(editor(page).locator('p').first()).toHaveText('https://example.com/a ok');
    await expect(editor(page).locator('a')).toHaveText('https://example.com/a');

    await page.keyboard.press('Enter');
    await paste(page, { 'text/plain': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    await page.locator('.paste-menu').getByRole('menuitem', { name: /Embed/ }).click();
    await expect(editor(page).locator('.embed iframe')).toHaveAttribute('src', /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  });

  test('an address pasted over selected text links that text, without a menu', async ({ page }) => {
    await openNewPage(page, session, { content: doc('read the guide') });
    await clickInto(editor(page).locator('p').first());
    await page.keyboard.press(`${mod}+a`);
    await page.waitForTimeout(60);
    await paste(page, { 'text/plain': 'https://example.com/guide' });
    await expect(editor(page).locator('a')).toHaveText('read the guide');
    await expect(page.locator('.paste-menu')).toHaveCount(0);
  });

  test('Ctrl+K suggests pages; a link to a page opens it inside the app', async ({ page }) => {
    const stamp = Date.now();
    const target = await api(page, session, 'POST', '/api/pages', {
      title: `Roadmap ${stamp}`,
      workspace_id: await personalWorkspaceId(page),
    });
    const created = await openNewPage(page, session, { content: doc('see the plan') });
    await clickInto(editor(page).locator('p').first());
    await page.keyboard.press(`${mod}+a`);
    await page.waitForTimeout(60);
    await page.keyboard.press(`${mod}+k`);
    await page.locator('.link-editor input').fill(`roadmap ${stamp}`);
    const suggestion = page.locator('.link-suggestion');
    await expect(suggestion).toHaveText(`Roadmap ${stamp}`);
    await page.keyboard.press('Enter');
    await expect(editor(page).locator('a')).toHaveAttribute('href', `/p/${target.id}`);
    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    expect(stored.content[0].content[0].marks).toEqual([{ type: 'link', attrs: { href: `/p/${target.id}` } }]);

    await editor(page).locator('a').hover();
    await expect(page.locator('.link-hover')).toContainText(`Roadmap ${stamp}`);
    await editor(page).locator('a').click();
    await expect(page).toHaveURL(new RegExp(`/p/${target.id}$`));
    await expect(page.locator('.page-title')).toHaveValue(`Roadmap ${stamp}`);
  });
});

test('cover buttons stay readable when hovered', async ({ page }) => {
  await openNewPage(page, session, { title: 'With cover' });
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.page-head').hover();
  await page.getByRole('button', { name: 'Add cover' }).click();
  await (await chooser).setFiles({
    name: 'cover.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAACAAAB4iG8MwAAAABJRU5ErkJggg==',
      'base64',
    ),
  });
  await expect(page.locator('.page-cover img')).toBeVisible();
  for (const name of ['Change cover', 'Reposition', 'Remove']) {
    const button = page.locator('.cover-actions').getByRole('button', { name });
    await page.locator('.page-cover').hover();
    await button.hover();
    await expect(button).toBeVisible();
    // An opaque background: the label must not dissolve into the picture.
    const background = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background).toMatch(/^rgb\(/);
    await expect(button).toHaveText(name);
  }
});

test('the slash menu is grouped into sections; searching shows a flat list', async ({ page }) => {
  await openNewPage(page, session);
  await focusEditor(page);
  await page.keyboard.type('/');
  await expect(page.locator('.slash-group').first()).toHaveText('Basic blocks');
  expect(await page.locator('.slash-group').count()).toBeGreaterThan(2);
  await page.keyboard.type('head');
  await expect(page.locator('.slash-group')).toHaveCount(0);
  await expect(page.locator('.slash-item').first()).toHaveAttribute('data-command', 'h1');
});
