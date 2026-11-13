import { expect, test } from '@playwright/test';
import {
  blockTexts,
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

// 1x1 transparent PNG
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAACAAAB4iG8MwAAAABJRU5ErkJggg==';

let session;

test.beforeEach(async ({ page }) => {
  session = await signIn(page);
});

async function hoverBlock(page, text) {
  const block = editor(page).locator(':scope > *', { hasText: text }).first();
  await block.hover({ position: { x: 20, y: 8 } });
  await expect(page.locator('.block-handle')).toBeVisible();
  return block;
}

async function openBlockMenu(page, text) {
  await hoverBlock(page, text);
  await page.locator('.block-grip').click();
  await expect(page.locator('.menu')).toBeVisible();
}

test.describe('Block controls', () => {
  test('controls stay hidden until a block is hovered', async ({ page }) => {
    await openNewPage(page, session, { content: doc('alpha', 'beta') });
    await expect(page.locator('.block-handle')).toBeHidden();
    await expect(page.locator('.bubble-toolbar')).toBeHidden();
    await hoverBlock(page, 'beta');
    // The handle sits in the gutter, level with the hovered block.
    const handle = await page.locator('.block-handle').boundingBox();
    const block = await editor(page).locator('p', { hasText: 'beta' }).boundingBox();
    expect(handle.x + handle.width).toBeLessThanOrEqual(block.x + 60);
    expect(Math.abs(handle.y + handle.height / 2 - (block.y + block.height / 2))).toBeLessThan(8);
    // Typing hides it again.
    await focusEditor(page);
    await page.keyboard.type('x');
    await expect(page.locator('.block-handle')).toBeHidden();
  });

  test('"+" adds a block below and opens the block menu', async ({ page }) => {
    await openNewPage(page, session, { content: doc('alpha', 'beta') });
    await hoverBlock(page, 'alpha');
    await page.locator('.block-add').click();
    await expect(page.locator('.slash-menu')).toBeVisible();
    await page.keyboard.type('h2');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Inserted');
    expect(await blockTexts(page)).toEqual(['alpha', 'Inserted', 'beta']);
    await expect(editor(page).locator('h2')).toHaveText('Inserted');
  });

  test('duplicate, move and delete from the block menu', async ({ page }) => {
    await openNewPage(page, session, { content: doc('one', 'two', 'three') });

    await openBlockMenu(page, 'two');
    await page.locator('.menu-item', { hasText: 'Duplicate' }).click();
    expect(await blockTexts(page)).toEqual(['one', 'two', 'two', 'three']);

    await openBlockMenu(page, 'three');
    await page.locator('.menu-item', { hasText: 'Move up' }).click();
    expect(await blockTexts(page)).toEqual(['one', 'two', 'three', 'two']);

    await openBlockMenu(page, 'one');
    await page.locator('.menu-item', { hasText: 'Move down' }).click();
    expect(await blockTexts(page)).toEqual(['two', 'one', 'three', 'two']);

    await openBlockMenu(page, 'three');
    await page.locator('.menu-item', { hasText: 'Delete' }).click();
    expect(await blockTexts(page)).toEqual(['two', 'one', 'two']);
  });

  test('the block menu is keyboard navigable', async ({ page }) => {
    await openNewPage(page, session, { content: doc('one', 'two') });
    await openBlockMenu(page, 'one');
    await page.keyboard.press('ArrowDown'); // Turn into
    await page.keyboard.press('ArrowDown'); // Duplicate
    await expect(page.locator('.menu-item.is-active')).toContainText('Duplicate');
    await page.keyboard.press('Enter');
    expect(await blockTexts(page)).toEqual(['one', 'one', 'two']);
    await openBlockMenu(page, 'two');
    await page.keyboard.press('Escape');
    await expect(page.locator('.menu')).toBeHidden();
    expect(await blockTexts(page)).toEqual(['one', 'one', 'two']);
  });

  test('"Turn into" changes the block type', async ({ page }) => {
    await openNewPage(page, session, { content: doc('convert me', 'untouched') });
    await openBlockMenu(page, 'convert me');
    await page.locator('.menu-item', { hasText: 'Turn into' }).click();
    await page.locator('.menu-item', { hasText: 'Heading 2' }).click();
    await expect(editor(page).locator('h2')).toHaveText('convert me');

    await openBlockMenu(page, 'convert me');
    await page.locator('.menu-item', { hasText: 'Turn into' }).click();
    await page.locator('.menu-item', { hasText: 'To-do list' }).click();
    await expect(editor(page).locator('ul[data-type="taskList"] li > div')).toHaveText('convert me');

    await openBlockMenu(page, 'convert me');
    await page.locator('.menu-item', { hasText: 'Turn into' }).click();
    await page.locator('.menu-item', { hasText: 'Callout' }).click();
    await expect(editor(page).locator('.callout')).toContainText('convert me');
    await expect(editor(page).locator('p', { hasText: 'untouched' })).toHaveCount(1);
  });

  test('blocks can be reordered by dragging the handle', async ({ page }) => {
    const created = await openNewPage(page, session, {
      content: doc('first', 'second', 'third', 'fourth'),
    });
    await hoverBlock(page, 'fourth');
    const grip = await page.locator('.block-grip').boundingBox();
    const target = await editor(page).locator('p', { hasText: 'first' }).boundingBox();

    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 80, target.y + 40, { steps: 6 });
    await page.mouse.move(target.x + 80, target.y + 2, { steps: 6 });
    await page.mouse.up();

    expect(await blockTexts(page)).toEqual(['fourth', 'first', 'second', 'third']);
    // One undo puts the block back.
    await clickInto(editor(page).locator('p', { hasText: 'second' }));
    await page.keyboard.press(`${mod}+z`);
    expect(await blockTexts(page)).toEqual(['first', 'second', 'third', 'fourth']);
    await page.keyboard.press(`${mod}+Shift+z`);
    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    expect(stored.content.map((node) => node.content[0].text)).toEqual([
      'fourth',
      'first',
      'second',
      'third',
    ]);
  });

  test('dragging a block downwards', async ({ page }) => {
    await openNewPage(page, session, { content: doc('first', 'second', 'third') });
    await hoverBlock(page, 'first');
    const grip = await page.locator('.block-grip').boundingBox();
    const target = await editor(page).locator('p', { hasText: 'third' }).boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 80, target.y + 4, { steps: 6 });
    await page.mouse.move(target.x + 80, target.y + target.height - 2, { steps: 6 });
    await page.mouse.up();
    expect(await blockTexts(page)).toEqual(['second', 'third', 'first']);
  });
});

