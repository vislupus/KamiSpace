import { expect, test } from '@playwright/test';
import {
  PASSWORD,
  api,
  clickInto,
  doc,
  editor,
  focusEditor,
  mod,
  openNewPage,
  personalWorkspaceId,
  signIn,
  waitForSaved,
} from './helpers.js';

function treeRow(page, title) {
  return page.locator('.sidebar .tree-row', { hasText: title }).first();
}

test.describe('Signing in', () => {
  test('wrong credentials show an error, correct ones open the workspace', async ({ page }) => {
    await page.goto('/p/999999');
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByLabel('Username or email').fill('alice');
    await page.getByLabel('Password').fill('not my password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Incorrect username or password');

    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/p\/999999$/); // back to where the user was going
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.getByText('Page not found')).toBeVisible();
  });

  test('registration is closed unless invited', async ({ page }) => {
    await page.goto('/register');
    await expect(page.getByText('Registration is closed')).toBeVisible();
    await page.goto('/login');
    await expect(page.getByText('Create one')).toHaveCount(0);
  });

  test('an invitation link lets a new person create their account', async ({ page, browser }) => {
    const admin = await signIn(page, 'admin');
    const username = `guest${Date.now()}`;
    const invite = await api(page, admin, 'POST', '/api/admin/invites', {
      email: `${username}@example.com`,
    });

    const context = await browser.newContext();
    const guestPage = await context.newPage();
    await guestPage.goto(invite.path);
    await expect(guestPage.getByLabel('Email')).toHaveValue(`${username}@example.com`);
    await guestPage.getByLabel('Name', { exact: true }).fill('Invited Guest');
    await guestPage.getByLabel('Username').fill(username);
    await guestPage.getByLabel('Password').fill(PASSWORD);
    await guestPage.getByRole('button', { name: 'Create account' }).click();
    await expect(guestPage.locator('.sidebar')).toBeVisible();
    await expect(guestPage.locator('.home-title')).toContainText('Invited');

    // The link works exactly once.
    const second = await browser.newContext();
    const reusePage = await second.newPage();
    await reusePage.goto(invite.path);
    await expect(reusePage.getByText('Invitation expired')).toBeVisible();
    await context.close();
    await second.close();
  });

  test('signing out ends the session', async ({ page }) => {
    await signIn(page);
    await page.goto('/');
    await page.locator('.workspace-button').click();
    await page.locator('.menu-item', { hasText: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('Pages and navigation', () => {
  let session;
  test.beforeEach(async ({ page }) => {
    session = await signIn(page);
  });

  test('create nested pages from the sidebar; breadcrumbs follow', async ({ page }) => {
    await openNewPage(page, session, { title: 'Team handbook' });
    const parent = treeRow(page, 'Team handbook');
    await parent.hover();
    await parent.getByRole('button', { name: 'Add a page inside' }).click();
    await expect(page.locator('.page-title')).toBeFocused();
    await page.keyboard.type('Onboarding');
    await expect(treeRow(page, 'Onboarding')).toBeVisible();
    await expect(treeRow(page, 'Onboarding')).toHaveClass(/is-active/);

    const crumbs = page.locator('.breadcrumbs .crumb');
    await expect(crumbs).toHaveText(['Private', 'Team handbook', 'Onboarding']);
    await crumbs.nth(1).click();
    await expect(page.locator('.page-title')).toHaveValue('Team handbook');

    // Collapse and expand the branch.
    await treeRow(page, 'Team handbook').getByRole('button', { name: 'Collapse' }).click();
    await expect(treeRow(page, 'Onboarding')).toHaveCount(0);
    await treeRow(page, 'Team handbook').getByRole('button', { name: 'Expand' }).click();
    await expect(treeRow(page, 'Onboarding')).toBeVisible();
  });

  test('rename, favorite and duplicate from the page menu', async ({ page }) => {
    await openNewPage(page, session, { title: 'Draft notes', content: doc('body') });
    const row = treeRow(page, 'Draft notes');
    await row.click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Rename' }).click();
    await page.locator('.tree-rename').fill('Final notes');
    await page.keyboard.press('Enter');
    await expect(treeRow(page, 'Final notes')).toBeVisible();
    await expect(page.locator('.page-title')).toHaveValue('Final notes');

    await page.getByRole('button', { name: 'Add to favorites' }).click();
    const favorites = page.locator('.tree-section', { hasText: 'Favorites' });
    await expect(favorites.locator('.tree-row')).toHaveText(['Final notes']);

    await treeRow(page, 'Final notes').click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Duplicate' }).click();
    await expect(page.locator('.page-title')).toHaveValue('Final notes (copy)');
    await expect(editor(page).locator('p').first()).toHaveText('body');
  });

  test('page icon and cover image', async ({ page }) => {
    const created = await openNewPage(page, session, { title: 'Decorated' });
    await page.locator('.page-head').hover();
    await page.getByRole('button', { name: 'Add icon' }).click();
    await page.locator('.emoji-grid button', { hasText: '🚀' }).click();
    await expect(page.locator('.page-icon')).toHaveText('🚀');
    await expect(treeRow(page, 'Decorated').locator('.tree-icon')).toHaveText('🚀');

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
    const cover = page.locator('.page-cover img');
    await expect(cover).toHaveAttribute('src', /^\/api\/files\/[0-9a-f]{32}$/);
    const stored = await (await page.request.get(`/api/pages/${created.id}`)).json();
    expect(stored.icon).toBe('🚀');
    expect(stored.cover_attachment_id).toMatch(/^[0-9a-f]{32}$/);

    await page.locator('.page-cover').hover();
    await page.getByRole('button', { name: 'Remove' }).click();
    await expect(page.locator('.page-cover img')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.page-icon')).toHaveText('🚀');
    await expect(page.locator('.page-cover')).toBeHidden();
  });

  test('delete to the recycle bin, undo, delete again and restore from the bin', async ({ page }) => {
    await openNewPage(page, session, { title: 'Disposable page' });
    await page.getByRole('button', { name: 'Page menu' }).last().click();
    await page.locator('.menu-item', { hasText: 'Delete' }).click();
    await expect(page.locator('.toast')).toContainText('moved to the recycle bin');
    await expect(treeRow(page, 'Disposable page')).toHaveCount(0);
    await page.locator('.toast-action', { hasText: 'Undo' }).click();
    await expect(page.locator('.page-title')).toHaveValue('Disposable page');
    await expect(treeRow(page, 'Disposable page')).toBeVisible();

    await treeRow(page, 'Disposable page').click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Delete' }).click();
    await page.getByRole('link', { name: 'Recycle bin' }).click();
    const item = page.locator('.list-row', { hasText: 'Disposable page' });
    await expect(item).toBeVisible();
    await item.getByRole('button', { name: 'Restore' }).click();
    await expect(item).toHaveCount(0);
    await expect(treeRow(page, 'Disposable page')).toBeVisible();
  });

  test('permanent deletion asks for confirmation', async ({ page }) => {
    const created = await openNewPage(page, session, { title: 'Gone for good' });
    await api(page, session, 'DELETE', `/api/pages/${created.id}`);
    await page.goto('/trash');
    const item = page.locator('.list-row', { hasText: 'Gone for good' });
    await item.getByRole('button', { name: /permanently/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete permanently?' });
    await expect(dialog).toContainText('cannot be undone');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(item).toBeVisible();
    await item.getByRole('button', { name: /permanently/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
    await expect(item).toHaveCount(0);
    expect((await page.request.get(`/api/pages/${created.id}`)).status()).toBe(404);
  });

  test('move a page with the "Move to" dialog and by dragging in the sidebar', async ({ page }) => {
    const workspaceId = await personalWorkspaceId(page);
    const stamp = Date.now();
    const target = await api(page, session, 'POST', '/api/pages', {
      title: `Archive ${stamp}`,
      workspace_id: workspaceId,
    });
    const other = await api(page, session, 'POST', '/api/pages', {
      title: `Projects ${stamp}`,
      workspace_id: workspaceId,
    });
    const moving = await openNewPage(page, session, { title: `Loose page ${stamp}` });

    await treeRow(page, `Loose page ${stamp}`).click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Move to' }).click();
    await page.getByLabel('Destination').fill(`Archive ${stamp}`);
    await page.keyboard.press('Enter');
    await expect(page.locator('.breadcrumbs')).toContainText(`Archive ${stamp}`);
    let tree = (await (await page.request.get('/api/tree')).json()).pages;
    expect(tree.find((p) => p.id === moving.id).parent_id).toBe(target.id);

    // Drag it onto another page.
    await treeRow(page, `Loose page ${stamp}`).dragTo(treeRow(page, `Projects ${stamp}`));
    await expect
      .poll(async () => {
        tree = (await (await page.request.get('/api/tree')).json()).pages;
        return tree.find((p) => p.id === moving.id).parent_id;
      })
      .toBe(other.id);
  });

  test('search palette: results, keyboard navigation, open with Enter', async ({ page }) => {
    const stamp = `zq${Date.now()}`;
    const first = await openNewPage(page, session, {
      title: `Kiwi ${stamp}`,
      content: doc(`The ${stamp} harvest starts in autumn`),
    });
    await openNewPage(page, session, { title: `Mango ${stamp}` });

    await page.keyboard.press(`${mod}+k`);
    const input = page.locator('.palette-input');
    await expect(input).toBeFocused();
    await input.fill(stamp);
    const items = page.locator('.palette-item');
    await expect(items).toHaveCount(3); // two pages + "create page"
    await expect(items.first()).toHaveClass(/is-active/);
    await expect(page.locator('.palette-snippet mark').first()).toHaveText(stamp);

    await input.fill(`harvest ${stamp}`);
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText(`Kiwi ${stamp}`);
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toHaveClass(/is-active/);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/p/${first.id}$`));
    await expect(page.locator('.palette')).toHaveCount(0);

    // Escape closes without navigating.
    await page.keyboard.press(`${mod}+k`);
    await page.keyboard.press('Escape');
    await expect(page.locator('.palette')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/p/${first.id}$`));
  });

  test('quick capture saves a note to the Inbox', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.sidebar')).toBeVisible();
    await page.keyboard.press('Alt+Shift+N');
    const dialog = page.getByRole('dialog', { name: 'Quick capture' });
    await dialog.getByLabel('Quick note').fill('Call the dentist\ntomorrow at nine');
    await page.keyboard.press(`${mod}+Enter`);
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('Saved to your Inbox');
    await page.locator('.toast-action', { hasText: 'Open' }).click();
    await expect(page.locator('.page-title')).toHaveValue('Call the dentist');
    await expect(page.locator('.breadcrumbs')).toContainText('Inbox');
    await expect(editor(page).locator('p')).toHaveText(['Call the dentist', 'tomorrow at nine']);
  });

  test('version history: preview and restore an earlier version', async ({ page }) => {
    const created = await openNewPage(page, session, { title: 'Essay', content: doc('first draft') });
    // A named snapshot, then a change.
    await page.getByRole('button', { name: 'Page menu' }).last().click();
    await page.locator('.menu-item', { hasText: 'Save a version' }).click();
    await page.getByRole('dialog').getByRole('textbox').fill('Before rewrite');
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.toast')).toContainText('Version saved');

    await clickInto(editor(page).locator('p').first());
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.type('rewritten badly');
    await waitForSaved(page);

    await page.getByRole('button', { name: 'Version history' }).click();
    const dialog = page.getByRole('dialog', { name: 'Version history' });
    const entries = dialog.locator('.history-item');
    await expect(entries).toHaveCount(3);
    await expect(entries.first()).toContainText('Current');
    await expect(dialog.locator('.history-preview .doc')).toHaveText('rewritten badly');
    await expect(dialog.getByRole('button', { name: 'Restore this version' })).toBeDisabled();

    await entries.filter({ hasText: 'Before rewrite' }).click();
    await expect(dialog.locator('.history-preview .doc')).toHaveText('first draft');
    await expect(dialog.locator('.history-preview .doc')).toHaveAttribute('contenteditable', 'false');
    await dialog.getByRole('button', { name: 'Restore this version' }).click();
    await page.getByRole('dialog', { name: /Restore version/ }).getByRole('button', { name: 'Restore' }).click();

    await expect(editor(page).locator('p').first()).toHaveText('first draft');
    const versions = await (await page.request.get(`/api/pages/${created.id}/versions`)).json();
    expect(versions).toHaveLength(4); // nothing was removed, a "restore" version was added
    expect(versions[0].kind).toBe('restore');
  });

  test('sharing a page from the share dialog', async ({ page, browser }) => {
    const title = `Shared plan ${Date.now()}`;
    const created = await openNewPage(page, session, { title, content: doc('for bob') });
    await page.getByRole('button', { name: 'Share' }).click();
    const dialog = page.getByRole('dialog', { name: /Share/ });
    await expect(dialog).toContainText('Private page');
    await dialog.getByLabel('Find people').fill('bob');
    await dialog.locator('.share-suggestions .list-row', { hasText: 'Bob Builder' }).click();
    const row = dialog.locator('.share-list .list-row', { hasText: 'Bob Builder' });
    await expect(row.getByLabel('Access level')).toHaveValue('viewer');
    await row.getByLabel('Access level').selectOption('editor');

    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const bobPage = await context.newPage();
    await signIn(bobPage, 'bob');
    await bobPage.goto('/');
    const shared = bobPage.locator('.tree-section', { hasText: 'Shared with me' });
    await shared.locator('.tree-row', { hasText: title }).click();
    await expect(bobPage).toHaveURL(new RegExp(`/p/${created.id}$`));
    await focusEditor(bobPage);
    await bobPage.keyboard.type(' — edited by bob');
    await waitForSaved(bobPage);

    // Revoking takes effect immediately.
    await row.getByLabel('Access level').selectOption('remove');
    await expect(dialog.locator('.share-list .list-row')).toHaveCount(0);
    await bobPage.reload();
    await expect(bobPage.getByText('Page not found')).toBeVisible();
    await context.close();
  });
});

test.describe('Appearance and layout', () => {
  let session;
  test.beforeEach(async ({ page }) => {
    session = await signIn(page);
  });

  test('theme choice persists across reloads', async ({ page }) => {
    await page.goto('/');
    await page.locator('.workspace-button').click();
    await page.locator('.menu-item', { hasText: 'Theme' }).click();
    await page.locator('.menu-item', { hasText: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(dark);

    await page.locator('.workspace-button').click();
    await page.locator('.menu-item', { hasText: 'Theme' }).click();
    await page.locator('.menu-item', { hasText: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(dark);
  });

  test('the sidebar collapses, and the choice is remembered', async ({ page }) => {
    await openNewPage(page, session, { title: 'Wide' });
    const sidebar = page.locator('.sidebar');
    await expect(sidebar).toBeInViewport();
    await page.keyboard.press(`${mod}+\\`);
    await expect(sidebar).not.toBeInViewport();
    await page.reload();
    await expect(page.locator('.doc')).toBeVisible();
    await expect(sidebar).not.toBeInViewport();
    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await expect(sidebar).toBeInViewport();
  });

  test('focus mode hides the chrome and Escape leaves it', async ({ page }) => {
    await openNewPage(page, session, { title: 'Deep work', content: doc('concentrate') });
    await page.mouse.move(700, 400); // hovering the top edge would reveal the bar
    await page.keyboard.press(`${mod}+Shift+F`);
    await expect(page.locator('.sidebar')).not.toBeInViewport();
    await expect(page.locator('.topbar')).toHaveCSS('opacity', '0');
    await expect(editor(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.sidebar')).toBeInViewport();
    await expect(page.locator('.topbar')).toHaveCSS('opacity', '1');
  });

  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
    // 1366×768 at 125 % Windows display scaling
    { width: 1093, height: 614 },
  ]) {
    test(`laptop layout at ${viewport.width}×${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openNewPage(page, session, {
        title: 'Layout check',
        content: doc('A paragraph of text. '.repeat(30), 'Second paragraph'),
      });
      // Nothing overflows the viewport horizontally.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      // The text column is centred in the main area and comfortably narrow.
      const text = await editor(page).locator('p').first().boundingBox();
      const main = await page.locator('.main').boundingBox();
      expect(text.width).toBeGreaterThanOrEqual(Math.min(720, main.width - 120));
      expect(text.width).toBeLessThanOrEqual(800);
      const leftGap = text.x - main.x;
      const rightGap = main.x + main.width - (text.x + text.width);
      expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(2);

      // The title is visible without scrolling and chrome stays compact.
      const title = await page.locator('.page-title').boundingBox();
      expect(title.y).toBeLessThan(viewport.height * 0.32);
      expect((await page.locator('.topbar').boundingBox()).height).toBeLessThanOrEqual(48);
    });
  }

  test('menus and popovers stay inside the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1093, height: 614 });
    const blocks = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
    await openNewPage(page, session, { title: 'Edge cases', content: doc(...blocks) });
    const inside = async (locator) => {
      const box = await locator.boundingBox();
      const size = page.viewportSize();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    };

    // Slash menu at the very bottom of the window.
    await page.locator('.view').evaluate((view) => view.scrollTo(0, view.scrollHeight));
    const last = editor(page).locator('p', { hasText: 'line 40' });
    await last.scrollIntoViewIfNeeded();
    await clickInto(last);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    await expect(page.locator('.slash-menu')).toBeVisible();
    await inside(page.locator('.slash-menu'));
    await page.keyboard.press('Escape');

    // Page menu at the right edge, with its sub-menu in the sidebar.
    await page.getByRole('button', { name: 'Page menu' }).last().click();
    await inside(page.locator('.menu-popover'));
    await page.keyboard.press('Escape');
    await page.locator('.workspace-button').click();
    await page.locator('.menu-item', { hasText: 'Theme' }).hover();
    await expect(page.locator('.menu-popover')).toHaveCount(2);
    await inside(page.locator('.menu-popover').last());
  });

  test('on a phone the sidebar is an overlay and the editor fills the screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openNewPage(page, session, { title: 'Pocket notes', content: doc('small screen') });
    const sidebar = page.locator('.sidebar');
    await expect(sidebar).not.toBeInViewport();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const text = await editor(page).locator('p').first().boundingBox();
    expect(text.width).toBeGreaterThan(330);

    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await expect(sidebar).toBeInViewport();
    await expect(page.locator('.sidebar-backdrop')).toBeVisible();
    // Choosing a page closes the overlay again.
    await treeRow(page, 'Pocket notes').click();
    await expect(sidebar).not.toBeInViewport();
  });
});

test.describe('Administration', () => {
  test('an administrator creates a user and a team workspace', async ({ page, browser }) => {
    await signIn(page, 'admin');
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Users' }).click();
    await settings.getByRole('button', { name: 'Create user' }).click();
    const username = `carol${Date.now()}`;
    const form = page.getByRole('dialog', { name: 'Create user' });
    await form.getByLabel('Name', { exact: true }).fill('Carol Chen');
    await form.getByLabel('Username').fill(username);
    await form.getByLabel('Email').fill(`${username}@example.com`);
    await form.getByLabel('Initial password').fill(PASSWORD);
    await form.getByRole('button', { name: 'Create user' }).click();
    await expect(settings.locator('tr', { hasText: username })).toContainText('Member');

    await settings.getByRole('button', { name: 'Workspaces' }).click();
    await settings.getByRole('button', { name: 'New workspace' }).click();
    const workspace = `Design ${Date.now()}`;
    await page.getByRole('dialog', { name: 'New team workspace' }).getByRole('textbox').fill(workspace);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await settings.getByPlaceholder('Add a member by name…').fill(username);
    await settings.locator('.share-suggestions .menu-item', { hasText: 'Carol Chen' }).click();
    await expect(settings.locator('.list-row', { hasText: `@${username}` })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.tree-heading', { hasText: workspace })).toBeVisible();

    // The new member sees the workspace after signing in.
    const context = await browser.newContext();
    const carolPage = await context.newPage();
    await signIn(carolPage, username);
    await carolPage.goto('/');
    await expect(carolPage.locator('.tree-heading', { hasText: workspace })).toBeVisible();
    await context.close();
  });

  test('non-administrators do not see administration settings', async ({ page }) => {
    await signIn(page, 'alice');
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings.getByRole('button', { name: 'My account' })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Users' })).toHaveCount(0);
    await expect(settings.getByRole('button', { name: 'Backups' })).toHaveCount(0);
  });

  test('backups can be created and downloaded from settings', async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Backups' }).click();
    await settings.getByRole('button', { name: 'Create backup' }).click();
    const row = settings.locator('.list-row', { hasText: 'minddock-backup-' }).first();
    await expect(row).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await row.getByRole('link', { name: 'Download' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^minddock-backup-\d{8}-\d{6}.*\.zip$/);
  });
});
