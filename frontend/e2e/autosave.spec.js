import { expect, test } from '@playwright/test';
import {
  api,
  clickInto,
  doc,
  editor,
  focusEditor,
  openNewPage,
  signIn,
  storedContent,
  waitForSaved,
} from './helpers.js';

let session;

test.beforeEach(async ({ page }) => {
  session = await signIn(page);
});

function texts(content) {
  return content.content.map((node) => node.content?.[0]?.text ?? '');
}

test('typing is saved automatically, with a visible state and few requests', async ({ page }) => {
  const created = await openNewPage(page, session);
  const saves = [];
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/content')) saves.push(request);
  });
  const state = page.locator('.save-state');
  await expect(state).toHaveAttribute('data-state', 'saved');

  await focusEditor(page);
  await page.keyboard.type('The quick brown fox jumps over the lazy dog. '.repeat(3), { delay: 5 });
  await expect(state).toHaveAttribute('data-state', /dirty|saving/);
  await expect(state).toContainText(/Unsaved changes|Saving/);
  await waitForSaved(page);
  await expect(state).toContainText('Saved');

  // ~135 keystrokes must not turn into ~135 requests.
  expect(saves.length).toBeGreaterThanOrEqual(1);
  expect(saves.length).toBeLessThanOrEqual(4);

  const stored = await storedContent(page, created.id);
  expect(texts(stored)[0]).toContain('lazy dog.');
  await page.reload();
  await expect(editor(page).locator('p').first()).toContainText('The quick brown fox');
});