test.describe('Selection toolbar and links', () => {
  test('the toolbar appears for a text selection and formats it', async ({ page }) => {
    await openNewPage(page, session, { content: doc('make this bold') });
    const first = editor(page).locator('p').first();
    await first.dblclick({ position: { x: 30, y: 10 } });
    const toolbar = page.locator('.bubble-toolbar');
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: /Bold/ }).click();
    await expect(first.locator('strong')).toHaveText('make');
    await expect(toolbar.getByRole('button', { name: /Bold/ })).toHaveClass(/is-on/);
    // Collapsing the selection hides it.
    await page.keyboard.press('ArrowRight');
    await expect(toolbar).toBeHidden();
  });

  test('turn into from the toolbar', async ({ page }) => {
    await openNewPage(page, session, { content: doc('a heading') });
    await clickInto(editor(page).locator('p').first());
    await page.keyboard.press(`${mod}+a`);
    await page.locator('.bubble-turn').click();
    await page.locator('.menu-item', { hasText: 'Heading 1' }).click();
    await expect(editor(page).locator('h1')).toHaveText('a heading');
  });

  test('Ctrl+K links the selection; unsafe addresses are refused', async ({ page }) => {
    const created = await openNewPage(page, session, { content: doc('visit our site') });
    await clickInto(editor(page).locator('p').first());
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.press(`${mod}+k`);
    const input = page.locator('.link-editor input');
    await expect(input).toBeFocused();
    await expect(page.locator('.palette')).toHaveCount(0); // not the search palette

    await input.fill('javascript:alert(1)');
    await page.keyboard.press('Enter');
    await expect(page.locator('.link-error')).toHaveText(/valid/);
    await expect(editor(page).locator('a')).toHaveCount(0);

    await input.fill('example.com/docs');
    await page.keyboard.press('Enter');
    const link = editor(page).locator('a');
    await expect(link).toHaveText('visit our site');
    await expect(link).toHaveAttribute('href', 'https://example.com/docs');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    expect(stored.content[0].content[0].marks).toEqual([
      { type: 'link', attrs: { href: 'https://example.com/docs' } },
    ]);
  });

  test('editing and removing an existing link', async ({ page }) => {
    const linked = {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'docs',
          marks: [{ type: 'link', attrs: { href: 'https://old.example' } }],
        },
      ],
    };
    await openNewPage(page, session, { content: doc(linked) });
    await editor(page).locator('a').click();
    const preview = page.locator('.link-preview');
    await expect(preview).toContainText('https://old.example');
    await preview.getByRole('button', { name: 'Edit link' }).click();
    await page.locator('.link-editor input').fill('https://new.example');
    await page.keyboard.press('Enter');
    await expect(editor(page).locator('a')).toHaveAttribute('href', 'https://new.example');

    await page.waitForTimeout(600); // otherwise this counts as a double click
    await editor(page).locator('a').click();
    await page.locator('.link-preview').getByRole('button', { name: 'Remove link' }).click();
    await expect(editor(page).locator('a')).toHaveCount(0);
    await expect(editor(page).locator('p').first()).toHaveText('docs');
  });

  test('Ctrl+K without a selection opens search instead', async ({ page }) => {
    await openNewPage(page, session, { content: doc('nothing selected') });
    await clickInto(editor(page).locator('p').first());
    await page.keyboard.press(`${mod}+k`);
    await expect(page.locator('.palette-input')).toBeFocused();
    await expect(page.locator('.link-editor')).toHaveCount(0);
  });
});

