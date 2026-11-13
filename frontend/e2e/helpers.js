import { expect } from '@playwright/test';

export const PASSWORD = 'correct horse battery';
export const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Sign in through the API (the session cookie lands in the browser context). */
export async function signIn(page, username = 'alice') {
  const response = await page.request.post('/api/auth/login', {
    data: { identifier: username, password: PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return { user: body.user, csrf: body.csrf_token };
}

export async function api(page, session, method, url, data) {
  const response = await page.request.fetch(url, {
    method,
    data,
    headers: { 'X-CSRF-Token': session.csrf },
  });
  expect(response.ok(), `${method} ${url} → ${response.status()}`).toBeTruthy();
  return response.json();
}

export async function personalWorkspaceId(page) {
  const data = await (await page.request.get('/api/bootstrap')).json();
  return data.workspaces.find((workspace) => workspace.kind === 'personal').id;
}

/** Create a page through the API and open it. Returns the page record. */
export async function openNewPage(page, session, { title = 'Test page', content, parentId } = {}) {
  const created = await api(page, session, 'POST', '/api/pages', {
    title,
    content,
    parent_id: parentId ?? null,
    workspace_id: parentId ? null : await personalWorkspaceId(page),
  });
  await page.goto(`/p/${created.id}`);
  await expect(page.locator('.doc')).toBeVisible();
  return created;
}

export function editor(page) {
  return page.locator('.doc');
}

/**
 * Click into the editor and wait until the editor has picked up the new
 * selection. (The browser reports selection changes asynchronously; a person
 * can never type fast enough to notice, a test script can.)
 */
export async function clickInto(locator) {
  await locator.click();
  await locator.page().waitForTimeout(60);
}

/** Put the caret at the end of the document's last block. */
export async function focusEditor(page) {
  await clickInto(editor(page).locator(':scope > *').last());
}

export async function waitForSaved(page) {
  await expect(page.locator('.save-state')).toHaveAttribute('data-state', 'saved', {
    timeout: 10_000,
  });
}

export async function storedContent(page, pageId) {
  const response = await page.request.get(`/api/pages/${pageId}`);
  return (await response.json()).content;
}

export function paragraph(text) {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

export function doc(...blocks) {
  return { type: 'doc', content: blocks.map((b) => (typeof b === 'string' ? paragraph(b) : b)) };
}

export function blockTexts(page) {
  return editor(page).evaluate((el) =>
    [...el.children].map((child) => child.textContent.trim()).filter(Boolean),
  );
}
