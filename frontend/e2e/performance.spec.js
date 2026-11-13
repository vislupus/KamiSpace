import { expect, test } from '@playwright/test';
import { api, clickInto, editor, openNewPage, signIn, waitForSaved } from './helpers.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAACAAAB4iG8MwAAAABJRU5ErkJggg==',
  'base64',
);

const text = (value) => ({ type: 'text', text: value });
const para = (value) => ({ type: 'paragraph', content: [text(value)] });
const SENTENCE =
  'MindDock keeps every page on your own server, so long documents have to stay pleasant to edit. ';

/** A long, varied document: ~600 top-level blocks of every expensive kind. */
function longDocument(attachmentId) {
  const blocks = [];
  for (let section = 0; section < 40; section += 1) {
    blocks.push({ type: 'heading', attrs: { level: 2 }, content: [text(`Section ${section + 1}`)] });
    for (let i = 0; i < 8; i += 1) blocks.push(para(`${SENTENCE}${SENTENCE}(${section}.${i})`));
    blocks.push({
      type: 'codeBlock',
      attrs: { language: 'python' },
      content: [
        text(
          Array.from(
            { length: 12 },
            (_, line) => `def handler_${section}_${line}(request):\n    return {"ok": True, "n": ${line}}`,
          ).join('\n'),
        ),
      ],
    });
    blocks.push({
      type: 'bulletList',
      content: Array.from({ length: 4 }, (_, i) => ({
        type: 'listItem',
        content: [
          para(`Item ${i + 1}`),
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [para('Nested item')] },
              { type: 'listItem', content: [para('Another nested item')] },
            ],
          },
        ],
      })),
    });
    blocks.push({
      type: 'table',
      content: Array.from({ length: 4 }, (_, row) => ({
        type: 'tableRow',
        content: Array.from({ length: 4 }, (_, column) => ({
          type: row === 0 ? 'tableHeader' : 'tableCell',
          attrs: { colspan: 1, rowspan: 1, colwidth: null },
          content: [para(`r${row} c${column}`)],
        })),
      })),
    });
    blocks.push({ type: 'image', attrs: { attachmentId, alt: 'pixel', width: null } });
    blocks.push({
      type: 'callout',
      attrs: { variant: 'info', emoji: null },
      content: [para('A callout in the middle of a long page.')],
    });
    blocks.push({
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [para('Done')] },
        { type: 'taskItem', attrs: { checked: false }, content: [para('Not yet')] },
      ],
    });
  }
  return { type: 'doc', content: blocks };
}

test('a 600-block document opens quickly and typing stays responsive', async ({ page }) => {
  test.setTimeout(120_000);
  const session = await signIn(page);

  // Upload one image and reference it from every section.
  const holder = await openNewPage(page, session, { title: 'Image holder' });
  const upload = await page.request.post(`/api/pages/${holder.id}/files`, {
    headers: { 'X-CSRF-Token': session.csrf },
    multipart: { file: { name: 'pixel.png', mimeType: 'image/png', buffer: PNG_BYTES } },
  });
  const attachment = await upload.json();
  const content = longDocument(attachment.id);
  expect(content.content.length).toBeGreaterThanOrEqual(600);
  const created = await api(page, session, 'POST', '/api/pages', {
    title: 'Long document',
    workspace_id: holder.workspace_id,
    content,
  });

  // -- opening --------------------------------------------------------------
  const startedAt = Date.now();
  await page.goto(`/p/${created.id}`);
  await expect(editor(page).locator('h2').first()).toBeVisible();
  const openMs = Date.now() - startedAt;
  expect(await editor(page).evaluate((el) => el.children.length)).toBeGreaterThanOrEqual(600);

  // Images below the fold are lazy and have not been requested.
  const images = editor(page).locator('img');
  expect(await images.count()).toBe(40);
  expect(await images.last().getAttribute('loading')).toBe('lazy');

  // -- typing in the middle -------------------------------------------------
  const target = editor(page).locator('p', { hasText: '(20.3)' }).first();
  await target.scrollIntoViewIfNeeded();
  await clickInto(target);
  await page.keyboard.press('End');

  // Measure key → next frame for each character, inside the page.
  await page.evaluate(() => {
    window.__latencies = [];
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
    }).observe({ entryTypes: ['longtask'] });
    document.querySelector('.doc').addEventListener(
      'keydown',
      () => {
        const start = performance.now();
        requestAnimationFrame(() => {
          // The frame after the keystroke has been processed and laid out.
          setTimeout(() => window.__latencies.push(performance.now() - start), 0);
        });
      },
      true,
    );
  });

  const typed = ' Typing in the middle of a very long document should feel instant.';
  await page.keyboard.type(typed, { delay: 25 });
  await expect(target).toContainText('should feel instant.');

  const { latencies, longTasks } = await page.evaluate(() => ({
    latencies: window.__latencies,
    longTasks: window.__longTasks,
  }));
  const sorted = [...latencies].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const worstTask = Math.max(0, ...longTasks);
  console.log(
    `long document: open ${openMs} ms · key→frame median ${median.toFixed(1)} ms, ` +
      `p95 ${p95.toFixed(1)} ms · longest task ${worstTask.toFixed(0)} ms · ` +
      `${content.content.length} blocks`,
  );

  // Generous limits (shared CI hardware); a frame is ~16 ms.
  expect(openMs).toBeLessThan(5000);
  expect(median).toBeLessThan(50);
  expect(p95).toBeLessThan(120);

  // -- the edit is saved and the structure survives --------------------------
  await waitForSaved(page);
  const stored = await (await page.request.get(`/api/pages/${created.id}`)).json();
  // (+1: the empty paragraph kept after a trailing non-text block)
  expect(stored.content.content.length).toBe(content.content.length + 1);
  expect(JSON.stringify(stored.content)).toContain('should feel instant.');

  // -- slash menu is still instant -------------------------------------------
  await page.keyboard.press('Enter');
  const before = Date.now();
  await page.keyboard.type('/');
  await expect(page.locator('.slash-menu')).toBeVisible();
  expect(Date.now() - before).toBeLessThan(500);
});

test('navigating between pages does not leak editors or listeners', async ({ page }) => {
  const session = await signIn(page);
  const first = await openNewPage(page, session, { title: 'Leak A' });
  const second = await api(page, session, 'POST', '/api/pages', {
    title: 'Leak B',
    workspace_id: first.workspace_id,
  });
  await page.reload();
  await expect(editor(page)).toBeVisible();

  for (let round = 0; round < 12; round += 1) {
    await page.locator('.sidebar .tree-row', { hasText: round % 2 ? 'Leak A' : 'Leak B' }).first().click();
    await expect(page.locator('.page-title')).toHaveValue(round % 2 ? 'Leak A' : 'Leak B');
    await expect(editor(page)).toBeVisible();
  }
  // Exactly one editor and one set of floating controls remain.
  await expect(page.locator('.ProseMirror')).toHaveCount(1);
  await expect(page.locator('.bubble-toolbar')).toHaveCount(1);
  await expect(page.locator('.block-handle')).toHaveCount(1);
  await expect(page.locator('.table-toolbar')).toHaveCount(1);
  await expect(page.locator('.popover:not(.bubble-toolbar)')).toHaveCount(0);
  expect(second.id).toBeGreaterThan(first.id);
});