test.describe('Rich blocks', () => {
  test('callout style cycles when its icon is clicked', async ({ page }) => {
    const created = await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('/callout');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Heads up');
    const callout = editor(page).locator('.callout');
    await expect(callout).toHaveAttribute('data-variant', 'info');
    await callout.locator('.callout-icon').click();
    await expect(callout).toHaveAttribute('data-variant', 'success');
    await callout.locator('.callout-icon').click();
    await expect(callout).toHaveAttribute('data-variant', 'warning');
    await expect(callout.locator('.callout-content')).toHaveText('Heads up');
    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    expect(stored.content[0].attrs.variant).toBe('warning');
  });

  test('code blocks are highlighted and the language can be changed', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('```python ');
    await page.keyboard.type('def hello():');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('return 42');
    const block = editor(page).locator('.code-block');
    await expect(block.locator('.hljs-keyword').first()).toHaveText('def');
    await expect(block.locator('select')).toHaveValue('python');
    await expect(block.locator('code')).toContainText('  return 42'); // Tab indents

    await block.locator('select').selectOption('json');
    await expect(block.locator('.hljs-keyword')).toHaveCount(0);
    // Markdown rules do not fire inside code.
    await clickInto(block.locator('code'));
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('# not a heading');
    await expect(editor(page).locator('h1')).toHaveCount(0);
    await expect(block.locator('code')).toContainText('# not a heading');

    // "Plain text" really is plain: no guessed highlighting.
    await block.locator('select').selectOption('');
    await expect(block.locator('[class^="hljs-"]')).toHaveCount(0);
    await block.locator('select').selectOption('python');
    await expect(block.locator('.hljs-keyword').first()).toHaveText('def');
  });

  test('table: typing, Tab between cells, add and delete rows', async ({ page }) => {
    await openNewPage(page, session);
    await focusEditor(page);
    await page.keyboard.type('/table');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Name');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Role');
    const table = editor(page).locator('table');
    await expect(table.locator('th').nth(0)).toHaveText('Name');
    await expect(table.locator('th').nth(1)).toHaveText('Role');
    await expect(table.locator('tr')).toHaveCount(3);

    const toolbar = page.locator('.table-toolbar');
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Add row below' }).click();
    await expect(table.locator('tr')).toHaveCount(4);
    await toolbar.getByRole('button', { name: 'Add column right' }).click();
    await expect(table.locator('tr').first().locator('th')).toHaveCount(4);
    await toolbar.getByRole('button', { name: 'Delete table' }).click();
    await expect(editor(page).locator('table')).toHaveCount(0);
    await expect(toolbar).toBeHidden();
  });
});