test('the title is saved and updates the sidebar while typing', async ({ page }) => {
  const created = await openNewPage(page, session, { title: 'Old name' });
  const title = page.locator('.page-title');
  await title.fill('');
  await title.pressSequentially('Roadmap 2027');
  await expect(page.locator('.tree-row.is-active .tree-title')).toHaveText('Roadmap 2027');
  await expect(page.locator('.breadcrumbs .crumb').last()).toHaveText('Roadmap 2027');
  await expect(page).toHaveTitle(/Roadmap 2027/);
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${created.id}`)).json()).title)
    .toBe('Roadmap 2027');
});

test('leaving the page right after typing does not lose the edit', async ({ page }) => {
  const first = await openNewPage(page, session, { title: 'First' });
  await api(page, session, 'POST', '/api/pages', {
    title: 'Second',
    workspace_id: first.workspace_id,
  });
  await page.reload();
  await focusEditor(page);
  await page.keyboard.type('written just before leaving');
  // Navigate immediately, well inside the autosave delay.
  await page.locator('.tree-row', { hasText: 'Second' }).click();
  await expect(page.locator('.page-title')).toHaveValue('Second');
  const stored = await storedContent(page, first.id);
  expect(texts(stored)).toEqual(['written just before leaving']);
});

test('a network interruption is survived: retry until saved', async ({ page }) => {
  const created = await openNewPage(page, session);
  let failing = true;
  await page.route('**/api/pages/*/content', (route) => (failing ? route.abort() : route.continue()));

  await focusEditor(page);
  await page.keyboard.type('typed while offline');
  const state = page.locator('.save-state');
  await expect(state).toHaveAttribute('data-state', 'offline', { timeout: 10_000 });
  await expect(state).toContainText('Offline');
  // Nothing reached the server, and the text is still on screen.
  expect(texts(await storedContent(page, created.id))).toEqual(['']);
  await expect(editor(page).locator('p').first()).toHaveText('typed while offline');

  failing = false;
  await waitForSaved(page); // automatic retry, no user action
  expect(texts(await storedContent(page, created.id))).toEqual(['typed while offline']);
});

test('the browser warns before closing a tab with unsaved changes', async ({ page }) => {
  await openNewPage(page, session);
  await page.route('**/api/pages/*/content', (route) => route.abort());
  await focusEditor(page);
  await page.keyboard.type('unsaved');
  await expect(page.locator('.save-state')).toHaveAttribute('data-state', /dirty|saving|offline/);
  let asked = false;
  page.once('dialog', async (dialog) => {
    asked = dialog.type() === 'beforeunload';
    await dialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toBe(true);
});

test.describe('Concurrent editing', () => {
  async function secondTab(browser, pageId) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    const tabSession = await signIn(page);
    await page.goto(`/p/${pageId}`);
    await expect(page.locator('.doc')).toBeVisible();
    return { page, context, session: tabSession };
  }

  test('a stale tab gets a conflict instead of overwriting; "keep mine" preserves both', async ({
    page,
    browser,
  }) => {
    const created = await openNewPage(page, session, { content: doc('shared text') });
    const other = await secondTab(browser, created.id);

    // Tab A saves first.
    await clickInto(editor(page).locator('p').first());
    await page.keyboard.press('End');
    await page.keyboard.type(' — from tab A');
    await waitForSaved(page);

    // Tab B (still on the old revision) edits now.
    await clickInto(editor(other.page).locator('p').first());
    await other.page.keyboard.press('End');
    await other.page.keyboard.type(' — from tab B');
    const banner = other.page.locator('.page-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('changed somewhere else');
    await expect(other.page.locator('.save-state')).toHaveAttribute('data-state', 'conflict');
    // The server still has tab A's text; tab B's typing is still on screen.
    expect(texts(await storedContent(page, created.id))).toEqual(['shared text — from tab A']);
    await expect(editor(other.page).locator('p').first()).toHaveText('shared text — from tab B');

    await banner.getByRole('button', { name: 'Keep my version' }).click();
    await waitForSaved(other.page);
    await expect(banner).toHaveCount(0);
    expect(texts(await storedContent(page, created.id))).toEqual(['shared text — from tab B']);

    // Tab A's version was not destroyed: it is in the history.
    const versions = await (await page.request.get(`/api/pages/${created.id}/versions`)).json();
    const snapshots = await Promise.all(
      versions.map(async (version) =>
        texts(
          (await (await page.request.get(`/api/pages/${created.id}/versions/${version.id}`)).json())
            .content,
        ),
      ),
    );
    expect(snapshots).toContainEqual(['shared text — from tab A']);
    expect(snapshots).toContainEqual(['shared text — from tab B']);
    await other.context.close();
  });

  test('"load their version" discards the local edit', async ({ page, browser }) => {
    const created = await openNewPage(page, session, { content: doc('base') });
    const other = await secondTab(browser, created.id);

    await clickInto(editor(page).locator('p').first());
    await page.keyboard.press('End');
    await page.keyboard.type(' A');
    await waitForSaved(page);

    await clickInto(editor(other.page).locator('p').first());
    await other.page.keyboard.press('End');
    await other.page.keyboard.type(' B');
    const banner = other.page.locator('.page-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await banner.getByRole('button', { name: 'Load their version' }).click();
    await expect(editor(other.page).locator('p').first()).toHaveText('base A');
    await expect(other.page.locator('.page-banner')).toHaveCount(0);
    expect(texts(await storedContent(page, created.id))).toEqual(['base A']);
    await other.context.close();
  });

  test('an idle tab follows changes made elsewhere when it regains focus', async ({
    page,
    browser,
  }) => {
    const created = await openNewPage(page, session, { content: doc('before') });
    const other = await secondTab(browser, created.id);
    await clickInto(editor(other.page).locator('p').first());
    await other.page.keyboard.press('End');
    await other.page.keyboard.type(' and after');
    await waitForSaved(other.page);

    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(editor(page).locator('p').first()).toHaveText('before and after');
    // The refreshed tab can keep editing without a conflict.
    await clickInto(editor(page).locator('p').first());
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await waitForSaved(page);
    expect(texts(await storedContent(page, created.id))).toEqual(['before and after!']);
    await other.context.close();
  });
});

test('viewers get a read-only page without editing controls', async ({ page, browser }) => {
  const created = await openNewPage(page, session, { title: 'Handbook', content: doc('read me') });
  const bobContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const bobPage = await bobContext.newPage();
  const bob = await signIn(bobPage, 'bob');
  await api(page, session, 'PUT', `/api/pages/${created.id}/shares/${bob.user.id}`, {
    role: 'viewer',
  });

  await bobPage.goto(`/p/${created.id}`);
  const bobEditor = editor(bobPage);
  await expect(bobEditor).toHaveAttribute('contenteditable', 'false');
  await expect(bobPage.locator('.topbar')).toContainText('View only');
  await expect(bobPage.locator('.page-title')).toHaveAttribute('readonly', '');
  await expect(bobPage.locator('.save-state')).toHaveCount(0);
  await bobEditor.locator('p').first().hover();
  await expect(bobPage.locator('.block-handle')).toHaveCount(0);
  await bobEditor.locator('p').first().click();
  await bobPage.keyboard.type('vandalism');
  await expect(bobEditor.locator('p').first()).toHaveText('read me');
  // The page shows up under "Shared with me".
  await expect(bobPage.locator('.tree-section', { hasText: 'Shared with me' })).toContainText(
    'Handbook',
  );
  await bobContext.close();
});