test.describe('Uploads', () => {
  async function dispatchFile(page, type, { name, mime, base64, text }) {
    await page.evaluate(
      ({ type, name, mime, base64, text }) => {
        const bytes = base64
          ? Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
          : new TextEncoder().encode(text);
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], name, { type: mime }));
        const target = document.querySelector('.doc');
        if (type === 'paste') {
          target.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
          );
        } else {
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
        }
      },
      { type, name, mime, base64, text },
    );
  }

  test('pasting a screenshot uploads it and embeds an image block', async ({ page }) => {
    const created = await openNewPage(page, session, { content: doc('before') });
    await focusEditor(page);
    await dispatchFile(page, 'paste', { name: 'screenshot.png', mime: 'image/png', base64: PNG_BASE64 });
    const image = editor(page).locator('figure.image-block img');
    await expect(image).toHaveCount(1);
    await expect(image).toHaveAttribute('src', /^\/api\/files\/[0-9a-f]{32}$/);
    await expect(image).toHaveAttribute('loading', 'lazy');
    await expect(page.locator('.upload-placeholder')).toHaveCount(0);
    // The image really loads through the access-controlled endpoint.
    await expect.poll(() => image.evaluate((img) => img.complete && img.naturalWidth)).toBe(1);

    await waitForSaved(page);
    const stored = await storedContent(page, created.id);
    expect(stored.content.map((node) => node.type)).toEqual(['paragraph', 'image', 'paragraph']);
    await page.reload();
    await expect(editor(page).locator('figure.image-block img')).toHaveCount(1);
  });

  test('dropping a file creates an attachment block with name, type and size', async ({ page }) => {
    await openNewPage(page, session, { content: doc('notes') });
    await dispatchFile(page, 'drop', { name: 'meeting notes.md', mime: 'text/markdown', text: '# Agenda\n' });
    const attachment = editor(page).locator('.attachment');
    await expect(attachment.locator('.attachment-name')).toHaveText('meeting notes.md');
    await expect(attachment.locator('.attachment-meta')).toHaveText('MD · 9 B');
    const download = attachment.getByRole('link', { name: /Download/ });
    await expect(download).toHaveAttribute('href', /^\/api\/files\/[0-9a-f]{32}\?download=1$/);
    const response = await page.request.get(await download.getAttribute('href'));
    expect(await response.text()).toBe('# Agenda\n');
    expect(response.headers()['content-disposition']).toContain('attachment');
  });

  test('PDF attachments offer an embedded preview', async ({ page }) => {
    await openNewPage(page, session, { content: doc('report') });
    await dispatchFile(page, 'drop', {
      name: 'report.pdf',
      mime: 'application/pdf',
      text: '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n',
    });
    const attachment = editor(page).locator('.attachment');
    await expect(attachment.locator('.attachment-meta')).toContainText('PDF');
    await expect(attachment.locator('iframe')).toHaveCount(0); // lazy: nothing loaded yet
    await attachment.getByRole('button', { name: 'Preview' }).click();
    await expect(attachment.locator('iframe')).toHaveAttribute('src', /^\/api\/files\/[0-9a-f]{32}$/);
    await attachment.getByRole('button', { name: 'Hide preview' }).click();
    await expect(attachment.locator('iframe')).toHaveCount(0);
  });

  test('unsupported files are refused with a message', async ({ page }) => {
    await openNewPage(page, session, { content: doc('safe') });
    await dispatchFile(page, 'drop', { name: 'malware.exe', mime: 'application/octet-stream', text: 'MZ' });
    await expect(page.locator('.toast-error')).toContainText('not supported');
    await expect(editor(page).locator('.attachment, .image-block')).toHaveCount(0);
  });

  test('a file whose content does not match its type is rejected by the server', async ({ page }) => {
    await openNewPage(page, session, { content: doc('safe') });
    await dispatchFile(page, 'drop', { name: 'fake.png', mime: 'image/png', text: '<script>alert(1)</script>' });
    await expect(page.locator('.toast-error')).toContainText('does not match');
    await expect(page.locator('.upload-placeholder')).toHaveCount(0);
    await expect(editor(page).locator('.image-block')).toHaveCount(0);
  });
});

test('stored markup can never run as HTML', async ({ page }) => {
  const payload = '<img src=x onerror="window.__xss = 1"><script>window.__xss = 1</script>';
  await openNewPage(page, session, {
    title: payload,
    content: doc(paragraph(payload)),
  });
  await expect(editor(page).locator('p').first()).toHaveText(payload);
  await expect(editor(page).locator('img, script')).toHaveCount(0);
  await expect(page.locator('.tree-row.is-active .tree-title')).toHaveText(payload);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});
